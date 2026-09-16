/**
 * One-time-password authentication.
 *
 * Flow: phone -> request code -> verify code -> session. Codes are never
 * stored in the clear: only an HMAC of the code, so a database leak cannot be
 * replayed. Delivery is pluggable (Telegram bot, SMS gateway, or dev mode that
 * returns the code to the caller when no provider is configured).
 *
 * Anti-abuse: per-phone and per-IP request caps, attempt caps, resend cooldown,
 * and an IP-cluster heuristic that raises a fraud alert when many distinct
 * numbers are verified from one address.
 */
import { OTP } from '../config';
import { fraudAlert, run } from '../db/db';
import { hashIp, hashPhone, isValidIranPhone, newId, normalizePhone, now, randomHex, sign, timingSafeEqual } from '../utils';

export type OtpChannel = 'telegram' | 'sms' | 'dev';

export interface OtpSendResult {
  ok: boolean;
  channel: OtpChannel;
  reason?: string;
  retryAfterMs?: number;
  /** Only populated in dev mode, when no delivery provider is configured. */
  devCode?: string;
}

export interface OtpVerifyResult {
  ok: boolean;
  phoneE164?: string;
  reason?: string;
  retryAfterMs?: number;
  attemptsLeft?: number;
}

export interface OtpDeps {
  db: D1Database;
  kv: KVNamespace;
  otpSecret: string;
  telegramBotToken?: string;
  telegramOwnerChatId?: string;
  smsProviderKey?: string;
  /** When true the generated code is returned to the caller (local dev only). */
  devMode: boolean;
  /** Injectable for tests. */
  send?: (phone: string, code: string, channel: OtpChannel) => Promise<boolean>;
  fetchImpl?: typeof fetch;
}

const kvKey = (phoneHash: string): string => `otp:${phoneHash}`;

interface StoredChallenge {
  codeHash: string;
  attempts: number;
  createdAt: number;
  expiresAt: number;
  channel: OtpChannel;
  lastSentAt: number;
}

function generateCode(): string {
  // Numeric only, fixed width, generated from crypto RNG.
  const bytes = new Uint8Array(OTP.codeLength);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < OTP.codeLength; i++) out += String(bytes[i]! % 10);
  return out;
}

const codeHash = (phone: string, code: string, secret: string): Promise<string> =>
  sign(`${phone}:${code}`, secret, 'otp');

async function recordAttempt(
  db: D1Database,
  phoneHash: string,
  ipHash: string,
  stage: 'request' | 'verify',
  ok: boolean,
): Promise<void> {
  await run(
    db,
    'INSERT INTO otp_attempts (id, phone_hash, ip_hash, stage, ok, created_at) VALUES (?,?,?,?,?,?)',
    newId(),
    phoneHash,
    ipHash,
    stage,
    ok ? 1 : 0,
    now(),
  );
}

/** Count events in a window using the KV counter (cheap, TTL-cleaned). */
async function bumpCounter(kv: KVNamespace, key: string, windowMs: number): Promise<number> {
  const cur = Number((await kv.get(key)) ?? '0');
  const next = cur + 1;
  await kv.put(key, String(next), { expirationTtl: Math.max(60, Math.ceil(windowMs / 1000)) });
  return next;
}

/** Distinct phones seen from this IP inside the cluster window. */
async function trackIpCluster(kv: KVNamespace, ipHash: string, phoneHash: string): Promise<number> {
  const key = `ipcluster:${ipHash}`;
  const raw = await kv.get<{ start: number; phones: string[] }>(key, 'json');
  const t = now();
  if (!raw || t - raw.start >= OTP.ipClusterWindowMs) {
    await kv.put(key, JSON.stringify({ start: t, phones: [phoneHash] }), {
      expirationTtl: Math.ceil(OTP.ipClusterWindowMs / 1000),
    });
    return 1;
  }
  const phones = raw.phones.includes(phoneHash) ? raw.phones : [...raw.phones, phoneHash];
  await kv.put(key, JSON.stringify({ start: raw.start, phones }), {
    expirationTtl: Math.max(60, Math.ceil((OTP.ipClusterWindowMs - (t - raw.start)) / 1000)),
  });
  return phones.length;
}

// --------------------------------------------------------------- delivery
async function sendViaTelegram(
  deps: OtpDeps,
  phone: string,
  code: string,
): Promise<boolean> {
  if (!deps.telegramBotToken || !deps.telegramOwnerChatId) return false;
  const f = deps.fetchImpl ?? fetch;
  try {
    const res = await f(`https://api.telegram.org/bot${deps.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: deps.telegramOwnerChatId,
        text: `New login request\nPhone: ${phone}\nCode: ${code}\nExpires in ${Math.round(OTP.ttlMs / 60000)} min`,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function sendViaSms(deps: OtpDeps, phone: string, code: string): Promise<boolean> {
  if (!deps.smsProviderKey) return false;
  const f = deps.fetchImpl ?? fetch;
  try {
    const res = await f('https://api.smsprovider.example/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${deps.smsProviderKey}` },
      body: JSON.stringify({ to: phone, message: `Your code is ${code}` }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------- public
export async function requestOtp(deps: OtpDeps, rawPhone: string, ip: string): Promise<OtpSendResult> {
  const phone = normalizePhone(rawPhone);
  if (!isValidIranPhone(phone)) {
    return { ok: false, channel: 'dev', reason: 'invalid_phone_number' };
  }

  const secret = deps.otpSecret;
  const phoneHash = await hashPhone(phone, secret);
  const ipHash = await hashIp(ip, secret);

  // --- per-phone rate limit
  const phoneCount = await bumpCounter(deps.kv, `otprq:p:${phoneHash}`, 3600_000);
  if (phoneCount > OTP.maxRequestsPerPhonePerHour) {
    return { ok: false, channel: 'dev', reason: 'too_many_requests_phone', retryAfterMs: 3600_000 };
  }

  // --- per-IP rate limit
  const ipCount = await bumpCounter(deps.kv, `otprq:i:${ipHash}`, 3600_000);
  if (ipCount > OTP.maxRequestsPerIpPerHour) {
    return { ok: false, channel: 'dev', reason: 'too_many_requests_ip', retryAfterMs: 3600_000 };
  }

  // --- resend cooldown
  const existing = await deps.kv.get<StoredChallenge>(kvKey(phoneHash), 'json');
  const t = now();
  if (existing && t - existing.lastSentAt < OTP.resendCooldownMs) {
    return {
      ok: false,
      channel: existing.channel,
      reason: 'resend_cooldown',
      retryAfterMs: OTP.resendCooldownMs - (t - existing.lastSentAt),
    };
  }

  const code = generateCode();
  const ch = await codeHash(phone, code, secret);

  // --- choose a delivery channel, in order of preference
  let channel: OtpChannel = 'dev';
  let delivered = false;
  if (deps.telegramBotToken && deps.telegramOwnerChatId) {
    channel = 'telegram';
    delivered = await sendViaTelegram(deps, phone, code);
  }
  if (!delivered && deps.smsProviderKey) {
    channel = 'sms';
    delivered = await sendViaSms(deps, phone, code);
  }
  if (!delivered) {
    if (deps.send) {
      channel = 'dev';
      delivered = await deps.send(phone, code, 'dev');
    }
    // If nothing is configured we fall back to dev mode. This is intentional
    // for local development; in production at least one provider must be set,
    // otherwise codes would never reach the user.
  }

  const challenge: StoredChallenge = {
    codeHash: ch,
    attempts: 0,
    createdAt: t,
    expiresAt: t + OTP.ttlMs,
    channel,
    lastSentAt: t,
  };
  await deps.kv.put(kvKey(phoneHash), JSON.stringify(challenge), {
    expirationTtl: Math.ceil(OTP.ttlMs / 1000) + 60,
  });

  await recordAttempt(deps.db, phoneHash, ipHash, 'request', delivered);

  return delivered || deps.devMode
    ? { ok: true, channel, devCode: deps.devMode ? code : undefined }
    : { ok: false, channel, reason: 'delivery_unavailable' };
}

export async function verifyOtp(
  deps: OtpDeps,
  rawPhone: string,
  code: string,
  ip: string,
): Promise<OtpVerifyResult> {
  const phone = normalizePhone(rawPhone);
  if (!isValidIranPhone(phone)) return { ok: false, reason: 'invalid_phone_number' };

  const secret = deps.otpSecret;
  const phoneHash = await hashPhone(phone, secret);
  const ipHash = await hashIp(ip, secret);

  const challenge = await deps.kv.get<StoredChallenge>(kvKey(phoneHash), 'json');
  if (!challenge) return { ok: false, reason: 'no_challenge' };
  if (now() > challenge.expiresAt) {
    await deps.kv.delete(kvKey(phoneHash));
    return { ok: false, reason: 'expired' };
  }

  const expected = await codeHash(phone, code.trim(), secret);
  const ok = timingSafeEqual(expected, challenge.codeHash);

  if (!ok) {
    challenge.attempts += 1;
    const attemptsLeft = OTP.maxVerifyAttempts - challenge.attempts;
    if (attemptsLeft <= 0) {
      await deps.kv.delete(kvKey(phoneHash));
      await recordAttempt(deps.db, phoneHash, ipHash, 'verify', false);
      return { ok: false, reason: 'too_many_attempts', attemptsLeft: 0 };
    }
    await deps.kv.put(kvKey(phoneHash), JSON.stringify(challenge), {
      expirationTtl: Math.max(60, Math.ceil((challenge.expiresAt - now()) / 1000)),
    });
    await recordAttempt(deps.db, phoneHash, ipHash, 'verify', false);
    return { ok: false, reason: 'invalid_code', attemptsLeft };
  }

  // Success: burn the challenge so it cannot be replayed.
  await deps.kv.delete(kvKey(phoneHash));
  await recordAttempt(deps.db, phoneHash, ipHash, 'verify', true);

  // --- IP cluster fraud heuristic
  const distinct = await trackIpCluster(deps.kv, ipHash, phoneHash);
  if (distinct >= OTP.ipClusterThreshold) {
    await fraudAlert(deps.db, {
      kind: 'ip_cluster',
      severity: distinct >= OTP.ipClusterThreshold * 2 ? 'critical' : 'warn',
      subject: ipHash,
      detail: `${distinct} distinct phone numbers verified from one IP inside ${Math.round(OTP.ipClusterWindowMs / 60000)} minutes`,
    });
  }

  return { ok: true, phoneE164: phone };
}

export const testHelpers = { generateCode, codeHash, kvKey };
