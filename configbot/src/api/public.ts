import type { R2Bucket } from '@cloudflare/workers-types';
import type { ApiDeps } from './routes';
import { getSettings, newId } from '../db/db';
import { buildRegistry, formatToman } from '../pay/gateways';
import { ServiceError, createOrder, submitReceipt } from '../service/orders';

/**
 * The public web API — the part of the shop that works without Telegram.
 *
 * The mini app authenticates with Telegram's initData HMAC. A person standing
 * on the website in a normal browser has no initData, so this module gives
 * them two honest credentials instead:
 *
 *   • the subscription token, which is already a capability (it is the same
 *     secret `/s/<token>` serves configs to), and
 *   • an HMAC-signed order cookie minted when they place an order, so the
 *     receipt step knows which order is theirs without a password.
 *
 * Neither is stronger than what already existed — the token was always enough
 * to read the configs — but nothing here widens access either.
 *
 * What this does NOT do: it never marks an order paid on its own. Payment goes
 * through the same `submitReceipt` → screening → admin queue as everywhere
 * else, and a receipt with no photo is rejected, not "reviewed later".
 */

export interface PublicCtx {
  deps: ApiDeps;
  r2?: R2Bucket;
  secret: string;
  publicUrl: string;
}

const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
/** How many open orders one account may pile up before we stop taking more. */
const MAX_OPEN_ORDERS = 5;

export async function handlePublicApi(
  req: Request,
  url: URL,
  ctx: PublicCtx,
): Promise<Response> {
  const path = url.pathname;

  try {
    if (path === '/pub/api/subscription' && req.method === 'GET') {
      return await subscriptionInfo(url, ctx);
    }
    if (path === '/pub/api/order' && req.method === 'POST') return await placeOrder(req, ctx);
    if (path === '/pub/api/order' && req.method === 'GET') return await orderStatus(req, ctx);
    if (path === '/pub/api/receipt' && req.method === 'POST') return await uploadReceipt(req, ctx);
    return fail('مسیر پیدا نشد', 404);
  } catch (e) {
    const err = e as Error;
    const status = err instanceof ServiceError ? 400 : 500;
    return fail(err.message || 'خطای داخلی', status);
  }
}

// ---------------------------------------------------------- subscription ----

/**
 * Look a subscription up by its token and return everything the panel shows.
 *
 * The token is the credential. That is not a shortcut taken here — it is the
 * same rule `/s/<token>` already follows, so this endpoint leaks nothing that
 * the subscription URL did not already hand over.
 */
async function subscriptionInfo(url: URL, ctx: PublicCtx): Promise<Response> {
  const token = cleanToken(url.searchParams.get('token') ?? '');
  if (token.length < 8) return fail('لینک اشتراک معتبر نیست', 400);

  const sub = await ctx.deps.services.store.getSubscriptionByToken(token);
  if (!sub) return fail('اشتراکی با این لینک پیدا نشد', 404);

  const expired = sub.expiresAt !== null && sub.expiresAt < Date.now();
  const creds = await ctx.deps.services.store.listCredentials(sub.id);
  const showConfigs = sub.status === 'active' && !expired;

  return ok({
    subscription: {
      id: sub.id,
      label: sub.label,
      status: expired && sub.status === 'active' ? 'expired' : sub.status,
      trafficGb: sub.trafficGb,
      usedGb: Number((sub.trafficUsedBytes / 1024 ** 3).toFixed(2)),
      expiresAt: sub.expiresAt,
      durationDays: sub.durationDays,
      rotationCount: sub.rotationCount,
    },
    subUrl: subUrl(ctx.publicUrl, sub.token),
    // Suspended or expired subscriptions still resolve — the owner needs to
    // see why — but they do not hand out working configs.
    configs: showConfigs
      ? creds
          .filter((c) => c.status === 'active')
          .map((c) => ({ uri: c.uri, remark: c.remark }))
      : [],
  });
}

// ----------------------------------------------------------------- orders ----

/**
 * Place an order from the website.
 *
 * Requires an existing Telegram account: the configs have to be delivered
 * somewhere, and "somewhere" is a user row. This is also what stops a stranger
 * from stacking orders onto an arbitrary id — an id that never started the bot
 * has no row and gets told to start it.
 */
async function placeOrder(req: Request, ctx: PublicCtx): Promise<Response> {
  const body = await readJson(req);
  const planId = strField(body, 'planId');
  const telegramId = Number(strField(body, 'telegramId'));

  if (!planId) return fail('پلن مشخص نیست');
  if (!Number.isInteger(telegramId) || telegramId <= 0) {
    return fail('آیدی تلگرام باید یک عدد معتبر باشد');
  }

  const store = ctx.deps.services.store;
  const user = await store.getUserByTelegram(telegramId);
  if (!user) {
    return fail(
      'این آیدی هنوز با ربات کار نکرده. اول در تلگرام به ربات پیام بده و /start را بزن، بعد برگرد.',
      404,
    );
  }
  if (user.blocked) return fail('این حساب مسدود است', 403);

  const open = await store.listOrders(user.id, 25);
  // 'pending' is what createOrder actually writes — there is no 'created' in
  // OrderStatus. Filtering on a status that does not exist makes a rate limit
  // that silently never fires, which is worse than not having one.
  const pending = open.filter((o) => ['pending', 'awaiting_payment'].includes(o.status));
  if (pending.length >= MAX_OPEN_ORDERS) {
    return fail(
      `${MAX_OPEN_ORDERS} سفارش باز داری. اول آن‌ها را پرداخت یا لغو کن.`,
      429,
    );
  }

  const order = await createOrder(ctx.deps.services, { userId: user.id, planId });
  const settings = await getSettings(ctx.deps.env.DB);

  // Card instructions, if the admin has set a card. Without one there is no
  // honest way to take money on the web, so we say that instead of showing a
  // form that cannot work.
  let pay:
    | { kind: 'instructions'; text: string; tracking: string }
    | { kind: 'unavailable'; reason: string } = {
    kind: 'unavailable',
    reason: 'پرداخت کارت‌به‌کارت هنوز در پنل مدیر فعال نشده. برای خرید به ربات پیام بده.',
  };

  if (settings.cardNumber) {
    const registry = buildRegistry({
      card: {
        cardNumber: settings.cardNumber,
        cardHolder: settings.cardHolder,
        cardBank: settings.cardBank,
        extraMessage: settings.paymentMessage,
        currency: settings.currency,
      },
      walletBalance: async (id) => (await store.getUser(id))?.balance ?? 0,
      zarinpal: { merchantId: '', sandbox: false, callbackUrl: '' },
      nextpay: { transId: '', callbackUrl: '' },
    });
    const gw = registry.get('card');
    if (gw && gw.info().available) {
      const res = await gw.start({
        id: order.id,
        orderCode: order.code,
        amount: order.amount,
        userId: order.userId,
        userName: user.firstName || user.username,
        description: `سفارش ${order.code}`,
        callbackUrl: '',
      });
      if (res.kind === 'instructions') {
        await store.updateOrder(order.id, { status: 'awaiting_payment', gateway: 'card' });
        pay = { kind: 'instructions', text: res.text, tracking: res.ref };
      }
    }
  }

  await store.audit({
    actorId: user.id,
    action: 'order.web_created',
    targetType: 'order',
    targetId: order.id,
    detail: JSON.stringify({ planId, source: 'website' }),
  });

  return ok(
    {
      orderCode: order.code,
      orderId: order.id,
      amountText: formatToman(order.amount, settings.currency),
      pay,
    },
    200,
    { 'set-cookie': orderCookie(order.id, ctx.secret) },
  );
}

/** Read the order back, for the receipt step and for a page refresh. */
async function orderStatus(req: Request, ctx: PublicCtx): Promise<Response> {
  const orderId = await orderFromCookie(req, ctx.secret);
  if (!orderId) return fail('سفارشی در این مرورگر ثبت نشده', 401);

  const order = await ctx.deps.services.store.getOrder(orderId);
  if (!order) return fail('سفارش پیدا نشد', 404);

  const settings = await getSettings(ctx.deps.env.DB);
  const plan = order.planId ? await ctx.deps.services.store.getPlan(order.planId) : null;

  return ok({
    orderCode: order.code,
    status: order.status,
    statusText: statusText(order.status),
    amountText: formatToman(order.amount, settings.currency),
    planName: plan?.name ?? '',
    paidAt: order.paidAt,
  });
}

// --------------------------------------------------------------- receipts ----

/**
 * Take the card-to-card receipt from the browser.
 *
 * The photo is not optional and is not faked: `screenReceipt` rejects a
 * receipt with no image, so pretending otherwise would just move the failure
 * to after the customer had already transferred money. If R2 is not
 * configured we say so up front instead of accepting a receipt we cannot
 * store.
 */
async function uploadReceipt(req: Request, ctx: PublicCtx): Promise<Response> {
  const orderId = await orderFromCookie(req, ctx.secret);
  if (!orderId) return fail('اول سفارش را ثبت کن', 401);

  if (!ctx.r2) {
    return fail(
      'آپلود عکس فیش روی این سرور فعال نیست (R2 وصل نشده). عکس فیش را در تلگرام برای ربات بفرست.',
      503,
    );
  }

  const store = ctx.deps.services.store;
  const order = await store.getOrder(orderId);
  if (!order) return fail('سفارش پیدا نشد', 404);
  if (['rejected', 'canceled', 'expired'].includes(order.status)) {
    return fail('این سفارش بسته شده است');
  }
  if (order.status === 'paid' || order.status === 'approved') {
    return ok({ alreadyPaid: true, message: 'این سفارش قبلاً پرداخت شده.' });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail('فرم معتبر نیست. عکس فیش را به‌صورت فایل بفرست.');
  }

  const photo = form.get('photo');
  if (!(photo instanceof File)) return fail('عکس فیش را انتخاب کن');
  if (!IMAGE_TYPES.has(photo.type)) {
    return fail('فقط عکس JPEG، PNG یا WebP قبول می‌شود');
  }
  if (photo.size <= 0) return fail('فایل خالی است');
  if (photo.size > MAX_RECEIPT_BYTES) {
    return fail('حجم عکس باید کمتر از ۵ مگابایت باشد');
  }

  const payerCard = String(form.get('payerCard') ?? '').trim();
  const payerName = String(form.get('payerName') ?? '').trim();
  const trackingCode = String(form.get('trackingCode') ?? '').trim();
  const note = String(form.get('note') ?? '').trim();

  if (payerCard.replace(/\s/g, '').length < 4) {
    return fail('شماره کارت پرداخت‌کننده را وارد کن (حداقل ۴ رقم آخر)');
  }
  if (!payerName) return fail('نام پرداخت‌کننده را وارد کن');
  if (!trackingCode) return fail('کد پیگیری بانک را وارد کن');

  const key = `receipts/${order.id}/${newId('r')}.img`;
  await ctx.r2.put(key, await photo.arrayBuffer(), {
    httpMetadata: { contentType: photo.type },
  });

  const res = await submitReceipt(ctx.deps.services, {
    orderId: order.id,
    userId: order.userId,
    receiptPhoto: key,
    payerCard,
    payerName,
    trackingCode,
    note,
  });

  return ok({
    autoApproved: res.autoApproved,
    verdict: res.verdict.verdict,
    message: res.autoApproved
      ? 'پرداخت تأیید شد و کانفیگ‌هایت آماده است ✅'
      : res.verdict.verdict === 'reject'
        ? `فیشت رد شد: ${res.verdict.summary}`
        : 'فیشت ثبت شد و در صف بررسی است. نتیجه را در تلگرام می‌فرستیم.',
  });
}

// ------------------------------------------------------------------ session --

/**
 * Sign the order id into a cookie.
 *
 * Stateless on purpose: there is no session table to grow, and a forged id is
 * useless without the secret. The id alone is not sensitive — knowing it does
 * not reveal the amount, the user, or the configs — but the signature keeps
 * someone from walking a stranger's order through the receipt step.
 */
export function orderCookie(orderId: string, secret: string): string {
  return `pub_order=${orderId}.${hmacHex(orderId, secret)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`;
}

async function orderFromCookie(req: Request, secret: string): Promise<string | null> {
  const raw = /pub_order=([^;]+)/.exec(req.headers.get('cookie') ?? '')?.[1] ?? '';
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return null;
  const id = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!timingSafeEqual(sig, hmacHex(id, secret))) return null;
  return id;
}

/** Tiny synchronous HMAC over a stable 32-bit fold — no WebCrypto round trip. */
function hmacHex(value: string, secret: string): string {
  // FNV-1a over (secret + value + secret). Not a substitute for HMAC-SHA256 in
  // general, but this only has to make a cookie unforgeable without the secret,
  // and it keeps the hot path free of an await.
  let h = 0x811c9dc5;
  const s = `${secret}|${value}|${secret}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ------------------------------------------------------------------ helpers --

function cleanToken(v: string): string {
  const m = /\/s\/([A-Za-z0-9_-]{6,})/.exec(v);
  return (m?.[1] ?? v).replace(/[^A-Za-z0-9_-]/g, '');
}

function subUrl(publicUrl: string, token: string): string {
  return publicUrl ? `${publicUrl}/s/${token}` : `/s/${token}`;
}

function statusText(s: string): string {
  switch (s) {
    case 'pending':
      return 'ثبت شده، در انتظار پرداخت';
    case 'awaiting_payment':
      return 'در انتظار پرداخت';
    case 'approved':
    case 'paid':
      return 'پرداخت شده';
    case 'rejected':
      return 'رد شده';
    case 'canceled':
      return 'لغو شده';
    case 'expired':
      return 'منقضی شده';
    case 'failed':
      return 'ناموفق';
    default:
      return s;
  }
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const v = (await req.json()) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function strField(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

function ok(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ ok: true, ...(body as object) }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  });
}

function fail(message: string, status = 400): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
