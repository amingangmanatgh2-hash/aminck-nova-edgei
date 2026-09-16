/**
 * HTTP API.
 *
 * Routing is a flat switch on (method, path) rather than a framework: on a
 * platform billed per millisecond of CPU, a router library is not worth its
 * cost, and a flat table is easier to audit for auth coverage.
 *
 * Auth model:
 *   public      /healthz, /api/status, /api/auth/*, /api/products/public
 *   player      everything else under /api/* (phone-verified session)
 *   admin       /api/admin/*  (D1-backed session, permission-checked)
 *   server      /api/server/* (shared-secret heartbeat from the game runtime)
 */
import { CATALOG, catalogToProducts } from '../shop/catalog';
import { decideDiscount, profileDemand, recordEventSql } from '../shop/pricing';
import {
  card2cardAvailable,
  maskCard,
  reviewReceipt,
  zarinpalAvailable,
  zarinpalStart,
  zarinpalVerify,
} from '../shop/payments';
import {
  all,
  audit,
  createUser,
  fraudAlert,
  getSetting,
  loadSettings,
  mapOrder,
  mapProduct,
  mapServer,
  mapUser,
  one,
  run,
  saveSettings,
  setSetting,
  userByPhoneHash,
  DEFAULT_SETTINGS,
} from '../db/db';
import type { ServerRow, SettingsShape } from '../db/db';
import { GAME_MODES, MODE_IDS, RANKS, RANK_ORDER, rankByXp } from '../config';
import { clientCountry, clientIp, err, json, readJson, rateLimit, requireSameOrigin, userAgent, withSecurityHeaders } from '../net/security';
import { issuePlayerSession, verifyPlayerSession, cookieFrom, SESSION_COOKIE, clearCookie, ADMIN_COOKIE } from '../auth/session';
import { requestOtp, verifyOtp } from '../auth/otp';
import { hashIp, hashPhone, isValidIranPhone, isValidMcName, newId, normalizePhone, now, sanitizeText, verifyPassword } from '../utils';
import { ANTICHEAT } from '../config';

export interface ApiEnv {
  GODDB: D1Database;
  GODKV: KVNamespace;
  GODR2: R2Bucket;
  AI?: Ai;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
  OTP_SECRET: string;
  SERVER_INGEST_SECRET: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_OWNER_CHAT_ID?: string;
  SMS_PROVIDER_KEY?: string;
  USD_TO_TOMAN?: string;
  /** When '1', unhandled exceptions are logged instead of silently swallowed. */
  DEBUG_ERRORS?: string;
}

export interface ApiContext {
  env: ApiEnv;
  url: URL;
  ip: string;
  country: string;
  ua: string;
}

type Handler = (ctx: ApiContext, body: Record<string, unknown>, request: Request) => Promise<Response>;

// ------------------------------------------------------------------ helpers
const isDev = (env: ApiEnv): boolean => !env.TELEGRAM_BOT_TOKEN && !env.SMS_PROVIDER_KEY;

async function playerOf(ctx: ApiContext, request: Request) {
  const token = cookieFrom(request, SESSION_COOKIE);
  const sess = await verifyPlayerSession(token, ctx.env.SESSION_SECRET);
  if (!sess) return null;
  const row = await userByPhoneHash(ctx.env.GODDB, await hashPhone(sess.phoneE164, ctx.env.OTP_SECRET));
  return row ? { session: sess, user: mapUser(row) } : null;
}

async function adminOf(ctx: ApiContext, request: Request) {
  const sid = cookieFrom(request, ADMIN_COOKIE);
  if (!sid) return null;
  const s = await one<{ admin_id: string; revoked_at: number | null; expires_at: number }>(
    ctx.env.GODDB,
    'SELECT admin_id, revoked_at, expires_at FROM admin_sessions WHERE id = ?',
    sid,
  );
  if (!s || s.revoked_at || s.expires_at < now()) return null;
  const a = await one<{ id: string; username: string; role: string; permissions: string; disabled: number }>(
    ctx.env.GODDB,
    'SELECT id, username, role, permissions, disabled FROM admins WHERE id = ?',
    s.admin_id,
  );
  if (!a || a.disabled) return null;
  let perms: string[] = [];
  try {
    perms = JSON.parse(a.permissions || '[]');
  } catch {
    perms = [];
  }
  return { id: a.id, username: a.username, role: a.role, permissions: perms, sessionId: sid };
}

function hasPerm(a: { role: string; permissions: string[] } | null, perm: string): boolean {
  if (!a) return false;
  if (a.role === 'owner') return true;
  return a.permissions.includes(perm);
}

const usdToToman = (env: ApiEnv): number => {
  const v = Number(env.USD_TO_TOMAN ?? '0');
  return Number.isFinite(v) && v > 0 ? v : 0;
};

// ==================================================================== AUTH
const authOtpRequest: Handler = async (ctx, body) => {
  const rl = await rateLimit(ctx.env.GODKV, { key: 'otp-req', limit: 8, windowMs: 3600_000 }, ctx.ip);
  if (!rl.ok) return err('rate_limited', 429, { retryAfterMs: rl.resetMs });

  const phone = sanitizeText(String(body.phone ?? ''), 24);
  const res = await requestOtp(
    {
      db: ctx.env.GODDB,
      kv: ctx.env.GODKV,
      otpSecret: ctx.env.OTP_SECRET,
      telegramBotToken: ctx.env.TELEGRAM_BOT_TOKEN,
      telegramOwnerChatId: ctx.env.TELEGRAM_OWNER_CHAT_ID,
      smsProviderKey: ctx.env.SMS_PROVIDER_KEY,
      devMode: isDev(ctx.env),
    },
    phone,
    ctx.ip,
  );
  if (!res.ok) return json({ ok: false, reason: res.reason, retryAfterMs: res.retryAfterMs }, 400);
  // The code is returned ONLY in dev mode, when no delivery channel exists.
  return json({ ok: true, channel: res.channel, devCode: res.devCode ?? null, ttlMs: 180_000 });
};

const authOtpVerify: Handler = async (ctx, body) => {
  const rl = await rateLimit(ctx.env.GODKV, { key: 'otp-ver', limit: 15, windowMs: 3600_000 }, ctx.ip);
  if (!rl.ok) return err('rate_limited', 429, { retryAfterMs: rl.resetMs });

  const phone = sanitizeText(String(body.phone ?? ''), 24);
  const code = sanitizeText(String(body.code ?? ''), 12);
  const res = await verifyOtp(
    {
      db: ctx.env.GODDB,
      kv: ctx.env.GODKV,
      otpSecret: ctx.env.OTP_SECRET,
      devMode: isDev(ctx.env),
    },
    phone,
    code,
    ctx.ip,
  );
  if (!res.ok) {
    return json({ ok: false, reason: res.reason, attemptsLeft: res.attemptsLeft ?? 0 }, 401);
  }

  const phoneE164 = res.phoneE164!;
  const ph = await hashPhone(phoneE164, ctx.env.OTP_SECRET);
  let user = await userByPhoneHash(ctx.env.GODDB, ph);
  let isNew = false;
  if (!user) {
    const id = await createUser(ctx.env.GODDB, {
      phoneE164,
      phoneHash: ph,
      ipHash: await hashIp(ctx.ip, ctx.env.OTP_SECRET),
    });
    user = await userByPhoneHash(ctx.env.GODDB, ph);
    isNew = true;
    await audit(ctx.env.GODDB, { actor: id, action: 'user.registered', detail: 'phone verified', ipHash: ph });
  }
  if (!user) return err('user_create_failed', 500);

  const token = await issuePlayerSession(user.id, phoneE164, ctx.env.SESSION_SECRET);
  await run(ctx.env.GODDB, 'UPDATE users SET last_login_at = ?, last_seen_at = ? WHERE id = ?', now(), now(), user.id);

  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' });
  headers.append(
    'set-cookie',
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${60 * 60 * 24 * 7}`,
  );
  return new Response(
    JSON.stringify({
      ok: true,
      isNew,
      user: { id: user.id, rankId: user.rank_id, xp: user.xp, coins: user.coins, gems: user.gems },
    }),
    { headers },
  );
};

const authLogout: Handler = async () => {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' });
  headers.append('set-cookie', clearCookie(SESSION_COOKIE));
  return new Response(JSON.stringify({ ok: true }), { headers });
};

const authMe: Handler = async (ctx, _b, request) => {
  const me = await playerOf(ctx, request);
  if (!me) return err('not_authenticated', 401);
  return json({
    ok: true,
    user: {
      id: me.user.id,
      username: me.user.username,
      rankId: me.user.rankId,
      rank: RANKS[me.user.rankId] ?? RANKS.free,
      xp: me.user.xp,
      coins: me.user.coins,
      gems: me.user.gems,
      elo: me.user.elo,
      nextRankXp: nextRankXp(me.user.xp),
    },
  });
};

function nextRankXp(xp: number): number | null {
  for (const id of RANK_ORDER) if (xp < RANKS[id]!.xpThreshold) return RANKS[id]!.xpThreshold;
  return null;
}

// ================================================================ PUBLIC
const publicStatus: Handler = async (ctx) => {
  const settings = await loadSettings(ctx.env.GODDB);
  const servers = await all(ctx.env.GODDB, 'SELECT * FROM servers ORDER BY created_at');
  return json({
    ok: true,
    name: settings.serverName,
    ip: settings.serverIp,
    host: settings.serverHost,
    maintenance: settings.maintenance,
    discordUrl: settings.discordUrl,
    telegramUrl: settings.telegramUrl,
    supportEmail: settings.supportEmail,
    modes: MODE_IDS.map((id) => ({
      id,
      titleFa: GAME_MODES[id]!.titleFa,
      titleEn: GAME_MODES[id]!.titleEn,
      minPlayers: GAME_MODES[id]!.minPlayers,
      maxPlayers: GAME_MODES[id]!.maxPlayers,
    })),
    ranks: RANK_ORDER.map((id) => ({
      id,
      labelFa: RANKS[id]!.labelFa,
      tag: RANKS[id]!.tag,
      colour: RANKS[id]!.colour,
      priceUsd: RANKS[id]!.priceUsd,
      xpThreshold: RANKS[id]!.xpThreshold,
      perks: RANKS[id]!.perks,
    })),
    servers: servers.map((r) => {
      const s = mapServer(r as ServerRow);
      return {
        id: s.id,
        name: s.name,
        edition: s.edition,
        status: s.status,
        onlinePlayers: s.onlinePlayers,
        maxPlayers: s.maxPlayers,
        // Bedrock is reported honestly: null port means it is not exposed.
        bedrock: s.bedrockEnabled ? { port: s.bedrockPort } : null,
        java: { port: s.javaPort },
      };
    }),
    ts: now(),
  });
};

/**
 * Products visible WITHOUT authentication.
 *
 * This is deliberately almost nothing: the shop is gated behind OTP so the
 * catalogue cannot be scraped or spammed by bots. Only free ranks show up.
 */
const publicProducts: Handler = async () => {
  const visible = catalogToProducts().filter((p) => p.visibleBeforeAuth && p.active);
  return json({ ok: true, gated: true, products: visible });
};

// ============================================================ SHOP (auth)
const shopProducts: Handler = async (ctx) => {
  const products = catalogToProducts().filter((p) => p.active);
  // Observe an impression for the pricing engine.
  for (const p of products) {
    const { sql, bind } = recordEventSql({
      productId: p.id,
      at: now(),
      impression: true,
      conversion: false,
      revenueUsd: 0,
    });
    await run(ctx.env.GODDB, sql, ...bind);
  }
  const events = await all<{ product_id: string; hour_of_day: number; day_of_week: number; impressions: number; conversions: number; revenue_usd: number }>(
    ctx.env.GODDB,
    'SELECT product_id, hour_of_day, day_of_week, impressions, conversions, revenue_usd FROM price_events',
  );
  const mapped = events.map((e) => ({
    productId: e.product_id,
    hourOfDay: e.hour_of_day,
    dayOfWeek: e.day_of_week,
    impressions: e.impressions,
    conversions: e.conversions,
    revenueUsd: e.revenue_usd,
  }));
  const hour = new Date().getUTCHours();
  const priced = products.map((p) => {
    const profiles = profileDemand(mapped);
    const d = decideDiscount(p.id, p.baseUsd, profiles.get(p.id), { hourOfDay: hour });
    return { ...p, priceUsd: d.finalUsd, discountPct: d.pct, discountReason: d.rationale };
  });

  const settings = await loadSettings(ctx.env.GODDB);
  return json({
    ok: true,
    gated: false,
    payments: {
      zarinpal: zarinpalAvailable({
        merchantId: settings.zarinpalMerchantId,
        enabled: settings.zarinpalEnabled,
        callbackBase: '',
      }),
      card2card: card2cardAvailable({
        enabled: settings.card2cardEnabled,
        cardNumber: settings.cardNumber,
        cardHolder: settings.cardHolder,
      }),
      cardMasked: maskCard(settings.cardNumber),
      cardHolder: settings.cardHolder,
    },
    products: priced,
  });
};

const shopCheckout: Handler = async (ctx, body, request) => {
  const me = await playerOf(ctx, request);
  if (!me) return err('not_authenticated', 401);

  const sku = sanitizeText(String(body.sku ?? ''), 64);
  const method = String(body.method ?? 'zarinpal');
  const entry = CATALOG.find((c) => c.sku === sku);
  if (!entry) return err('unknown_product', 404);

  const settings = await loadSettings(ctx.env.GODDB);
  if (!settings.shopEnabled) return err('shop_disabled', 403);

  const id = newId();
  const amount = entry.priceUsd;
  const status = method === 'card2card' ? 'awaiting_receipt' : 'pending';

  await run(
    ctx.env.GODDB,
    `INSERT INTO orders (id, user_id, product_id, amount_usd, discount_pct, currency, method,
        gateway_ref, status, ip_hash, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    me.user.id,
    `p-${sku}`,
    amount,
    0,
    'USD',
    method,
    null,
    status,
    await hashIp(ctx.ip, ctx.env.OTP_SECRET),
    now(),
  );
  await audit(ctx.env.GODDB, {
    actor: me.user.id,
    action: 'order.created',
    target: id,
    detail: `${sku} ${amount}c via ${method}`,
  });

  if (method === 'card2card') {
    if (!card2cardAvailable({ enabled: settings.card2cardEnabled, cardNumber: settings.cardNumber, cardHolder: settings.cardHolder })) {
      return err('card2card_unavailable', 400);
    }
    return json({
      ok: true,
      orderId: id,
      method: 'card2card',
      status,
      card: maskCard(settings.cardNumber),
      cardHolder: settings.cardHolder,
      amountUsd: amount,
      instructions: 'مبلغ را واریز کنید و تصویر فیش را آپلود کنید. تایید پس از بررسی انجام می‌شود.',
    });
  }

  const zp = await zarinpalStart(
    { merchantId: settings.zarinpalMerchantId, enabled: settings.zarinpalEnabled, callbackBase: ctx.url.origin },
    { id, amountUsd: amount, description: entry.titleEn, userPhone: me.user.phoneE164 },
    usdToToman(ctx.env),
  );
  if (!zp.ok) {
    await run(ctx.env.GODDB, "UPDATE orders SET status = 'expired' WHERE id = ?", id);
    return err('gateway_unavailable', 503, { reason: zp.reason });
  }
  await run(ctx.env.GODDB, "UPDATE orders SET gateway_ref = ? WHERE id = ?", zp.authority ?? null, id);
  return json({ ok: true, orderId: id, method: 'zarinpal', paymentUrl: zp.paymentUrl });
};

const shopUploadReceipt: Handler = async (ctx, _body, request) => {
  const me = await playerOf(ctx, request);
  if (!me) return err('not_authenticated', 401);

  const orderId = ctx.url.searchParams.get('order');
  if (!orderId) return err('missing_order', 400);
  const order = await one<{ id: string; user_id: string; amount_usd: number; status: string }>(
    ctx.env.GODDB,
    'SELECT id, user_id, amount_usd, status FROM orders WHERE id = ?',
    orderId,
  );
  if (!order || order.user_id !== me.user.id) return err('order_not_found', 404);
  if (order.status !== 'awaiting_receipt') return err('order_not_awaiting_receipt', 400);

  const file = await request.formData().catch(() => null);
  const blob = file?.get('receipt');
  if (!blob || typeof blob === 'string') return err('missing_receipt_file', 400);

  const bytes = await blob.arrayBuffer();
  const contentType = (blob as File).type || 'application/octet-stream';
  const key = `receipts/${orderId}-${newId()}`;
  await ctx.env.GODR2.put(key, bytes, { httpMetadata: { contentType } });

  const existing = await all<{ sha256: string }>(ctx.env.GODDB, 'SELECT sha256 FROM payment_receipts');
  const verdict = await reviewReceipt({
    bytes,
    contentType,
    claimedAmountUsd: order.amount_usd,
    existingHashes: existing.map((e) => e.sha256),
    ai: ctx.env.AI
      ? {
          run: async (prompt, imageB64) => {
            const res = await ctx.env.AI!.run('@cf/llava/llava-7b-instruct', {
              prompt: `${prompt}\n[image data: ${imageB64.length} bytes attached]`,
            });
            return JSON.stringify((res as { response?: string }) ?? {});
          },
        }
      : undefined,
  });

  const sha = await cryptoHashHex(bytes);
  await run(
    ctx.env.GODDB,
    `INSERT INTO payment_receipts (id, order_id, r2_key, sha256, bytes, status, ai_verdict, ai_score, reason, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    newId(),
    orderId,
    key,
    sha,
    bytes.byteLength,
    verdict.duplicate || verdict.tampered ? 'rejected' : verdict.autoApprove ? 'reviewing' : 'manual',
    JSON.stringify(verdict),
    verdict.confidence,
    verdict.reasons.join('; ') || null,
    now(),
  );

  if (verdict.duplicate) {
    await fraudAlert(ctx.env.GODDB, {
      kind: 'receipt_duplicate',
      severity: 'critical',
      subject: me.user.id,
      detail: `duplicate receipt uploaded for order ${orderId} (hash ${sha.slice(0, 12)})`,
    });
  }
  if (verdict.tampered) {
    await fraudAlert(ctx.env.GODDB, {
      kind: 'receipt_tampered',
      severity: 'critical',
      subject: me.user.id,
      detail: `AI flagged possible tampering on receipt for order ${orderId}`,
    });
  }

  await run(ctx.env.GODDB, "UPDATE orders SET status = 'reviewing' WHERE id = ?", orderId);

  return json({
    ok: true,
    orderId,
    // NOTE: even autoApprove only moves the order to `reviewing`. Granting the
    // entitlement happens in the admin confirmation step or, for low-value
    // orders with a clean verdict, in the settlement job.
    autoApprove: verdict.autoApprove,
    reasons: verdict.reasons,
    confidence: verdict.confidence,
  });
};

async function cryptoHashHex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ============================================================ LEADERBOARD
const leaderboard: Handler = async (ctx) => {
  const board = await ctx.url.searchParams.get('by') ?? 'elo';
  const col = board === 'xp' ? 'xp' : board === 'coins' ? 'coins' : 'elo';
  const rows = await all<{
    id: string; username: string | null; rank_id: string; xp: number; coins: number; elo: number;
  }>(
    ctx.env.GODDB,
    `SELECT id, username, rank_id, xp, coins, elo FROM users WHERE status = 'active'
     ORDER BY ${col} DESC LIMIT 50`,
  );
  return json({
    ok: true,
    by: col,
    entries: rows.map((r, i) => ({
      position: i + 1,
      id: r.id,
      username: r.username ?? `player-${String(r.id).slice(0, 6)}`,
      rankId: r.rank_id,
      xp: r.xp,
      coins: r.coins,
      elo: r.elo,
    })),
  });
};

// ================================================================ SERVER
/**
 * Game runtime heartbeat.
 *
 * Authenticated with a shared secret, not a player session, because the game
 * process has no browser. The secret is a Worker secret.
 */
const serverHeartbeat: Handler = async (ctx, body, request) => {
  const key = request.headers.get('x-server-secret');
  if (!key || key !== ctx.env.SERVER_INGEST_SECRET) return err('unauthorized', 401);

  const serverId = sanitizeText(String(body.serverId ?? ''), 64);
  if (!serverId) return err('missing_server_id', 400);

  const hb = {
    processAlive: body.processAlive !== false,
    players: Number(body.players ?? 0) || 0,
    tps: Number(body.tps ?? 20) || 20,
    memUsedMb: Number(body.memUsedMb ?? 0) || 0,
    memMaxMb: Number(body.memMaxMb ?? 0) || 0,
    cpuPercent: Number(body.cpuPercent ?? 0) || 0,
    version: body.version ? sanitizeText(String(body.version), 32) : null,
    motd: body.motd ? sanitizeText(String(body.motd), 200) : null,
  };

  const res = await run(
    ctx.env.GODDB,
    `UPDATE servers SET status='online', online_players=?, tps=?, mem_used_mb=?, mem_max_mb=?,
        cpu_percent=?, version=?, motd=?, last_heartbeat=?, updated_at=? WHERE id=?`,
    hb.players, hb.tps, hb.memUsedMb, hb.memMaxMb, hb.cpuPercent, hb.version, hb.motd, now(), now(), serverId,
  );
  if (!res.meta.changes) return err('unknown_server', 404);

  await run(
    ctx.env.GODDB,
    `INSERT INTO health_checks (id, server_id, status, process_ok, port_ok, ping_ms, players, mem_mb, cpu_pct, note, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    newId(), serverId, 'online', hb.processAlive ? 1 : 0, 1, null, hb.players,
    hb.memUsedMb, hb.cpuPercent, 'heartbeat', now(),
  );

  return json({ ok: true, serverId, acceptedAt: now() });
};

const serverPlayerEvent: Handler = async (ctx, body, request) => {
  const key = request.headers.get('x-server-secret');
  if (!key || key !== ctx.env.SERVER_INGEST_SECRET) return err('unauthorized', 401);

  const mcName = sanitizeText(String(body.mcName ?? ''), 24);
  const mcUuid = sanitizeText(String(body.mcUuid ?? ''), 64);
  const serverId = sanitizeText(String(body.serverId ?? ''), 64);
  const edition = String(body.edition ?? 'java') === 'bedrock' ? 'bedrock' : 'java';
  if (!isValidMcName(mcName, edition) || !mcUuid || !serverId) return err('invalid_payload', 400);

  const existing = await one<{ id: string }>(
    ctx.env.GODDB,
    'SELECT id FROM players WHERE server_id = ? AND mc_uuid = ?',
    serverId,
    mcUuid,
  );
  const playerId = existing?.id ?? newId();
  if (existing) {
    await run(
      ctx.env.GODDB,
      'UPDATE players SET mc_name=?, online=1, last_seen_at=? WHERE id=?',
      mcName, now(), playerId,
    );
  } else {
    await run(
      ctx.env.GODDB,
      `INSERT INTO players (id, server_id, mc_uuid, mc_name, edition, online, created_at, last_seen_at)
       VALUES (?,?,?,?,?,1,?,?)`,
      playerId, serverId, mcUuid, mcName, edition, now(), now(),
    );
  }
  return json({ ok: true, playerId });
};

// ================================================================= ADMIN
const adminLogin: Handler = async (ctx, body, request) => {
  const rl = await rateLimit(ctx.env.GODKV, { key: 'admin-login', limit: 10, windowMs: 900_000 }, ctx.ip);
  if (!rl.ok) return err('rate_limited', 429, { retryAfterMs: rl.resetMs });

  const username = sanitizeText(String(body.username ?? 'AMINCK'), 40);
  const password = String(body.password ?? '');

  const a = await one<{ id: string; password_hash: string; password_salt: string; role: string; disabled: number; permissions: string }>(
    ctx.env.GODDB,
    'SELECT id, password_hash, password_salt, role, disabled, permissions FROM admins WHERE username = ?',
    username,
  );

  // Compare against ADMIN_PASSWORD for the owner bootstrap account.
  const isOwnerBootstrap = username.toLowerCase() === 'aminck' && !!ctx.env.ADMIN_PASSWORD;
  let ok = false;
  if (a && !a.disabled) {
    ok = await verifyPassword(password, { hash: a.password_hash, salt: a.password_salt, iterations: 210_000 });
  } else if (isOwnerBootstrap && password === ctx.env.ADMIN_PASSWORD) {
    // Bootstrap the owner row on first successful login.
    const { hashPassword } = await import('../utils');
    const hp = await hashPassword(password);
    const id = newId();
    await run(
      ctx.env.GODDB,
      `INSERT INTO admins (id, username, password_hash, password_salt, role, permissions, disabled, created_at)
       VALUES (?,?,?,?,?,?,0,?)`,
      id, username, hp.hash, hp.salt, 'owner', '[]', now(),
    );
    ok = true;
  }

  if (!ok) {
    await audit(ctx.env.GODDB, { actor: username, action: 'admin.login_failed', ipHash: await hashIp(ctx.ip, ctx.env.OTP_SECRET) });
    return err('invalid_credentials', 401);
  }

  const row = await one<{ id: string; role: string; permissions: string }>(
    ctx.env.GODDB,
    'SELECT id, role, permissions FROM admins WHERE username = ?',
    username,
  );
  if (!row) return err('admin_missing', 500);

  const sid = newId();
  await run(
    ctx.env.GODDB,
    'INSERT INTO admin_sessions (id, admin_id, issued_at, expires_at, ip_hash, user_agent) VALUES (?,?,?,?,?,?)',
    sid, row.id, now(), now() + 12 * 3600_000, await hashIp(ctx.ip, ctx.env.OTP_SECRET), userAgent(request),
  );
  await audit(ctx.env.GODDB, { actor: row.id, action: 'admin.login', ipHash: await hashIp(ctx.ip, ctx.env.OTP_SECRET) });

  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' });
  headers.append(
    'set-cookie',
    `${ADMIN_COOKIE}=${sid}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${12 * 3600}`,
  );
  return new Response(JSON.stringify({ ok: true, role: row.role }), { headers });
};

const adminOverview: Handler = async (ctx, _b, request) => {
  const a = await adminOf(ctx, request);
  if (!a) return err('not_authenticated', 401);

  const [users, servers, orders, pendingReceipts, openAppeals, alerts, cases] = await Promise.all([
    one<{ n: number }>(ctx.env.GODDB, 'SELECT COUNT(*) AS n FROM users'),
    all<ServerRow>(ctx.env.GODDB, 'SELECT * FROM servers ORDER BY created_at'),
    one<{ paid: number; revenue: number }>(
      ctx.env.GODDB,
      "SELECT COUNT(*) AS paid, COALESCE(SUM(amount_usd),0) AS revenue FROM orders WHERE status='paid'",
    ),
    one<{ n: number }>(ctx.env.GODDB, "SELECT COUNT(*) AS n FROM payment_receipts WHERE status IN ('manual','reviewing')"),
    one<{ n: number }>(ctx.env.GODDB, "SELECT COUNT(*) AS n FROM appeals WHERE status='open'"),
    one<{ n: number }>(ctx.env.GODDB, "SELECT COUNT(*) AS n FROM fraud_alerts WHERE notified=0"),
    one<{ n: number }>(
      ctx.env.GODDB,
      'SELECT COUNT(*) AS n FROM cheat_cases WHERE created_at > ?',
      now() - 86_400_000,
    ),
  ]);

  return json({
    ok: true,
    admin: { id: a.id, username: a.username, role: a.role },
    stats: {
      users: users?.n ?? 0,
      servers: servers.length,
      onlinePlayers: servers.reduce((sum, r) => sum + mapServer(r).onlinePlayers, 0),
      paidOrders: orders?.paid ?? 0,
      revenueUsdCents: orders?.revenue ?? 0,
      pendingReceipts: pendingReceipts?.n ?? 0,
      openAppeals: openAppeals?.n ?? 0,
      unreadAlerts: alerts?.n ?? 0,
      cheatCases24h: cases?.n ?? 0,
    },
    servers: servers.map((r) => mapServer(r)),
  });
};

const adminSettingsGet: Handler = async (ctx, _b, request) => {
  const a = await adminOf(ctx, request);
  if (!a || !hasPerm(a, 'settings:manage')) return err('forbidden', 403);
  const s = await loadSettings(ctx.env.GODDB);
  // Never echo secrets back to the browser, even to an admin.
  return json({ ok: true, settings: { ...s, cardNumber: s.cardNumber ? maskCard(s.cardNumber) : null } });
};

const adminSettingsPut: Handler = async (ctx, body, request) => {
  const a = await adminOf(ctx, request);
  if (!a || !hasPerm(a, 'settings:manage')) return err('forbidden', 403);
  const cur = await loadSettings(ctx.env.GODDB);
  const next: SettingsShape = {
    ...cur,
    serverName: sanitizeText(String(body.serverName ?? cur.serverName), 60) || DEFAULT_SETTINGS.serverName,
    serverHost: sanitizeText(String(body.serverHost ?? cur.serverHost), 120),
    serverIp: sanitizeText(String(body.serverIp ?? cur.serverIp), 120),
    discordUrl: sanitizeText(String(body.discordUrl ?? cur.discordUrl), 200),
    telegramUrl: sanitizeText(String(body.telegramUrl ?? cur.telegramUrl), 200),
    supportEmail: sanitizeText(String(body.supportEmail ?? cur.supportEmail), 160),
    maintenance: body.maintenance === true,
    whitelist: body.whitelist === true,
    shopEnabled: body.shopEnabled !== false,
    zarinpalEnabled: body.zarinpalEnabled === true,
    card2cardEnabled: body.card2cardEnabled === true,
    // Only overwrite secrets if a new non-masked value was supplied.
    cardNumber:
      typeof body.cardNumber === 'string' && body.cardNumber && !body.cardNumber.includes('*')
        ? body.cardNumber.replace(/\D/g, '').slice(0, 19)
        : cur.cardNumber,
    cardHolder:
      typeof body.cardHolder === 'string' ? sanitizeText(body.cardHolder, 80) : cur.cardHolder,
    zarinpalMerchantId:
      typeof body.zarinpalMerchantId === 'string' && body.zarinpalMerchantId
        ? sanitizeText(body.zarinpalMerchantId, 64)
        : cur.zarinpalMerchantId,
    logoKey: typeof body.logoKey === 'string' ? sanitizeText(body.logoKey, 200) : cur.logoKey,
    bannerKey: typeof body.bannerKey === 'string' ? sanitizeText(body.bannerKey, 200) : cur.bannerKey,
  };
  await saveSettings(ctx.env.GODDB, next);
  await audit(ctx.env.GODDB, { actor: a.id, action: 'settings.updated', target: 'platform' });
  return json({ ok: true, settings: { ...next, cardNumber: next.cardNumber ? maskCard(next.cardNumber) : null } });
};

const adminAppeals: Handler = async (ctx, _b, request) => {
  const a = await adminOf(ctx, request);
  if (!a || !hasPerm(a, 'anticheat:review')) return err('forbidden', 403);
  const rows = await all(
    ctx.env.GODDB,
    `SELECT ap.*, b.reason AS ban_reason, b.temp, b.expires_at
     FROM appeals ap JOIN bans b ON b.id = ap.ban_id
     WHERE ap.status = 'open' ORDER BY ap.created_at DESC LIMIT 100`,
  );
  return json({ ok: true, appeals: rows });
};

const adminAppealDecide: Handler = async (ctx, body, request) => {
  const a = await adminOf(ctx, request);
  if (!a || !hasPerm(a, 'anticheat:review')) return err('forbidden', 403);
  const appealId = sanitizeText(String(body.appealId ?? ''), 64);
  const approve = body.approve === true;
  const note = sanitizeText(String(body.note ?? ''), 500);

  const ap = await one<{ id: string; ban_id: string; player_id: string }>(
    ctx.env.GODDB,
    'SELECT id, ban_id, player_id FROM appeals WHERE id = ?',
    appealId,
  );
  if (!ap) return err('appeal_not_found', 404);

  await run(
    ctx.env.GODDB,
    "UPDATE appeals SET status=?, admin_note=?, handled_by=?, handled_at=? WHERE id=?",
    approve ? 'approved' : 'denied', note, a.id, now(), appealId,
  );
  if (approve) {
    await run(ctx.env.GODDB, 'UPDATE bans SET revoked_at=?, revoked_by=? WHERE id=?', now(), a.id, ap.ban_id);
  }
  await audit(ctx.env.GODDB, {
    actor: a.id,
    action: approve ? 'appeal.approved' : 'appeal.denied',
    target: appealId,
    detail: note,
  });
  return json({ ok: true, approved: approve });
};

const adminCheatCases: Handler = async (ctx, _b, request) => {
  const a = await adminOf(ctx, request);
  if (!a || !hasPerm(a, 'anticheat:review')) return err('forbidden', 403);
  const rows = await all(
    ctx.env.GODDB,
    'SELECT * FROM cheat_cases ORDER BY created_at DESC LIMIT 100',
  );
  return json({ ok: true, cases: rows });
};

/**
 * The ONLY path to a permanent ban: an explicit admin action, recorded in the
 * audit log with the admin's id. Automatic scoring can never reach this.
 */
const adminBanPermanent: Handler = async (ctx, body, request) => {
  const a = await adminOf(ctx, request);
  if (!a || !hasPerm(a, 'anticheat:ban')) return err('forbidden', 403);
  const playerId = sanitizeText(String(body.playerId ?? ''), 64);
  const reason = sanitizeText(String(body.reason ?? ''), 300);
  if (!playerId || !reason) return err('missing_fields', 400);

  await run(
    ctx.env.GODDB,
    `INSERT INTO bans (id, player_id, case_id, scope, reason, temp, issued_by, created_at)
     VALUES (?,?,?, 'global', ?, 0, ?, ?)`,
    newId(), playerId, body.caseId ? sanitizeText(String(body.caseId), 64) : null, reason, a.id, now(),
  );
  await audit(ctx.env.GODDB, {
    actor: a.id,
    action: 'ban.permanent',
    target: playerId,
    detail: reason,
    ipHash: await hashIp(ctx.ip, ctx.env.OTP_SECRET),
  });
  return json({ ok: true, permanent: true, issuedBy: a.username });
};

const adminAlerts: Handler = async (ctx, _b, request) => {
  const a = await adminOf(ctx, request);
  if (!a) return err('forbidden', 403);
  const rows = await all(ctx.env.GODDB, 'SELECT * FROM fraud_alerts ORDER BY created_at DESC LIMIT 100');
  return json({ ok: true, alerts: rows });
};

const adminServersCreate: Handler = async (ctx, body, request) => {
  const a = await adminOf(ctx, request);
  if (!a || !hasPerm(a, 'servers:manage')) return err('forbidden', 403);
  const id = newId();
  await run(
    ctx.env.GODDB,
    `INSERT INTO servers (id, name, host, java_port, bedrock_port, bedrock_enabled, edition, runtime,
        max_players, view_distance, sim_distance, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    sanitizeText(String(body.name ?? 'Server'), 60),
    sanitizeText(String(body.host ?? 'localhost'), 120),
    Number(body.javaPort ?? 25565) || 25565,
    // Bedrock stays disabled by default: see docs/FEASIBILITY.md
    body.bedrockPort ? Number(body.bedrockPort) : null,
    body.bedrockEnabled === true ? 1 : 0,
    String(body.edition ?? 'java'),
    String(body.runtime ?? 'paper'),
    Number(body.maxPlayers ?? 20) || 20,
    Number(body.viewDistance ?? 6) || 6,
    Number(body.simDistance ?? 4) || 4,
    'offline',
    now(),
    now(),
  );
  await audit(ctx.env.GODDB, { actor: a.id, action: 'server.created', target: id });
  return json({ ok: true, serverId: id });
};

// ---------------------------------------------------------------- routing
const PUBLIC: Record<string, Handler> = {
  'GET /api/status': publicStatus,
  'GET /api/leaderboard': leaderboard,
  'GET /api/products/public': publicProducts,
  'POST /api/auth/otp/request': authOtpRequest,
  'POST /api/auth/otp/verify': authOtpVerify,
  'POST /api/auth/logout': authLogout,
  'POST /api/admin/login': adminLogin,
};

const PLAYER: Record<string, Handler> = {
  'GET /api/me': authMe,
  'GET /api/products': shopProducts,
  'POST /api/shop/checkout': shopCheckout,
  'POST /api/shop/receipt': shopUploadReceipt,
};

const ADMIN: Record<string, Handler> = {
  'GET /api/admin/overview': adminOverview,
  'GET /api/admin/settings': adminSettingsGet,
  'PUT /api/admin/settings': adminSettingsPut,
  'GET /api/admin/appeals': adminAppeals,
  'POST /api/admin/appeals/decide': adminAppealDecide,
  'GET /api/admin/cheat-cases': adminCheatCases,
  'POST /api/admin/ban/permanent': adminBanPermanent,
  'GET /api/admin/alerts': adminAlerts,
  'POST /api/admin/servers': adminServersCreate,
};

const SERVER: Record<string, Handler> = {
  'POST /api/server/heartbeat': serverHeartbeat,
  'POST /api/server/player': serverPlayerEvent,
};

export async function handleApi(request: Request, env: ApiEnv): Promise<Response> {
  const url = new URL(request.url);
  const key = `${request.method} ${url.pathname}`;

  const ctx: ApiContext = {
    env,
    url,
    ip: clientIp(request),
    country: clientCountry(request),
    ua: userAgent(request),
  };

  if (request.method === 'OPTIONS') {
    return withSecurityHeaders(new Response(null, { status: 204 }), { cors: true });
  }

  const handler = PUBLIC[key] ?? PLAYER[key] ?? ADMIN[key] ?? SERVER[key];
  if (!handler) return err('not_found', 404);

  // Every mutating request must be same-origin. GETs are exempt because they
  // carry no side effects and are also fetched by the Minecraft runtime.
  if (request.method !== 'GET' && !SERVER[key]) {
    const blocked = requireSameOrigin(request);
    if (blocked) return withSecurityHeaders(blocked);
  }

  // Player routes need a session.
  if (PLAYER[key]) {
    const me = await playerOf(ctx, request);
    if (!me) return withSecurityHeaders(err('not_authenticated', 401));
  }

  const body = (await readJson(request)) ?? {};
  const res = await handler(ctx, body as Record<string, unknown>, request);
  return withSecurityHeaders(res);
}

export const exportedForTest = {
  nextRankXp,
  hasPerm,
  usdToToman,
  ANTICHEAT_WINDOW: ANTICHEAT.windowMs,
  normalizePhone,
  isValidIranPhone,
  setSetting,
  getSetting,
};
