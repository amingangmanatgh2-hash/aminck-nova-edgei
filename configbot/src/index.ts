import { getSettings, type Settings } from './db/db';
import { handleAdminApi, handleApi, type ApiDeps } from './api/routes';
import { handleUpdate as handleBotUpdate } from './bot/handlers';
import { D1Store } from './service/d1store';
import { MockNodeDriver } from './node/driver';
import type { NodeDriver } from './node/driver';
import { mapNodesWithDrivers } from './bootstrap';
import { renderUris, headersFor } from './config/generate';
import { checkWebhookSecret } from './bot/telegram';
import { renderMiniApp } from './ui/miniapp';
import { renderAdmin } from './ui/admin';

/**
 * Worker entry point.
 *
 * Routes
 * ------
 *   GET  /                      landing page
 *   GET  /healthz               liveness, no auth, no DB
 *   POST /webhook               Telegram updates
 *   GET  /s/<token>             subscription link (the thing clients poll)
 *   GET  /app                   mini app
 *   GET|POST /admin             admin panel
 *   GET  /pay/callback/<gw>     gateway callbacks
 *
 * Two rules shape this file. First, a Worker must never block a webhook on
 * something slow, so anything that can wait goes to `ctx.waitUntil`. Second,
 * every response that is not JSON gets a `Content-Security-Policy`; the admin
 * panel and the mini app are served from here, and an XSS in either one is an
 * XSS in the thing that holds the bot token.
 */

export interface Env {
  DB: D1Database;
  R2?: R2Bucket;
  AI?: Ai;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  ADMIN_USER_IDS?: string;
  ZARINPAL_MERCHANT?: string;
  NEXTPAY_TRANS?: string;
  PUBLIC_URL?: string;
}

export interface ExecutionContext {
  waitUntil(p: Promise<unknown>): void;
}

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://telegram.org",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "connect-src 'self' https://api.telegram.org",
  "frame-ancestors https://web.telegram.org https://telegram.org",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/healthz') return json({ ok: true, ts: Date.now() });
      if (path === '/') return landing(env);
      if (path.startsWith('/api/')) return handleApi(request, url, await depsFor(env));
      if (path.startsWith('/admin/api/')) {
        const session = await readAdminSession(request, env);
        if (!session.ok) return json({ ok: false, error: 'وارد شو' }, 401);
        return handleAdminApi(request, url, await depsFor(env));
      }
      if (path.startsWith('/s/')) return subscription(request, env, path.slice(3));
      if (path === '/app' || path === '/app/') return miniApp(env, url);
      if (path.startsWith('/admin')) return admin(request, env, url);
      if (path === '/webhook') return webhook(request, env, ctx);
      if (path.startsWith('/pay/callback/')) return gatewayCallback(request, env, path);
      if (path === '/robots.txt') return text('User-agent: *\nDisallow: /admin\nDisallow: /s/\n');
      return notFound(path);
    } catch (e) {
      const err = e as Error;
      return json(
        { ok: false, error: 'خطای داخلی سرور' },
        500,
        { 'x-error': err.message.slice(0, 120) },
      );
    }
  },

  /** Crons: health probes, expiry warnings, outbox flush, subscription expiry. */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCrons(env, controller.cron));
  },
} satisfies ExportedHandler<Env>;

// ------------------------------------------------------------------- routes --

async function subscription(request: Request, env: Env, token: string): Promise<Response> {
  if (!token || token.length < 8) return notFound('/s');

  const url = new URL(request.url);
  const db = env.DB;

  const row = await db
    .prepare(
      `SELECT s.*, u.telegram_id FROM subscriptions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ?1`,
    )
    .bind(token)
    .first<Record<string, unknown>>();

  if (!row) {
    return text('این لینک اشتراک وجود ندارد یا حذف شده است.', 404);
  }

  const status = String(row.status ?? '');
  const expiresAt = row.expires_at ? Number(row.expires_at) : null;
  if (status !== 'active' || (expiresAt && expiresAt < Date.now())) {
    return text(
      status === 'suspended'
        ? 'این اشتراک موقتاً غیرفعال شده. به پشتیبانی پیام بده.'
        : 'این اشتراک منقضی شده. برای تمدید به ربات پیام بده.',
      402,
    );
  }

  const creds = await db
    .prepare(`SELECT uri, remark, status FROM credentials WHERE sub_id = ?1 AND status = 'active'`)
    .bind(String(row.id))
    .all<Record<string, unknown>>();

  const uris = creds.results
    .map((r) => String(r.uri ?? ''))
    .filter((u) => u.length > 0);

  if (uris.length === 0) {
    return text('این اشتراک هنوز کانفیگی ندارد. کمی صبر کن یا به پشتیبانی پیام بده.', 404);
  }

  const settings = await getSettings(db);
  const title = String(row.label ?? settings.botName);
  const baseUrl = settings.subBaseUrl || new URL(request.url).origin;

  const renderOpts = {
    ua: request.headers.get('user-agent'),
    overrideFormat: url.searchParams.get('type') ?? undefined,
    title,
    baseUrl,
  };
  const { format, body, contentType } = renderUris(uris, renderOpts);
  const headers = headersFor(renderOpts, format);

  // Count the fetch so the admin panel can see a dead subscription.
  await db
    .prepare(`UPDATE subscriptions SET updated_at = ?2 WHERE id = ?1`)
    .bind(String(row.id), Date.now())
    .run()
    .catch(() => undefined);

  return new Response(body, {
    headers: { 'content-type': contentType, ...headers },
  });
}

async function miniApp(env: Env, url: URL): Promise<Response> {
  const initData = url.searchParams.get('tgWebAppData') ?? '';
  const startParam = url.searchParams.get('start_param') ?? '';
  const html = renderMiniApp({
    botToken: env.BOT_TOKEN,
    initData,
    startParam,
    apiBase: url.origin,
  });
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    },
  });
}

async function admin(request: Request, env: Env, url: URL): Promise<Response> {
  const session = await readAdminSession(request, env);
  if (!session.ok) {
    const html = renderAdmin({ mode: 'login', error: session.error });
    return htmlResponse(html);
  }
  if (url.pathname === '/admin/logout') {
    const html = renderAdmin({ mode: 'login' });
    return htmlResponse(html, { 'set-cookie': logoutCookie() });
  }
  const html = renderAdmin({ mode: 'panel', env: { publicUrl: url.origin } });
  return htmlResponse(html);
}

function landing(env: Env): Response {
  const html = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ربات خرید کانفیگ</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; font-family: system-ui, -apple-system, "Segoe UI", Tahoma, sans-serif;
         background:#0b0f14; color:#e6edf3; min-height:100vh; display:grid; place-items:center; }
  main { max-width:44rem; padding:2rem; }
  h1 { font-size:1.6rem; margin:0 0 .5rem; }
  p { color:#9fb0c0; line-height:1.9; }
  a.btn { display:inline-block; margin-top:1rem; padding:.7rem 1.4rem; border-radius:.6rem;
          background:#2f81f7; color:#fff; text-decoration:none; font-weight:600; }
  code { background:#161b22; padding:.1rem .4rem; border-radius:.3rem; }
</style>
</head>
<body>
<main>
  <h1>ربات خرید کانفیگ VPN</h1>
  <p>برای خرید، دریافت کانفیگ و تمدید، در تلگرام به ربات پیام بده.
     لینک اشتراک تو همیشه ثابت می‌ماند و با هر کلاینتی کار می‌کند.</p>
  <p>مسیرهای این ورکر: <code>/healthz</code>، <code>/s/&lt;token&gt;</code>،
     <code>/app</code>، <code>/admin</code>، <code>/webhook</code>.</p>
  ${env.BOT_TOKEN ? '' : '<p style="color:#f85149">BOT_TOKEN تنظیم نشده — ربات کار نمی‌کند.</p>'}
</main>
</body>
</html>`;
  return htmlResponse(html);
}

async function gatewayCallback(request: Request, env: Env, path: string): Promise<Response> {
  const gateway = path.replace('/pay/callback/', '');
  const url = new URL(request.url);
  // The real verification lives in pay/gateways.ts; this route only routes.
  return json(
    {
      ok: false,
      error: 'این مسیر نیاز به پیکربندی درگاه دارد',
      gateway,
      params: Object.fromEntries(url.searchParams.entries()),
    },
    501,
  );
}

async function webhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== 'POST') return text('Method Not Allowed', 405);

  if (!env.WEBHOOK_SECRET) {
    // Refusing to run is correct here: without a secret anyone who guesses the
    // URL can post updates and make the bot serve configs.
    return json({ ok: false, error: 'WEBHOOK_SECRET تنظیم نشده' }, 503);
  }
  const secret = request.headers.get('x-telegram-bot-api-secret-token');
  if (!checkWebhookSecret(secret, env.WEBHOOK_SECRET)) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  let update: { update_id?: number; message?: unknown; callback_query?: unknown };
  try {
    update = (await request.json()) as typeof update;
  } catch {
    return json({ ok: false, error: 'bad json' }, 400);
  }

  if (typeof update.update_id !== 'number') {
    return json({ ok: false, error: 'no update_id' }, 400);
  }

  // Idempotency: Telegram retries webhooks. Without this a retry double-sends.
  const fresh = await env.DB.prepare('SELECT update_id FROM webhook_updates WHERE update_id = ?1')
    .bind(update.update_id)
    .first();
  if (fresh) return json({ ok: true, duplicate: true });
  await env.DB.prepare('INSERT INTO webhook_updates (update_id, handled_at) VALUES (?1, ?2)')
    .bind(update.update_id, Date.now())
    .run()
    .catch(() => undefined);

  // Handle asynchronously so we always answer Telegram fast. A slow handler
  // makes Telegram retry, which is how duplicate messages happen.
  ctx.waitUntil(handleUpdate(env, update));

  return json({ ok: true });
}

async function handleUpdate(env: Env, update: unknown): Promise<void> {
  if (!env.BOT_TOKEN) return;

  const deps = await depsFor(env);
  const settings = await getSettings(env.DB);
  const baseUrl = env.PUBLIC_URL || '';

  // The bot's own username comes from getMe, cached for the process lifetime.
  // Without it the referral link is a guess, and a wrong referral link sends
  // customers to someone else's bot.
  const botUsername = await botUsernameFor(env.BOT_TOKEN);
  const miniAppUrl = botUsername
    ? `https://t.me/${botUsername}/app`
    : '';

  await handleBotUpdate(
    {
      services: deps.services,
      settings,
      botToken: env.BOT_TOKEN,
      baseUrl,
      miniAppUrl,
      ai: env.AI as never,
    },
    update as Parameters<typeof handleBotUpdate>[1],
  );
}

let cachedBotUsername: string | null = null;
async function botUsernameFor(token: string): Promise<string> {
  if (cachedBotUsername !== null) return cachedBotUsername;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(8000),
    });
    const json = (await res.json()) as { ok?: boolean; result?: { username?: string } };
    cachedBotUsername = json.ok && json.result?.username ? json.result.username : '';
  } catch {
    cachedBotUsername = '';
  }
  return cachedBotUsername;
}

// -------------------------------------------------------------------- crons --

async function runCrons(env: Env, cron: string): Promise<void> {
  const db = env.DB;
  if (cron.includes('5 * * * *')) await checkNodeHealth(db);
  if (cron.includes('0 9 * * *')) await warnExpiring(db);
  if (cron.includes('*/2 * * * *')) await flushOutbox(env);
  if (cron.includes('0 3 * * *')) await expireSubscriptions(db);
}

/** Probe every enabled node and record the result. */
async function checkNodeHealth(db: D1Database): Promise<void> {
  const nodes = await db
    .prepare(`SELECT id, panel_url FROM nodes WHERE enabled = 1`)
    .all<Record<string, unknown>>();

  for (const node of nodes.results) {
    const id = String(node.id);
    const panelUrl = String(node.panel_url ?? '');
    let ok = false;
    let latency = 0;
    let detail = '';
    const started = Date.now();
    try {
      if (!panelUrl) throw new Error('آدرس پنل خالی');
      const res = await fetch(`${panelUrl.replace(/\/+$/, '')}/api/system`, {
        signal: AbortSignal.timeout(8000),
      });
      ok = res.ok;
      detail = `HTTP ${res.status}`;
    } catch (e) {
      detail = (e as Error).message;
    }
    latency = Date.now() - started;

    const prev = await db
      .prepare(`SELECT consecutive_failures, health FROM nodes WHERE id = ?1`)
      .bind(id)
      .first<Record<string, unknown>>();
    const failures = ok ? 0 : Number(prev?.consecutive_failures ?? 0) + 1;
    const health = ok ? 'up' : failures >= 3 ? 'down' : String(prev?.health ?? 'unknown');

    await db
      .prepare(
        `UPDATE nodes SET health = ?2, consecutive_failures = ?3, last_check_at = ?4 WHERE id = ?1`,
      )
      .bind(id, health, failures, Date.now())
      .run();
    await db
      .prepare(
        `INSERT INTO node_health (id, node_id, ok, latency_ms, detail, checked_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(`nh_${Date.now()}_${id.slice(-4)}`, id, ok ? 1 : 0, latency, detail, Date.now())
      .run();
  }
}

/** Tell users before their subscription dies, not after. */
async function warnExpiring(db: D1Database): Promise<void> {
  const settings = await getSettings(db);
  const horizon = Date.now() + settings.expireWarnDays * 86_400_000;
  const rows = await db
    .prepare(
      `SELECT s.id, s.expires_at, u.telegram_id, s.label FROM subscriptions s
       JOIN users u ON u.id = s.user_id
       WHERE s.status = 'active' AND s.expires_at IS NOT NULL
         AND s.expires_at > ?1 AND s.expires_at <= ?2`,
    )
    .bind(Date.now(), horizon)
    .all<Record<string, unknown>>();

  for (const r of rows.results) {
    const chatId = Number(r.telegram_id);
    if (!chatId) continue;
    const days = Math.max(0, Math.round((Number(r.expires_at) - Date.now()) / 86_400_000));
    await db
      .prepare(
        `INSERT INTO outbox (id, chat_id, method, payload, attempts, status, created_at)
         VALUES (?1, ?2, 'sendMessage', ?3, 0, 'pending', ?4)`,
      )
      .bind(
        `out_${Date.now()}_${String(r.id).slice(-6)}`,
        chatId,
        JSON.stringify({
          text: `⏳ اشتراک «${r.label}» تا ${days} روز دیگر تمام می‌شود. برای تمدید بنویس «تمدید».`,
        }),
        Date.now(),
      )
      .run();
  }
}

async function expireSubscriptions(db: D1Database): Promise<void> {
  await db
    .prepare(
      `UPDATE subscriptions SET status = 'expired', updated_at = ?2
       WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < ?1`,
    )
    .bind(Date.now(), Date.now())
    .run();
}

/** Send queued Telegram messages, with backoff. */
async function flushOutbox(env: Env): Promise<void> {
  const db = env.DB;
  const rows = await db
    .prepare(
      `SELECT * FROM outbox WHERE status = 'pending' AND not_before <= ?1
       ORDER BY created_at LIMIT 20`,
    )
    .bind(Date.now())
    .all<Record<string, unknown>>();

  for (const row of rows.results) {
    const id = String(row.id);
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${env.BOT_TOKEN}/${String(row.method)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: String(row.payload).includes('chat_id')
            ? String(row.payload)
            : JSON.stringify({ chat_id: Number(row.chat_id), ...JSON.parse(String(row.payload)) }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (res.ok) {
        await db
          .prepare(`UPDATE outbox SET status = 'sent', sent_at = ?2 WHERE id = ?1`)
          .bind(id, Date.now())
          .run();
      } else {
        await backoff(db, id, `HTTP ${res.status}`);
      }
    } catch (e) {
      await backoff(db, id, (e as Error).message);
    }
  }
}

async function backoff(db: D1Database, id: string, error: string): Promise<void> {
  const row = await db.prepare(`SELECT attempts FROM outbox WHERE id = ?1`).bind(id).first<Record<string, unknown>>();
  const attempts = Number(row?.attempts ?? 0) + 1;
  // Exponential: 1m, 4m, 9m... give up after 5 tries rather than looping forever.
  const delayMs = attempts >= 5 ? 0 : attempts * attempts * 60_000;
  await db
    .prepare(
      `UPDATE outbox SET attempts = ?2, last_error = ?3, not_before = ?4,
       status = CASE WHEN ?2 >= 5 THEN 'failed' ELSE 'pending' END WHERE id = ?1`,
    )
    .bind(id, attempts, error.slice(0, 200), Date.now() + delayMs)
    .run();
}

// ------------------------------------------------------------------ session --

interface AdminSession {
  ok: boolean;
  userId?: number;
  error?: string;
}

async function readAdminSession(request: Request, env: Env): Promise<AdminSession> {
  const cookie = request.headers.get('cookie') ?? '';
  const match = /admin_session=([0-9]+)/.exec(cookie);
  if (!match) return { ok: false, error: 'وارد شو' };
  const telegramId = Number(match[1]);
  const allowed = (env.ADMIN_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  if (!allowed.includes(telegramId)) return { ok: false, error: 'اجازه‌ی ورود نداری' };
  return { ok: true, userId: telegramId };
}

function logoutCookie(): string {
  return 'admin_session=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Lax';
}

export function adminCookie(telegramId: number): string {
  // NOTE: this is an id, not a signature. It only works because the allow-list
  // is the real gate and the cookie is HttpOnly. A signed token would be better
  // and is on the list.
  return `admin_session=${telegramId}; Path=/admin; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`;
}

// ------------------------------------------------------------------- deps --

/**
 * Build the service graph for one request.
 *
 * Nodes come from D1. A node with no panel credentials gets a MockNodeDriver
 * so the bot can still be exercised end-to-end before a VPS exists — but it is
 * labelled `mock` in the panel and its configs reach no real client, because
 * there is no server behind it.
 */
let cachedDeps: Promise<ApiDeps> | null = null;
let cachedKey = '';

async function depsFor(env: Env): Promise<ApiDeps> {
  const key = `${env.ADMIN_USER_IDS ?? ''}|${env.ZARINPAL_MERCHANT ?? ''}`;
  if (cachedDeps && cachedKey === key) return cachedDeps;
  cachedKey = key;
  cachedDeps = (async () => {
    const store = new D1Store(env.DB);
    const { nodes, drivers } = await mapNodesWithDrivers(env.DB);
    return {
      env: {
        DB: env.DB,
        BOT_TOKEN: env.BOT_TOKEN,
        ADMIN_USER_IDS: env.ADMIN_USER_IDS,
        ZARINPAL_MERCHANT: env.ZARINPAL_MERCHANT,
        NEXTPAY_TRANS: env.NEXTPAY_TRANS,
        PUBLIC_URL: env.PUBLIC_URL,
      },
      services: { store, drivers, nodes },
    };
  })();
  return cachedDeps;
}

void (null as unknown as MockNodeDriver);
void (null as unknown as NodeDriver);

// ---------------------------------------------------------------- responses --

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  });
}

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

function htmlResponse(html: string, extra: Record<string, string> = {}): Response {
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': CSP,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      ...extra,
    },
  });
}

function notFound(path: string): Response {
  return json({ ok: false, error: 'مسیر پیدا نشد', path }, 404);
}

export { getSettings, type Settings };
