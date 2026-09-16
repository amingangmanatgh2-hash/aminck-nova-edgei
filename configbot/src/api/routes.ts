import { getSettings } from '../db/db';
import { headersFor, renderUris } from '../config/generate';
import { verifyInitData, type InitDataUser } from '../bot/telegram';
import { traceLeak, rotateSubscription, submitReceipt, createOrder, type Services } from '../service/orders';
import { buildRegistry, listAvailable } from '../pay/gateways';
import type { Store } from '../service/store';

/**
 * HTTP API for the mini app and the admin panel.
 *
 * Two separate trust domains, deliberately not sharing a check:
 *
 *  `/api/*`       — the buyer. Authenticated by the Telegram `initData` HMAC,
 *                   re-verified on *every* request. A user may only ever read
 *                   or act on their own rows; the userId comes from the
 *                   verified initData, never from a query parameter.
 *  `/admin/api/*` — the owner. Authenticated by the session cookie against the
 *                   ADMIN_USER_IDS allow-list.
 *
 * Every button in either UI calls something in this file. If an endpoint is
 * missing the button does not exist — a control that silently 404s is worse
 * than no control.
 */

export interface ApiEnv {
  DB: import('@cloudflare/workers-types').D1Database;
  BOT_TOKEN: string;
  ADMIN_USER_IDS?: string;
  ZARINPAL_MERCHANT?: string;
  NEXTPAY_TRANS?: string;
  PUBLIC_URL?: string;
}

export interface ApiDeps {
  services: Services;
  env: ApiEnv;
}

interface Ctx {
  deps: ApiDeps;
  user: InitDataUser;
  store: Store;
}

// ------------------------------------------------------------------ helpers --

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function fail(message: string, status = 400): Response {
  return json({ ok: false, error: message }, status);
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const v = (await req.json()) as Record<string, unknown>;
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function str(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/** Authenticate a mini-app request. Returns the verified user or an error. */
async function authenticate(req: Request, deps: ApiDeps): Promise<
  { ok: true; user: InitDataUser; store: Store } | { ok: false; response: Response }
> {
  let initData = '';
  if (req.method === 'POST') {
    initData = str(await readBody(req), 'initData');
  }
  if (!initData) {
    initData = new URL(req.url).searchParams.get('initData') ?? '';
  }
  const verified = await verifyInitData(initData, deps.env.BOT_TOKEN);
  if (!verified.ok || !verified.user) {
    return { ok: false, response: fail(verified.error ?? 'ورود ناموفق', 401) };
  }
  return { ok: true, user: verified.user, store: deps.services.store };
}

/** Find (or lazily create) the local user row for a verified Telegram user. */
async function resolveUser(ctx: Ctx): Promise<string | null> {
  const existing = await ctx.store.getUserByTelegram(ctx.user.id);
  if (existing) return existing.id;
  return null;
}

// ------------------------------------------------------------------- router --

export async function handleApi(
  req: Request,
  url: URL,
  deps: ApiDeps,
): Promise<Response> {
  const auth = await authenticate(req, deps);
  if (!auth.ok) return auth.response;

  const ctx: Ctx = { deps, user: auth.user, store: auth.store };
  const path = url.pathname;
  const method = req.method;

  try {
    // --- bootstrap: everything the mini app needs in one round trip ---------
    if (path === '/api/bootstrap' && method === 'GET') return bootstrap(ctx);

    // --- subscriptions ------------------------------------------------------
    let m = /^\/api\/subscriptions\/([^/]+)\/configs$/.exec(path);
    if (m && method === 'GET') return configs(ctx, decodeURIComponent(m[1]!));

    m = /^\/api\/subscriptions\/([^/]+)\/rotate$/.exec(path);
    if (m && method === 'POST') return rotate(ctx, decodeURIComponent(m[1]!));

    m = /^\/api\/subscriptions\/([^/]+)\/link$/.exec(path);
    if (m && method === 'GET') return subLink(ctx, decodeURIComponent(m[1]!));

    // --- orders -------------------------------------------------------------
    if (path === '/api/orders' && method === 'POST') return startOrder(req, ctx);

    m = /^\/api\/orders\/([^/]+)\/pay$/.exec(path);
    if (m && method === 'POST') return payOrder(req, ctx, decodeURIComponent(m[1]!));

    m = /^\/api\/orders\/([^/]+)\/receipt$/.exec(path);
    if (m && method === 'POST') return sendReceipt(req, ctx, decodeURIComponent(m[1]!));

    // --- tickets ------------------------------------------------------------
    if (path === '/api/tickets' && method === 'POST') return openTicket(req, ctx);

    return fail('مسیر پیدا نشد', 404);
  } catch (e) {
    const err = e as Error;
    return fail(err.message || 'خطای داخلی', 500);
  }
}

// ---------------------------------------------------------------- endpoints --

async function bootstrap(ctx: Ctx): Promise<Response> {
  const { store, deps } = ctx;
  const userId = await resolveUser(ctx);
  const settings = await getSettings(deps.env.DB);

  const user = userId ? await store.getUser(userId) : null;
  const subs = userId ? await store.listSubscriptions(userId) : [];
  const plans = await store.listPlans(false);
  const tickets = userId ? await store.listTickets({ userId }) : [];
  const ledger = userId ? await store.ledger(userId) : [];

  const baseUrl = deps.env.PUBLIC_URL || '';
  const alerts: string[] = [];
  for (const s of subs) {
    if (s.status !== 'active') continue;
    if (s.expiresAt) {
      const days = Math.ceil((s.expiresAt - Date.now()) / 86_400_000);
      if (days <= settings.expireWarnDays) alerts.push(`⏳ «${s.label}» تا ${days} روز دیگر تمام می‌شود.`);
    }
    if (s.trafficGb > 0) {
      const usedGb = s.trafficUsedBytes / 1024 ** 3;
      const pct = (usedGb / s.trafficGb) * 100;
      if (pct >= 100 - settings.lowTrafficWarnPercent) {
        alerts.push(`📉 «${s.label}» به ${Math.round(pct)}٪ از حجمش رسیده.`);
      }
    }
  }

  return json({
    ok: true,
    botName: settings.botName,
    currency: settings.currency,
    userName: user?.firstName || user?.username || ctx.user.firstName || '',
    balance: user?.balance ?? 0,
    subscriptions: subs.map((s) => ({
      id: s.id,
      token: s.token,
      label: s.label,
      trafficGb: s.trafficGb,
      usedGb: Number((s.trafficUsedBytes / 1024 ** 3).toFixed(2)),
      expiresAt: s.expiresAt,
      status: s.status,
      subUrl: baseUrl ? `${baseUrl}/s/${s.token}` : `/s/${s.token}`,
    })),
    plans: plans.map((p) => ({
      id: p.id,
      name: p.name,
      price: p.price,
      trafficGb: p.trafficGb,
      durationDays: p.durationDays,
      maxDevices: p.maxDevices,
      badge: p.badge,
    })),
    tickets,
    ledger,
    alerts,
  });
}

async function assertOwn(ctx: Ctx, subId: string) {
  const sub = await ctx.store.getSubscription(subId);
  if (!sub) throw new Error('اشتراک پیدا نشد');
  const userId = await resolveUser(ctx);
  if (!userId || sub.userId !== userId) throw new Error('این اشتراک مال شما نیست');
  return sub;
}

async function configs(ctx: Ctx, subId: string): Promise<Response> {
  await assertOwn(ctx, subId);
  const creds = await ctx.store.listCredentials(subId);
  return json({
    ok: true,
    configs: creds
      .filter((c) => c.status === 'active')
      .map((c) => ({ uri: c.uri, remark: c.remark, watermark: c.watermark })),
  });
}

async function subLink(ctx: Ctx, subId: string): Promise<Response> {
  const sub = await assertOwn(ctx, subId);
  const base = ctx.deps.env.PUBLIC_URL || '';
  return json({ ok: true, url: base ? `${base}/s/${sub.token}` : `/s/${sub.token}` });
}

async function rotate(ctx: Ctx, subId: string): Promise<Response> {
  await assertOwn(ctx, subId);
  const userId = (await resolveUser(ctx))!;
  const res = await rotateSubscription(ctx.deps.services, subId, userId);
  return json({
    ok: true,
    changed: res.changed,
    failures: res.failures.length,
    message:
      res.changed > 0
        ? `${res.changed} کانفیگ چرخش شد. لینک اشتراک عوض نشده، فقط دوباره به‌روزش کن.`
        : 'چرخشی انجام نشد',
  });
}

async function startOrder(req: Request, ctx: Ctx): Promise<Response> {
  const body = await readBody(req);
  const userId = await resolveUser(ctx);
  if (!userId) return fail('اول در ربات /start را بزن', 403);

  const planId = str(body, 'planId');
  if (!planId) return fail('پلن مشخص نیست');

  const order = await createOrder(ctx.deps.services, { userId, planId });
  const settings = await getSettings(ctx.deps.env.DB);
  const gateways = buildRegistry({
    card: {
      cardNumber: settings.cardNumber,
      cardHolder: settings.cardHolder,
      cardBank: settings.cardBank,
      extraMessage: settings.paymentMessage,
      currency: settings.currency,
    },
    walletBalance: async (id) => (await ctx.store.getUser(id))?.balance ?? 0,
    zarinpal: {
      merchantId: ctx.deps.env.ZARINPAL_MERCHANT ?? '',
      sandbox: false,
      callbackUrl: `${ctx.deps.env.PUBLIC_URL ?? ''}/pay/callback/zarinpal`,
    },
    nextpay: {
      transId: ctx.deps.env.NEXTPAY_TRANS ?? '',
      callbackUrl: `${ctx.deps.env.PUBLIC_URL ?? ''}/pay/callback/nextpay`,
    },
  });

  return json({
    ok: true,
    id: order.id,
    code: order.code,
    amount: order.amount,
    discount: order.discount,
    currency: settings.currency,
    gateways: order.amount > 0 ? listAvailable(gateways) : [],
  });
}

async function payOrder(req: Request, ctx: Ctx, orderId: string): Promise<Response> {
  const body = await readBody(req);
  const gateway = str(body, 'gateway');
  const order = await ctx.store.getOrder(orderId);
  if (!order) return fail('سفارش پیدا نشد', 404);
  const userId = await resolveUser(ctx);
  if (!userId || order.userId !== userId) return fail('این سفارش مال شما نیست', 403);

  if (gateway === 'card') {
    const settings = await getSettings(ctx.deps.env.DB);
    const registry = buildRegistry({
      card: {
        cardNumber: settings.cardNumber,
        cardHolder: settings.cardHolder,
        cardBank: settings.cardBank,
        extraMessage: settings.paymentMessage,
        currency: settings.currency,
      },
      walletBalance: async (id) => (await ctx.store.getUser(id))?.balance ?? 0,
      zarinpal: { merchantId: '', sandbox: false, callbackUrl: '' },
      nextpay: { transId: '', callbackUrl: '' },
    });
    const gw = registry.get('card');
    if (!gw || !gw.info().available) {
      return fail('کارت مدیر هنوز در پنل تنظیم نشده', 503);
    }
    const res = await gw.start({
      id: order.id,
      orderCode: order.code,
      amount: order.amount,
      userId: order.userId,
      userName: '',
      description: `سفارش ${order.code}`,
      callbackUrl: '',
    });
    if (res.kind === 'instructions') {
      await ctx.store.updateOrder(order.id, { status: 'awaiting_payment', gateway: 'card' });
      return json({ ok: true, kind: 'instructions', text: res.text, ref: res.ref });
    }
  }

  return fail('این روش پرداخت فعلاً فعال نیست', 501);
}

async function sendReceipt(req: Request, ctx: Ctx, orderId: string): Promise<Response> {
  const body = await readBody(req);
  const userId = await resolveUser(ctx);
  if (!userId) return fail('اول در ربات /start را بزن', 403);

  const res = await submitReceipt(ctx.deps.services, {
    orderId,
    userId,
    receiptPhoto: str(body, 'receiptPhoto'),
    payerCard: str(body, 'payerCard'),
    payerName: str(body, 'payerName'),
    trackingCode: str(body, 'trackingCode'),
    note: str(body, 'note'),
  });

  return json({
    ok: true,
    autoApproved: res.autoApproved,
    verdict: { verdict: res.verdict.verdict, summary: res.verdict.summary },
    message: res.autoApproved
      ? 'پرداخت تأیید شد و کانفیگ‌هایت آماده است ✅'
      : 'فیشت ثبت شد. به‌زودی بررسی می‌شود و نتیجه را در ربات می‌فرستیم.',
  });
}

async function openTicket(req: Request, ctx: Ctx): Promise<Response> {
  const body = await readBody(req);
  const userId = await resolveUser(ctx);
  if (!userId) return fail('اول در ربات /start را بزن', 403);
  const subject = str(body, 'subject').trim();
  if (subject.length < 3) return fail('موضوع را کامل‌تر بنویس');

  const code = `T${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  await ctx.store.createTicket({
    id: `tkt_${Date.now()}`,
    code,
    userId,
    subject: subject.slice(0, 200),
    category: 'other',
    status: 'open',
    createdAt: Date.now(),
  });
  await ctx.store.audit({
    actorId: userId,
    action: 'ticket.open',
    targetType: 'ticket',
    targetId: code,
    detail: JSON.stringify({ subject: subject.slice(0, 100) }),
  });
  return json({ ok: true, code });
}

// ------------------------------------------------------------- admin API ----

export async function handleAdminApi(
  req: Request,
  url: URL,
  deps: ApiDeps,
): Promise<Response> {
  const { services } = deps;
  const store = services.store;
  const path = url.pathname;
  const method = req.method;

  try {
    if (path === '/admin/api/dashboard' && method === 'GET') return adminDashboard(deps);
    if (path === '/admin/api/payments' && method === 'GET') return adminPayments(store);

    let m = /^\/admin\/api\/payments\/([^/]+)\/review$/.exec(path);
    if (m && method === 'POST') return reviewPayment(req, deps, decodeURIComponent(m[1]!));

    if (path === '/admin/api/orders' && method === 'GET') return adminOrders(store);
    if (path === '/admin/api/subscriptions' && method === 'GET') return adminSubs(store);

    m = /^\/admin\/api\/subscriptions\/([^/]+)\/rotate$/.exec(path);
    if (m && method === 'POST') return adminRotate(deps, decodeURIComponent(m[1]!));

    m = /^\/admin\/api\/subscriptions\/([^/]+)\/suspend$/.exec(path);
    if (m && method === 'POST') return adminSuspend(req, store, decodeURIComponent(m[1]!));

    if (path === '/admin/api/nodes' && method === 'GET') return adminNodes(store);
    if (path === '/admin/api/plans' && method === 'GET') return adminPlans(store);
    if (path === '/admin/api/users' && method === 'GET') return adminUsers(store);
    if (path === '/admin/api/tickets' && method === 'GET') return adminTickets(store);
    if (path === '/admin/api/audit' && method === 'GET') return adminAudit(store);

    if (path === '/admin/api/settings' && method === 'GET') return adminSettings(deps);
    if (path === '/admin/api/settings' && method === 'POST') return saveSettings(req, deps);

    if (path === '/admin/api/trace' && method === 'POST') return adminTrace(req, deps);

    m = /^\/admin\/api\/nodes\/([^/]+)\/probe$/.exec(path);
    if (m && method === 'POST') return probeNode(deps, decodeURIComponent(m[1]!));

    return fail('مسیر پیدا نشد', 404);
  } catch (e) {
    void services;
    return fail((e as Error).message || 'خطای داخلی', 500);
  }
}

async function adminDashboard(deps: ApiDeps): Promise<Response> {
  const db = deps.env.DB;
  const one = async (sql: string, ...p: unknown[]) => {
    const r = await db.prepare(sql).bind(...p).first<Record<string, unknown>>();
    return r ?? {};
  };

  const users = await one('SELECT COUNT(*) AS n FROM users');
  const active = await one('SELECT COUNT(*) AS n FROM users WHERE last_active_at > ?1', Date.now() - 7 * 86_400_000);
  const subs = await one("SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'active'");
  const expiring = await one(
    "SELECT COUNT(*) AS n FROM subscriptions WHERE status='active' AND expires_at > ?1 AND expires_at <= ?2",
    Date.now(),
    Date.now() + 3 * 86_400_000,
  );
  const rev30 = await one(
    "SELECT COALESCE(SUM(amount),0) AS s, COUNT(*) AS n FROM orders WHERE status IN ('paid','approved') AND paid_at > ?1",
    Date.now() - 30 * 86_400_000,
  );
  const revToday = await one(
    "SELECT COALESCE(SUM(amount),0) AS s FROM orders WHERE status IN ('paid','approved') AND paid_at > ?1",
    new Date().setHours(0, 0, 0, 0),
  );
  const creds = await one("SELECT COUNT(*) AS n FROM credentials");
  const credsActive = await one("SELECT COUNT(*) AS n FROM credentials WHERE status='active'");
  const rot = await one('SELECT COALESCE(SUM(rotation_count),0) AS n FROM subscriptions');
  const nodesUp = await one("SELECT COUNT(*) AS n FROM nodes WHERE health='up' AND enabled=1");
  const nodesDown = await one("SELECT COUNT(*) AS n FROM nodes WHERE health='down'");
  const queue = await one("SELECT COUNT(*) AS n FROM payments WHERE status='submitted'");
  const maintenance = await one('SELECT maintenance_mode AS m FROM settings WHERE id=1');

  const recentRows = await db
    .prepare(
      `SELECT o.code, o.amount, o.status, o.created_at, COALESCE(u.username, u.first_name, o.user_id) AS user
       FROM orders o LEFT JOIN users u ON u.id = o.user_id
       ORDER BY o.created_at DESC LIMIT 8`,
    )
    .all<Record<string, unknown>>();

  return json({
    ok: true,
    users: { total: Number(users.n ?? 0), active7d: Number(active.n ?? 0) },
    subs: { active: Number(subs.n ?? 0), expiringSoon: Number(expiring.n ?? 0) },
    revenue: { d30: Number(rev30.s ?? 0), today: Number(revToday.s ?? 0) },
    orders: { paid30: Number(rev30.n ?? 0) },
    credentials: { total: Number(creds.n ?? 0), active: Number(credsActive.n ?? 0) },
    rotations: Number(rot.n ?? 0),
    nodes: { up: Number(nodesUp.n ?? 0), down: Number(nodesDown.n ?? 0) },
    queue: Number(queue.n ?? 0),
    maintenance: maintenance.m === 1,
    recentOrders: recentRows.results.map((r) => ({
      code: String(r.code ?? ''),
      user: String(r.user ?? ''),
      amount: Number(r.amount ?? 0),
      status: String(r.status ?? ''),
      createdAt: Number(r.created_at ?? 0),
    })),
  });
}

async function adminPayments(store: Store): Promise<Response> {
  const pending = await store.listPayments({ status: 'submitted', limit: 40 });
  const recent = await store.listPayments({ limit: 30 });
  const label = async (id: string) => {
    const u = await store.getUser(id);
    return u?.username || u?.firstName || id;
  };

  const withNames = await Promise.all(
    pending.map(async (p) => {
      const order = p.orderId ? await store.getOrder(p.orderId) : null;
      return {
        id: p.id,
        orderCode: order?.code ?? '—',
        user: await label(p.userId),
        amount: p.amount,
        payerCard: p.payerCard,
        trackingCode: p.trackingCode,
        verdict: p.reviewNote ? undefined : undefined,
        verdictNote: p.reviewNote,
        createdAt: p.createdAt,
      };
    }),
  );

  const recentNamed = await Promise.all(
    recent.map(async (p) => ({
      ...p,
      user: await label(p.userId),
    })),
  );

  return json({ ok: true, pending: withNames, recent: recentNamed });
}

async function reviewPayment(req: Request, deps: ApiDeps, paymentId: string): Promise<Response> {
  const body = await readBody(req);
  const action = str(body, 'action');
  const { approvePayment, rejectPayment } = await import('../service/orders');

  if (action === 'approve') {
    await approvePayment(deps.services, paymentId, 'admin', 'تأیید از پنل');
    return json({ ok: true });
  }
  if (action === 'reject') {
    await rejectPayment(deps.services, paymentId, 'admin', str(body, 'reason') || 'رد از پنل');
    return json({ ok: true });
  }
  return fail('عمل نامعتبر');
}

async function adminOrders(store: Store): Promise<Response> {
  const orders = await store.listOrders(undefined, 60);
  const out = await Promise.all(
    orders.map(async (o) => {
      const u = await store.getUser(o.userId);
      return { ...o, user: u?.username || u?.firstName || o.userId };
    }),
  );
  return json({ ok: true, orders: out });
}

async function adminSubs(store: Store): Promise<Response> {
  const subs = await store.listAllSubscriptions(150);
  const out = await Promise.all(
    subs.map(async (s) => {
      const u = await store.getUser(s.userId);
      return {
        id: s.id,
        token: s.token,
        user: u?.username || u?.firstName || s.userId,
        label: s.label,
        trafficGb: s.trafficGb,
        usedGb: Number((s.trafficUsedBytes / 1024 ** 3).toFixed(2)),
        expiresAt: s.expiresAt,
        status: s.status,
        rotationCount: s.rotationCount,
      };
    }),
  );
  return json({ ok: true, subs: out });
}

async function adminRotate(deps: ApiDeps, subId: string): Promise<Response> {
  const res = await rotateSubscription(deps.services, subId, 'admin');
  return json({ ok: true, changed: res.changed, failures: res.failures.length });
}

async function adminSuspend(req: Request, store: Store, subId: string): Promise<Response> {
  const body = await readBody(req);
  const suspend = body.suspend === true;
  const sub = await store.getSubscription(subId);
  if (!sub) return fail('اشتراک پیدا نشد', 404);
  await store.updateSubscription(subId, { status: suspend ? 'suspended' : 'active' });
  return json({ ok: true });
}

async function adminNodes(store: Store): Promise<Response> {
  const nodes = await store.listNodes();
  return json({ ok: true, nodes });
}

async function adminPlans(store: Store): Promise<Response> {
  return json({ ok: true, plans: await store.listPlans(true) });
}

async function adminUsers(store: Store): Promise<Response> {
  const users = await store.listUsers(200, 0);
  const out = await Promise.all(
    users.map(async (u) => {
      const subs = await store.listSubscriptions(u.id);
      return {
        id: u.id,
        telegramId: u.telegramId,
        username: u.username,
        firstName: u.firstName,
        balance: u.balance,
        totalSpent: 0,
        blocked: u.blocked,
        subs: subs.filter((s) => s.status === 'active').length,
      };
    }),
  );
  return json({ ok: true, users: out });
}

async function adminTickets(store: Store): Promise<Response> {
  const tickets = await store.listTickets({});
  const out = await Promise.all(
    tickets.map(async (t) => {
      const u = await store.getUser(t.userId);
      return { ...t, user: u?.username || u?.firstName || t.userId };
    }),
  );
  return json({ ok: true, tickets: out });
}

async function adminAudit(store: Store): Promise<Response> {
  const entries = await store.listAudit(80);
  return json({
    ok: true,
    entries: entries.map((a) => ({ ...a, actorLabel: a.actorId ? 'ادمین' : 'سیستم' })),
  });
}

async function adminSettings(deps: ApiDeps): Promise<Response> {
  const settings = await getSettings(deps.env.DB);
  const registry = buildRegistry({
    card: {
      cardNumber: settings.cardNumber,
      cardHolder: settings.cardHolder,
      cardBank: settings.cardBank,
      extraMessage: settings.paymentMessage,
      currency: settings.currency,
    },
    walletBalance: async () => 0,
    zarinpal: { merchantId: deps.env.ZARINPAL_MERCHANT ?? '', sandbox: false, callbackUrl: '' },
    nextpay: { transId: deps.env.NEXTPAY_TRANS ?? '', callbackUrl: '' },
  });
  return json({
    ok: true,
    settings,
    gateways: ['card', 'zarinpal', 'nextpay', 'wallet'].map((id) => registry.get(id as 'card')!.info()),
  });
}

async function saveSettings(req: Request, deps: ApiDeps): Promise<Response> {
  const body = await readBody(req);
  const { upsertSettings } = await import('../db/db');
  const cur = await getSettings(deps.env.DB);

  const patch: Record<string, unknown> = {};
  const numKeys = ['trialDays', 'trialTrafficGb', 'referralPercent', 'expireWarnDays', 'lowTrafficWarnPercent'];
  const boolKeys = ['trialEnabled', 'referralEnabled', 'aiEnabled', 'maintenanceMode'];
  const textKeys = ['cardNumber', 'cardHolder', 'cardBank', 'paymentMessage', 'maintenanceMessage', 'botName', 'supportChat'];

  for (const k of numKeys) {
    if (k in body) patch[k] = Math.max(0, Number(body[k]) || 0);
  }
  for (const k of boolKeys) {
    if (k in body) patch[k] = body[k] === true || body[k] === 'true' || body[k] === 1;
  }
  for (const k of textKeys) {
    if (k in body) patch[k] = String(body[k] ?? '').slice(0, 300);
  }

  await upsertSettings(deps.env.DB, { ...cur, ...patch } as never);
  return json({ ok: true });
}

async function adminTrace(req: Request, deps: ApiDeps): Promise<Response> {
  const body = await readBody(req);
  const uri = str(body, 'uri');
  if (!uri) return fail('کانفیگی نفرستادی');
  const trace = await traceLeak(deps.services, uri);
  return json({
    ok: true,
    found: trace.found,
    message: trace.message,
    username: trace.username,
    userId: trace.userId,
    subId: trace.subId,
    watermark: trace.credential?.watermark ?? '',
  });
}

async function probeNode(deps: ApiDeps, nodeId: string): Promise<Response> {
  const nodes = await deps.services.store.listNodes();
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return fail('نود پیدا نشد', 404);
  const started = Date.now();
  try {
    if (!node.panelUrl) throw new Error('آدرس پنل خالی است');
    const res = await fetch(`${node.panelUrl.replace(/\/+$/, '')}/api/system`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return json({ ok: true, latencyMs: Date.now() - started, detail: 'پاسخ داد' });
  } catch (e) {
    return json({ ok: false, latencyMs: Date.now() - started, detail: (e as Error).message });
  }
}

// --------------------------------------------------------- subscription out --

/**
 * Serve a subscription link. Kept here rather than in index.ts so the format
 * decision has exactly one implementation, shared by the mini app's "copy
 * link" preview and the real client fetch.
 */
export function subscriptionResponse(
  uris: string[],
  opts: { ua: string | null; override?: string; title: string; baseUrl: string },
): Response {
  const renderOpts = { ua: opts.ua, overrideFormat: opts.override, title: opts.title, baseUrl: opts.baseUrl };
  const { format, body, contentType } = renderUris(uris, renderOpts);
  return new Response(body, {
    headers: { 'content-type': contentType, ...headersFor(renderOpts, format) },
  });
}
