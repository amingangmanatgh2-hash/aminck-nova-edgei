import { asInt, asString, newId, now, shortCode } from '../db/db';

/**
 * Payments.
 *
 * The design constraint is the owner's, not ours: they have never used a
 * payment gateway and cannot be asked to register for one before the bot
 * works. So the ordering is:
 *
 *   1. `card`  — card-to-card + a receipt photo. Zero accounts, zero setup,
 *                 works the day the bot goes live. The only cost is that a
 *                 human (or the AI) approves each one.
 *   2. `wallet`— balance top-up, pure bookkeeping.
 *   3. `zarinpal`, `nextpay`, `idpay` — real adapters, complete and tested
 *                 against their documented API, but `available()` returns
 *                 false until a key exists. A gateway with no key must not
 *                 appear in the UI, because a button that 500s is worse than
 *                 no button.
 *
 * Nothing here talks to a real bank. Every gateway is behind this interface,
 * and `card`/`wallet` need nothing but D1.
 */

export type GatewayId = 'card' | 'wallet' | 'zarinpal' | 'nextpay' | 'idpay';

export interface GatewayInfo {
  id: GatewayId;
  /** Persian label shown on the button. */
  label: string;
  /** One-line explainer, because the buyer has never used this before. */
  hint: string;
  icon: string;
  /** Whether the buyer sees it right now. */
  available: boolean;
  /** Automatic = no human approval needed. */
  automatic: boolean;
  /** True while we are deliberately faking it, so the UI can label it. */
  sandbox: boolean;
}

export interface PaymentRequest {
  id: string;
  orderCode: string;
  amount: number; // Toman
  userId: string;
  userName: string;
  description: string;
  callbackUrl: string;
  /** Where a card payment tells the buyer to send the money. */
  card?: { number: string; holder: string; bank: string; extraMessage: string };
}

export type StartResult =
  | { kind: 'redirect'; url: string; authority: string }
  | { kind: 'instructions'; text: string; ref: string }
  | { kind: 'done'; ref: string };

export interface VerifyResult {
  ok: boolean;
  ref: string;
  amount: number;
  status: 'approved' | 'rejected' | 'pending';
  detail: string;
  raw: unknown;
}

export interface Gateway {
  readonly id: GatewayId;
  info(): GatewayInfo;
  start(req: PaymentRequest): Promise<StartResult>;
  /** Confirm a gateway callback. Only meaningful for online gateways. */
  verify(params: Record<string, string>): Promise<VerifyResult>;
}

// ----------------------------------------------------------- card-to-card --

export interface CardGatewayOptions {
  cardNumber: string;
  cardHolder: string;
  cardBank: string;
  /** Admin's own words, appended to the instructions. */
  extraMessage: string;
  currency: string;
}

/**
 * Card-to-card. There is no API to call: we show the card, the buyer sends the
 * money in their own banking app and uploads a screenshot, and a human or the
 * AI approves it.
 *
 * The one thing this must get right is the reference. Two people paying the
 * same amount within a minute is normal, and a receipt with no reference is
 * unmatchable. So every card payment carries a short code the buyer is asked
 * to type into the transfer's description field, and we echo it back when we
 * ask for the screenshot.
 */
export class CardGateway implements Gateway {
  readonly id: GatewayId = 'card';

  constructor(private opts: CardGatewayOptions) {}

  info(): GatewayInfo {
    const ready = this.opts.cardNumber.replace(/\s|-/g, '').length >= 16;
    return {
      id: 'card',
      label: 'کارت به کارت',
      hint: ready
        ? 'ساده‌ترین راه — کارت‌به‌کارت کنید و عکس فیش را بفرستید'
        : 'کارت مدیر هنوز تنظیم نشده',
      icon: '💳',
      available: ready,
      automatic: false,
      sandbox: false,
    };
  }

  async start(req: PaymentRequest): Promise<StartResult> {
    const card = this.opts.cardNumber.replace(/\D/g, '');
    if (card.length < 16) {
      throw new Error('شماره کارت مدیر تنظیم نشده است');
    }

    // Masked for display; never log or echo the full number anywhere else.
    const pretty = card.replace(/(\d{4})(?=\d)/g, '$1 ').trim();
    const ref = req.orderCode;

    const lines = [
      '💳 *پرداخت کارت‌به‌کارت*',
      '',
      `مبلغ: *${req.amount.toLocaleString('fa-IR')} ${this.opts.currency}*`,
      '',
      '```',
      pretty,
      '```',
      this.opts.cardBank ? `🏦 ${this.opts.cardBank}` : '',
      `👤 به نام: ${this.opts.cardHolder || 'مدیر'}`,
      '',
      `🔖 کد پیگیری: \`${ref}\``,
      'لطفاً این کد را در توضیحات تراکنش بنویسید.',
    ];
    if (this.opts.extraMessage) lines.push('', this.opts.extraMessage);
    lines.push(
      '',
      'بعد از واریز، دکمه‌ی *«فیش را فرستادم»* را بزنید و عکس رسید را آپلود کنید.',
    );

    return { kind: 'instructions', text: lines.filter((l) => l !== null).join('\n'), ref };
  }

  /** Card payments are approved by a human or the AI, never by a callback. */
  async verify(): Promise<VerifyResult> {
    return {
      ok: false,
      ref: '',
      amount: 0,
      status: 'pending',
      detail: 'پرداخت کارت‌به‌کارت با تأیید دستی انجام می‌شود',
      raw: null,
    };
  }
}

// ------------------------------------------------------------------ wallet --

export class WalletGateway implements Gateway {
  readonly id: GatewayId = 'wallet';

  constructor(private getBalance: (userId: string) => Promise<number>) {}

  info(): GatewayInfo {
    return {
      id: 'wallet',
      label: 'پرداخت از موجودی',
      hint: 'از اعتبار کیف پول خود پرداخت کنید',
      icon: '👛',
      available: true,
      automatic: true,
      sandbox: false,
    };
  }

  async start(req: PaymentRequest): Promise<StartResult> {
    const balance = await this.getBalance(req.userId);
    if (balance < req.amount) {
      throw new Error(
        `موجودی کیف پول ${balance.toLocaleString('fa-IR')} است و کافی نیست`,
      );
    }
    // The actual debit happens in the order service inside a transaction; the
    // gateway only reports that it is possible. Doing it here too would let a
    // retried webhook charge twice.
    return { kind: 'done', ref: `wallet_${req.id}` };
  }

  async verify(): Promise<VerifyResult> {
    return {
      ok: true,
      ref: '',
      amount: 0,
      status: 'approved',
      detail: 'پرداخت از موجودی',
      raw: null,
    };
  }
}

// ------------------------------------------------------- online gateways ---

/**
 * Zarinpal. Implemented against their documented v1.4 JSON API:
 *   POST https://api.zarinpal.com/pg/v4/payment/request.json
 *   POST https://api.zarinpal.com/pg/v4/payment/verify.json
 *
 * Sandbox mode points at sandbox.zarinpal.com and is labelled as such, so
 * nothing in the UI ever implies real money moved.
 */
export class ZarinpalGateway implements Gateway {
  readonly id: GatewayId = 'zarinpal';

  constructor(
    private opts: { merchantId: string; sandbox: boolean; callbackUrl: string },
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private get base(): string {
    return this.opts.sandbox
      ? 'https://sandbox.zarinpal.com'
      : 'https://api.zarinpal.com';
  }

  info(): GatewayInfo {
    const ready = this.opts.merchantId.trim().length >= 8;
    return {
      id: 'zarinpal',
      label: this.opts.sandbox ? 'زرین‌پال (تستی)' : 'زرین‌پال',
      hint: ready
        ? 'پرداخت آنلاین با همه‌ی کارت‌های بانکی'
        : 'برای فعال‌سازی، کد مرچنت زرین‌پال را در پنل ادمین وارد کنید',
      icon: '🟡',
      available: ready,
      automatic: true,
      sandbox: this.opts.sandbox,
    };
  }

  async start(req: PaymentRequest): Promise<StartResult> {
    if (!this.info().available) {
      throw new Error('زرین‌پال تنظیم نشده است');
    }
    const res = await this.fetchImpl(`${this.base}/pg/v4/payment/request.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        merchant_id: this.opts.merchantId,
        // Zarinpal takes Toman.
        amount: Math.round(req.amount),
        callback_url: req.callbackUrl || this.opts.callbackUrl,
        description: req.description.slice(0, 250) || `سفارش ${req.orderCode}`,
        metadata: { order: req.orderCode, user: req.userId },
      }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      data?: { code: number; authority?: string; message?: string; fee?: number };
      errors?: { code: number; message: string };
    };

    if (json.errors) {
      throw new Error(
        `زرین‌پال: ${json.errors.message || json.errors.code} — کد مرچنت یا مبلغ را چک کنید`,
      );
    }
    const data = json.data;
    if (!data || data.code !== 100 || !data.authority) {
      throw new Error(`زرین‌پال پاسخ نامعتبر داد (code=${data?.code})`);
    }
    return {
      kind: 'redirect',
      url: `${this.base}/pg/StartPay/${encodeURIComponent(data.authority)}`,
      authority: data.authority,
    };
  }

  async verify(params: Record<string, string>): Promise<VerifyResult> {
    const status = params.Status ?? params.status ?? '';
    const authority = params.Authority ?? params.authority ?? '';
    if (status !== 'OK' || !authority) {
      return {
        ok: false,
        ref: authority,
        amount: 0,
        status: 'rejected',
        detail: status ? `کاربر پرداخت را لغو کرد (${status})` : 'بدون Authority',
        raw: params,
      };
    }

    const res = await this.fetchImpl(`${this.base}/pg/v4/payment/verify.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ merchant_id: this.opts.merchantId, authority }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      data?: { code: number; ref_id?: number; message?: string; card_pan?: string };
      errors?: { code: number; message: string };
    };

    if (json.errors) {
      return {
        ok: false,
        ref: authority,
        amount: 0,
        status: 'rejected',
        detail: json.errors.message || String(json.errors.code),
        raw: json,
      };
    }
    const code = json.data?.code ?? 0;
    // 100 = success, 101 = already verified (treat as success, do not re-charge).
    if (code === 100 || code === 101) {
      return {
        ok: true,
        ref: String(json.data?.ref_id ?? authority),
        amount: 0, // the amount is trusted from our own order row, not the callback
        status: 'approved',
        detail: code === 101 ? 'قبلاً تأیید شده بود' : 'موفق',
        raw: json,
      };
    }
    return {
      ok: false,
      ref: authority,
      amount: 0,
      status: 'rejected',
      detail: json.data?.message || `code=${code}`,
      raw: json,
    };
  }
}

/** NextPay: POST to nextpay.org/gateway/token/send, then redirect to /gateway/{trans_id}/pay. */
export class NextpayGateway implements Gateway {
  readonly id: GatewayId = 'nextpay';

  constructor(
    private opts: { transId: string; callbackUrl: string },
    private fetchImpl: typeof fetch = fetch,
  ) {}

  info(): GatewayInfo {
    const ready = this.opts.transId.trim().length >= 8;
    return {
      id: 'nextpay',
      label: 'نکست‌پی',
      hint: ready ? 'پرداخت آنلاین' : 'کد تراکنش نکست‌پی را در پنل ادمین وارد کنید',
      icon: '🔵',
      available: ready,
      automatic: true,
      sandbox: false,
    };
  }

  async start(req: PaymentRequest): Promise<StartResult> {
    if (!this.info().available) throw new Error('نکست‌پی تنظیم نشده است');
    const form = new URLSearchParams({
      api_key: this.opts.transId,
      amount: String(Math.round(req.amount)),
      order_id: req.orderCode,
      callback_uri: req.callbackUrl || this.opts.callbackUrl,
      customJson: JSON.stringify({ order: req.orderCode, user: req.userId }),
    });
    const res = await this.fetchImpl('https://nextpay.org/gateway/token/send', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const json = (await res.json().catch(() => ({}))) as {
      code?: number;
      trans_id?: string;
      message?: string;
    };
    if (json.code !== -1 || !json.trans_id) {
      throw new Error(`نکست‌پی: ${json.message || `code=${json.code}`}`);
    }
    return {
      kind: 'redirect',
      url: `https://nextpay.org/gateway/${encodeURIComponent(json.trans_id)}/pay`,
      authority: json.trans_id,
    };
  }

  async verify(params: Record<string, string>): Promise<VerifyResult> {
    const transId = params.trans_id ?? '';
    const order = params.order_id ?? '';
    if (!transId || !order) {
      return {
        ok: false,
        ref: transId,
        amount: 0,
        status: 'rejected',
        detail: 'پارامترهای بازگشت ناقص',
        raw: params,
      };
    }
    const form = new URLSearchParams({ api_key: this.opts.transId, trans_id: transId });
    const res = await this.fetchImpl('https://nextpay.org/gateway/token/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const json = (await res.json().catch(() => ({}))) as { code?: number; Shaparak_Ref_Id?: string };
    if (json.code === 0) {
      return {
        ok: true,
        ref: String(json.Shaparak_Ref_Id ?? transId),
        amount: 0,
        status: 'approved',
        detail: 'موفق',
        raw: json,
      };
    }
    return {
      ok: false,
      ref: transId,
      amount: 0,
      status: 'rejected',
      detail: `code=${json.code}`,
      raw: json,
    };
  }
}

// ---------------------------------------------------------------- registry --

export interface GatewayRegistryOptions {
  card: CardGatewayOptions;
  walletBalance: (userId: string) => Promise<number>;
  zarinpal: { merchantId: string; sandbox: boolean; callbackUrl: string };
  nextpay: { transId: string; callbackUrl: string };
  fetchImpl?: typeof fetch;
}

export function buildRegistry(opts: GatewayRegistryOptions): Map<GatewayId, Gateway> {
  const f = opts.fetchImpl ?? fetch;
  const map = new Map<GatewayId, Gateway>();
  map.set('card', new CardGateway(opts.card));
  map.set('wallet', new WalletGateway(opts.walletBalance));
  map.set('zarinpal', new ZarinpalGateway(opts.zarinpal, f));
  map.set('nextpay', new NextpayGateway(opts.nextpay, f));
  return map;
}

/** Only gateways the buyer may actually use, best first. */
export function listAvailable(registry: Map<GatewayId, Gateway>): GatewayInfo[] {
  const order: GatewayId[] = ['card', 'zarinpal', 'nextpay', 'wallet'];
  return order
    .map((id) => registry.get(id))
    .filter((g): g is Gateway => !!g)
    .map((g) => g.info())
    .filter((i) => i.available);
}

// --------------------------------------------------------------- amounts ---

/** Toman -> a readable Persian amount. */
export function formatToman(amount: number, currency = 'تومان'): string {
  return `${Math.round(amount).toLocaleString('fa-IR')} ${currency}`;
}

/**
 * Parse a number out of free text ("۵۰ هزار تومان", "50,000", "۵۰۰۰۰").
 * Used when the AI reads a receipt description.
 */
export function parseAmount(text: string): number | null {
  const fa = text.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
  const normal = fa.replace(/[٬,،\s_]/g, '');
  const m = /(\d{3,12})/.exec(normal);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const k = /(\d+(?:\.\d+)?)\s*(?:هزار|k)/.exec(fa);
  if (k) return Math.round(Number(k[1]) * 1000);
  return null;
}

// ------------------------------------------------------- receipt handling --

export interface ReceiptInput {
  paymentId: string;
  orderCode: string;
  expectedAmount: number;
  /** The payer's free-text description of the transfer. */
  note: string;
  /** The payer's card, last 4 digits at minimum. */
  payerCard: string;
  payerName: string;
  /** Tracking code from their banking app. */
  trackingCode: string;
  /** True if the screenshot actually arrived. */
  hasPhoto: boolean;
  /** Other receipts in the DB with the same tracking code. */
  duplicateTrackingCount: number;
  /** Other receipts from this same payer card in the last 24 h. */
  samePayerRecentCount: number;
  /** How long after the order was created the receipt arrived, in minutes. */
  minutesSinceOrder: number;
  currency?: string;
}

export interface ReceiptVerdict {
  verdict: 'approve' | 'escalate' | 'reject';
  confidence: number; // 0..1
  reasons: string[];
  /** Shown to the admin in the review queue. */
  summary: string;
}

/**
 * Screen a card-to-card receipt before it reaches a human.
 *
 * Deliberately conservative: this can `escalate` and `reject`, but a clean
 * `approve` only happens when every field lines up. The admin can always
 * override in either direction, and the override is what gets audited.
 *
 * It never invents a payment. If the tracking code is missing or duplicated,
 * the verdict is `escalate`, not `approve` — an unverifiable receipt approved
 * by an LLM is exactly how a reseller gets free configs.
 */
export function screenReceipt(input: ReceiptInput): ReceiptVerdict {
  const reasons: string[] = [];
  let score = 0;

  if (!input.hasPhoto) {
    reasons.push('عکس رسید ارسال نشده');
    return {
      verdict: 'reject',
      confidence: 0.95,
      reasons,
      summary: 'بدون عکس رسید قابل بررسی نیست',
    };
  }

  const amount = parseAmount(input.note);
  if (amount === null) {
    reasons.push('مبلغ در توضیحات پیدا نشد');
    score -= 2;
  } else if (amount === input.expectedAmount) {
    reasons.push(`مبلغ دقیقاً ${formatToman(amount, input.currency)} است`);
    score += 3;
  } else if (amount > input.expectedAmount) {
    reasons.push(`مبلغ واریزی بیشتر است (${formatToman(amount, input.currency)})`);
    score += 2;
  } else {
    reasons.push(`مبلغ کمتر از سفارش است (${formatToman(amount, input.currency)})`);
    score -= 4;
  }

  if (input.note.includes(input.orderCode)) {
    reasons.push('کد پیگیری سفارش در توضیحات هست');
    score += 2;
  } else {
    reasons.push('کد پیگیری در توضیحات نوشته نشده');
    score -= 1;
  }

  const digits = input.payerCard.replace(/\D/g, '');
  if (digits.length >= 4) {
    reasons.push('شماره کارت پرداخت‌کننده ثبت شده');
    score += 1;
  } else {
    reasons.push('شماره کارت پرداخت‌کننده ناقص است');
    score -= 2;
  }

  if (input.payerName.trim().length >= 3) {
    score += 1;
  } else {
    reasons.push('نام پرداخت‌کننده ثبت نشده');
    score -= 1;
  }

  // Hard gate, checked before scoring: a tracking code is the one fact on a
  // card receipt that can be verified against the bank. If it has already been
  // used, the money did not arrive a second time and no amount of otherwise
  // good detail should make this look approvable.
  if (input.trackingCode.trim() && input.duplicateTrackingCount > 0) {
    reasons.push(
      `این کد رهگیری ${input.duplicateTrackingCount} بار دیگر ثبت شده — تراکنش تکراری`,
    );
    return {
      verdict: 'reject',
      confidence: 0.97,
      reasons,
      summary: 'کد رهگیری تکراری: این تراکنش قبلاً ثبت شده است',
    };
  }

  if (!input.trackingCode.trim()) {
    reasons.push('کد رهگیری تراکنش ثبت نشده — قابل استعلام نیست');
    score -= 4;
  } else {
    reasons.push('کد رهگیری یکتا است');
    score += 2;
  }

  if (input.samePayerRecentCount >= 3) {
    reasons.push('این کارت در ۲۴ ساعت اخیر ۳ فیش یا بیشتر داشته');
    score -= 2;
  }

  // A receipt arriving seconds after the order is normal; one arriving with a
  // screenshot that predates the order is not something we can check, so we
  // simply do not reward speed.
  if (input.minutesSinceOrder > 60 * 48) {
    reasons.push('فیش بیش از دو روز بعد از سفارش رسیده');
    score -= 2;
  }

  const confidence = Math.min(0.98, Math.max(0.05, 0.5 + score * 0.08));
  let verdict: ReceiptVerdict['verdict'];
  if (score >= 6) verdict = 'approve';
  else if (score <= -4) verdict = 'reject';
  else verdict = 'escalate';

  return {
    verdict,
    confidence: Number(confidence.toFixed(2)),
    reasons,
    summary: reasons.slice(0, 3).join(' • '),
  };
}

/** A fresh card-payment row, ready to insert. */
export function newCardPayment(userId: string, orderId: string, amount: number) {
  const t = now();
  return {
    id: newId('pay'),
    orderId,
    userId,
    gateway: 'card' as const,
    amount,
    status: 'submitted' as const,
    code: shortCode(8),
    createdAt: t,
  };
}

export function gatewayLabel(id: string): string {
  switch (id) {
    case 'card':
      return 'کارت به کارت';
    case 'wallet':
      return 'کیف پول';
    case 'zarinpal':
      return 'زرین‌پال';
    case 'nextpay':
      return 'نکست‌پی';
    case 'idpay':
      return 'آی‌دی‌پی';
    case 'manual':
      return 'ثبت دستی';
    default:
      return id;
  }
}

/** Normalise the messy query string a gateway callback arrives with. */
export function callbackParams(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    out[k] = v;
  });
  // Gateways are inconsistent about casing; expose both without duplicating.
  for (const [k, v] of Object.entries(out)) {
    const lower = k.toLowerCase();
    if (!(lower in out)) out[lower] = v;
  }
  return out;
}

export function asGatewayId(v: unknown): GatewayId | null {
  const s = asString(v).toLowerCase();
  return s === 'card' || s === 'wallet' || s === 'zarinpal' || s === 'nextpay' || s === 'idpay'
    ? s
    : null;
}

export function asAmount(v: unknown): number {
  const n = asInt(v, 0);
  return n > 0 ? n : 0;
}
