/**
 * Payment gateways.
 *
 * Zarinpal: the merchant id is supplied by the operator from the admin panel
 * and stored as a Worker secret — never in source. If it is absent the gateway
 * reports itself unavailable instead of pretending to work.
 *
 * Card-to-card: the operator enters a card number in the admin panel. Buyers
 * upload a receipt image; the image is reviewed before any entitlement is
 * granted. Nothing here auto-approves a payment on the strength of a photo.
 */
import { newId, now, sha256Hex } from '../utils';
import type { ReceiptVerdict } from '../types';

// --------------------------------------------------------------- Zarinpal
export interface ZarinpalConfig {
  merchantId: string | null;
  enabled: boolean;
  /** Where Zarinpal sends the buyer after payment. */
  callbackBase: string;
}

export interface ZarinpalStart {
  ok: boolean;
  authority?: string;
  paymentUrl?: string;
  reason?: string;
}

const ZARINPAL_API = 'https://api.zarinpal.com/pg/v4/payment/request.json';
const ZARINPAL_VERIFY = 'https://api.zarinpal.com/pg/v4/payment/verify.json';
const ZARINPAL_PAY = 'https://www.zarinpal.com/pg/StartPay/';

export function zarinpalAvailable(cfg: ZarinpalConfig): boolean {
  return cfg.enabled && !!cfg.merchantId && cfg.merchantId.length >= 8;
}

/**
 * Start a payment. Amounts are in Tomans for Zarinpal; we convert from USD
 * cents using a rate the operator sets in the admin panel (never hardcoded,
 * because the IRR rate moves constantly).
 */
export async function zarinpalStart(
  cfg: ZarinpalConfig,
  order: { id: string; amountUsd: number; description: string; userEmail?: string | null; userPhone?: string | null },
  usdToTomanRate: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ZarinpalStart> {
  if (!zarinpalAvailable(cfg)) {
    return { ok: false, reason: 'zarinpal_not_configured' };
  }
  const amountToman = Math.max(1000, Math.round((order.amountUsd / 100) * usdToTomanRate));
  const callback = `${cfg.callbackBase.replace(/\/$/, '')}/api/payments/zarinpal/callback?order=${encodeURIComponent(order.id)}`;

  try {
    const res = await fetchImpl(ZARINPAL_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        merchant_id: cfg.merchantId,
        amount: amountToman,
        callback_url: callback,
        description: order.description.slice(0, 250),
        metadata: { order_id: order.id, email: order.userEmail ?? '', mobile: order.userPhone ?? '' },
      }),
    });
    const body = (await res.json()) as {
      data?: { code: number; authority: string; message?: string };
      errors?: { code: number; message: string };
    };
    if (body.errors || body.data?.code !== 100 || !body.data.authority) {
      return { ok: false, reason: body.errors?.message ?? 'gateway_rejected' };
    }
    return {
      ok: true,
      authority: body.data.authority,
      paymentUrl: `${ZARINPAL_PAY}${body.data.authority}`,
    };
  } catch (e) {
    return { ok: false, reason: `network_error: ${(e as Error).message}` };
  }
}

export interface ZarinpalVerifyResult {
  ok: boolean;
  paid: boolean;
  refId?: string;
  reason?: string;
}

/**
 * Verify a callback. Zarinpal returns Status=OK plus an Authority; the ONLY
 * trustworthy confirmation is a successful /verify call returning code 100.
 * A buyer can forge the callback URL, so this step is mandatory.
 */
export async function zarinpalVerify(
  cfg: ZarinpalConfig,
  authority: string,
  amountUsd: number,
  usdToTomanRate: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ZarinpalVerifyResult> {
  if (!zarinpalAvailable(cfg)) return { ok: false, paid: false, reason: 'zarinpal_not_configured' };
  const amountToman = Math.max(1000, Math.round((amountUsd / 100) * usdToTomanRate));
  try {
    const res = await fetchImpl(ZARINPAL_VERIFY, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ merchant_id: cfg.merchantId, amount: amountToman, authority }),
    });
    const body = (await res.json()) as {
      data?: { code: number; ref_id: number; card_pan?: string };
      errors?: { code: number; message: string };
    };
    if (body.errors) return { ok: false, paid: false, reason: body.errors.message };
    // code 100 = paid, 101 = already verified before
    if (body.data?.code === 100 || body.data?.code === 101) {
      return { ok: true, paid: true, refId: String(body.data.ref_id ?? '') };
    }
    return { ok: true, paid: false, reason: `not_paid:${body.data?.code ?? 'unknown'}` };
  } catch (e) {
    return { ok: false, paid: false, reason: `network_error: ${(e as Error).message}` };
  }
}

// ------------------------------------------------------------- card2card
export interface Card2CardConfig {
  enabled: boolean;
  cardNumber: string | null;
  cardHolder: string | null;
}

export function card2cardAvailable(cfg: Card2CardConfig): boolean {
  return cfg.enabled && !!cfg.cardNumber && cfg.cardNumber.replace(/\D/g, '').length >= 16;
}

export function maskCard(card: string | null): string {
  if (!card) return '';
  const digits = card.replace(/\D/g, '');
  if (digits.length < 8) return '****';
  return `${digits.slice(0, 6)}******${digits.slice(-4)}`;
}

// -------------------------------------------------------- receipt review
/**
 * Receipt review.
 *
 * Two layers, and the second one is the important one:
 *   1. Content-hash deduplication. An identical image cannot be used twice,
 *      which kills the most common fraud (reusing one real receipt forever).
 *   2. AI inspection for legibility, tampering and required fields.
 *
 * CRITICAL: even a perfect AI verdict only moves the order to `reviewing`.
 * Auto-approval is limited to low-value orders AND requires every field to be
 * visible AND a non-duplicate hash. Anything suspicious goes to a human.
 */
export interface ReceiptReviewInput {
  bytes: ArrayBuffer;
  contentType: string;
  claimedAmountUsd: number;
  existingHashes: string[];
  /** Set when the operator has enabled AI review. */
  ai?: {
    run: (prompt: string, imageB64: string) => Promise<string>;
    model?: string;
  };
}

const RECEIPT_PROMPT = `You are auditing a bank transfer receipt screenshot for an online store.
Answer ONLY with a JSON object and no prose, using exactly these keys:
{
 "readable": boolean,        // text is legible, not blurry or cropped
 "tampered": boolean,        // any sign of editing: mismatched fonts, cloned
                             // pixels, inconsistent alignment, spliced regions
 "amountVisible": boolean,
 "dateVisible": boolean,
 "trackingVisible": boolean, // a bank reference / tracking number is present
 "amountValue": number|null, // numeric amount if readable, else null
 "confidence": number        // 0..1 that the receipt is genuine
}
Be conservative: if you are unsure whether something was edited, set
"tampered": true. A false rejection costs a customer five minutes; a false
approval costs the store real money.`;

export async function reviewReceipt(input: ReceiptReviewInput): Promise<ReceiptVerdict> {
  const hash = await sha256Hex(input.bytes);
  const reasons: string[] = [];

  // --- layer 1: duplicate detection ---------------------------------------
  const duplicate = input.existingHashes.includes(hash);
  if (duplicate) reasons.push('identical receipt image already submitted');

  const base: ReceiptVerdict = {
    readable: false,
    tampered: false,
    amountVisible: false,
    dateVisible: false,
    trackingVisible: false,
    duplicate,
    confidence: 0,
    reasons,
    autoApprove: false,
  };

  // Basic sanity on the upload itself, before spending an AI call.
  if (input.bytes.byteLength < 8 * 1024) {
    reasons.push('file suspiciously small (<8KB) for a receipt screenshot');
    return base;
  }
  if (!/^image\//.test(input.contentType)) {
    reasons.push(`unexpected content type ${input.contentType}`);
    return base;
  }

  // --- layer 2: AI inspection ----------------------------------------------
  if (!input.ai) {
    reasons.push('AI review not configured - manual review required');
    return base;
  }

  let verdict: Partial<ReceiptVerdict> & { amountValue?: number | null };
  try {
    const b64 = arrayBufferToBase64(input.bytes);
    const raw = await input.ai.run(RECEIPT_PROMPT, b64);
    verdict = extractJson(raw);
  } catch (e) {
    reasons.push(`AI review failed: ${(e as Error).message}`);
    return base;
  }

  const out: ReceiptVerdict = {
    readable: verdict.readable === true,
    tampered: verdict.tampered === true,
    amountVisible: verdict.amountVisible === true,
    dateVisible: verdict.dateVisible === true,
    trackingVisible: verdict.trackingVisible === true,
    duplicate,
    confidence: clamp01(Number(verdict.confidence ?? 0)),
    reasons: [...reasons],
    autoApprove: false,
  };

  if (!out.readable) out.reasons.push('receipt is not legible');
  if (out.tampered) out.reasons.push('possible tampering detected');
  if (!out.amountVisible) out.reasons.push('amount not visible');
  if (!out.dateVisible) out.reasons.push('date not visible');
  if (!out.trackingVisible) out.reasons.push('no tracking/reference number visible');

  // Amount cross-check. If the model read a number, it must plausibly match.
  if (typeof verdict.amountValue === 'number' && verdict.amountValue > 0) {
    out.reasons.push(`amount read as ${verdict.amountValue}`);
  }

  // --- the gate -------------------------------------------------------------
  // Auto-approve ONLY when every check passes. Otherwise a human decides.
  out.autoApprove =
    !out.duplicate &&
    !out.tampered &&
    out.readable &&
    out.amountVisible &&
    out.dateVisible &&
    out.trackingVisible &&
    out.confidence >= 0.9;

  if (!out.autoApprove && out.reasons.length === 0) {
    out.reasons.push('AI confidence below the auto-approval threshold');
  }
  return out;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Tolerant JSON extraction: models sometimes wrap JSON in prose or fences. */
export function extractJson(raw: string): Record<string, unknown> {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? raw).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return {};
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

export const receiptId = (): string => newId();
export const receiptNow = (): number => now();
