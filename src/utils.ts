/**
 * Minecraft God Server — pure helpers. No Cloudflare runtime dependencies so
 * they unit-test directly in Node.
 */

const HEX = '0123456789abcdef';

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < buf.length; i++) out += HEX[buf[i]! >> 4]! + HEX[buf[i]! & 15]!;
  return out;
}

export const newId = (): string => randomHex(12);
export const randomToken = (bytes = 32): string => randomHex(bytes);
export const now = (): number => Date.now();
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function base64Encode(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}

// ------------------------------------------------------------------ crypto
async function hmacKey(secret: string, usage: string): Promise<CryptoKey> {
  const enc = new TextEncoder().encode(`${secret}::${usage}`);
  return crypto.subtle.importKey(
    'raw',
    enc,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function b64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Deterministic HMAC tag. Used for session ids and phone hashing. */
export async function sign(value: string, secret: string, usage: string): Promise<string> {
  const key = await hmacKey(secret, usage);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return b64url(sig);
}

export async function verify(
  value: string,
  tag: string,
  secret: string,
  usage: string,
): Promise<boolean> {
  const expected = await sign(value, secret, usage);
  return timingSafeEqual(expected, tag);
}

/** Never store raw phone numbers in logs / analytics. */
export const hashPhone = (phone: string, secret: string): Promise<string> =>
  sign(normalizePhone(phone), secret, 'phone');

export const hashIp = (ip: string, secret: string): Promise<string> =>
  sign(ip, secret, 'ip');

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface HashedPassword {
  hash: string;
  salt: string;
  iterations: number;
}

const PBKDF2_ITERATIONS = 210_000;

export async function hashPassword(pw: string, salt = randomHex(16)): Promise<HashedPassword> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pw),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return { hash: b64url(bits), salt, iterations: PBKDF2_ITERATIONS };
}

export async function verifyPassword(pw: string, h: HashedPassword): Promise<boolean> {
  const check = await hashPassword(pw, h.salt);
  return timingSafeEqual(check.hash, h.hash);
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = data instanceof Uint8Array ? (data.buffer as ArrayBuffer) : data;
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => HEX[b >> 4]! + HEX[b & 15]!)
    .join('');
}

// -------------------------------------------------------------- phone / IP
/** Accepts Iranian and international formats, normalises to E.164. */
export function normalizePhone(input: string): string {
  // Convert Persian/Arabic digits FIRST. The strip below removes anything that
  // is not an ASCII digit, so doing this after would silently delete them.
  let s = String(input)
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));

  s = s.replace(/[^\d+]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);

  if (s.startsWith('09') && s.length === 11) {
    // Local trunk form: 09123456789 -> drop only the leading trunk zero.
    s = '+98' + s.slice(1);
  } else if (/^9\d{9}$/.test(s)) {
    // Bare 10-digit mobile form: 9123456789
    s = '+98' + s;
  } else if (s.startsWith('98') && s.length === 12) {
    s = '+' + s;
  }
  if (!s.startsWith('+')) s = '+' + s;
  return s;
}

export function isValidIranPhone(e164: string): boolean {
  return /^\+989\d{9}$/.test(e164);
}

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT — very common in Iran
  /^0\./,
];

export function isPrivateIp(ip: string): boolean {
  if (!ip) return true;
  const v = ip.replace(/^\[|\]$/g, '').split('%')[0]!;
  if (v.includes(':')) return v === '::1' || v.toLowerCase().startsWith('fe80') || v === '::';
  return PRIVATE_V4.some((re) => re.test(v));
}

// --------------------------------------------------------------- numbers
/** ELO update with a K-factor that shrinks as players settle. */
export function eloDelta(rating: number, opponent: number, won: boolean, games = 10): number {
  const k = games < 10 ? 40 : games < 50 ? 28 : 20;
  const expected = 1 / (1 + Math.pow(10, (opponent - rating) / 400));
  const actual = won ? 1 : 0;
  return Math.round(k * (actual - expected));
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

/** Coefficient of variation — the autoclicker regularity signal. */
export function coefficientOfVariation(xs: number[]): number {
  const m = mean(xs);
  return m === 0 ? 0 : stddev(xs) / m;
}

// ------------------------------------------------------------ validation
export function sanitizeText(s: unknown, max = 200): string {
  if (typeof s !== 'string') return '';
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, max)
    .trim();
}

/** Minecraft usernames: 3-16 chars, A-Z a-z 0-9 _ (Java) — Bedrock allows spaces. */
export function isValidMcName(name: string, edition: 'java' | 'bedrock' = 'java'): boolean {
  if (edition === 'bedrock') return /^[\w .]{3,20}$/.test(name);
  return /^[A-Za-z0-9_]{3,16}$/.test(name);
}

export function isUuidLike(s: string): boolean {
  return /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(s);
}
