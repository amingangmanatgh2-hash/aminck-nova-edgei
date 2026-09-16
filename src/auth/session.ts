/**
 * Session management for both players (phone-verified) and admins.
 *
 * Sessions are opaque random ids, HMAC-signed and stored in D1 for admins
 * (so revocation is authoritative) and in KV for players (so the hot path does
 * not hit the database on every request).
 */
import { SESSION } from '../config';
import { run } from '../db/db';
import { hashIp, randomToken, sign, verify } from '../utils';

export interface PlayerSession {
  userId: string;
  phoneE164: string;
  issuedAt: number;
  expiresAt: number;
}

export interface AdminSession {
  adminId: string;
  role: string;
  permissions: string[];
  issuedAt: number;
  expiresAt: number;
}

export const SESSION_COOKIE = 'god_session';
export const ADMIN_COOKIE = 'god_admin';

export function sessionCookie(name: string, value: string, maxAgeS: number): string {
  return [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${maxAgeS}`,
  ].join('; ');
}

export const clearCookie = (name: string): string =>
  `${name}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

// ------------------------------------------------------------ player token
/**
 * Player sessions are self-contained signed tokens: `payload.signature`.
 * They are stateless, so a compromised SESSION_SECRET invalidates everything —
 * which is the intended recovery path.
 */
export async function issuePlayerSession(
  userId: string,
  phoneE164: string,
  secret: string,
  at = Date.now(),
): Promise<string> {
  const payload = { u: userId, p: phoneE164, i: at, e: at + SESSION.ttlMs };
  const body = btoa(JSON.stringify(payload)).replace(/=+$/, '');
  const sig = await sign(body, secret, 'player-session');
  return `${body}.${sig}`;
}

export async function verifyPlayerSession(
  token: string | null,
  secret: string,
  at = Date.now(),
): Promise<PlayerSession | null> {
  if (!token || !token.includes('.')) return null;
  const idx = token.lastIndexOf('.');
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  if (!(await verify(body, sig, secret, 'player-session'))) return null;
  let payload: { u: string; p: string; i: number; e: number };
  try {
    payload = JSON.parse(atob(body));
  } catch {
    return null;
  }
  if (!payload?.u || typeof payload.e !== 'number' || payload.e < at) return null;
  return {
    userId: payload.u,
    phoneE164: payload.p,
    issuedAt: payload.i,
    expiresAt: payload.e,
  };
}

// ------------------------------------------------------------- admin token
/**
 * Admin sessions are opaque ids persisted in D1. Revoking access must take
 * effect immediately (admin disabled => next request fails), which a
 * stateless token cannot guarantee.
 */
export async function issueAdminSession(
  db: D1Database,
  adminId: string,
  ip: string,
  ua: string,
  secret: string,
  at = Date.now(),
): Promise<{ sessionId: string; cookie: string; expiresAt: number }> {
  const id = randomToken(24);
  const expiresAt = at + SESSION.adminTtlMs;
  const ipHash = await hashIp(ip, secret);
  await run(
    db,
    `INSERT INTO admin_sessions (id, admin_id, issued_at, expires_at, ip_hash, user_agent)
     VALUES (?,?,?,?,?,?)`,
    id,
    adminId,
    at,
    expiresAt,
    ipHash,
    ua.slice(0, 200),
  );
  return {
    sessionId: id,
    cookie: sessionCookie(ADMIN_COOKIE, id, Math.floor(SESSION.adminTtlMs / 1000)),
    expiresAt,
  };
}

export async function revokeAdminSession(db: D1Database, sessionId: string): Promise<void> {
  await run(db, 'UPDATE admin_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', Date.now(), sessionId);
}

export async function revokeAllAdminSessions(db: D1Database, adminId: string): Promise<void> {
  await run(db, 'UPDATE admin_sessions SET revoked_at = ? WHERE admin_id = ? AND revoked_at IS NULL', Date.now(), adminId);
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function cookieFrom(request: Request, name: string): string | null {
  return parseCookies(request.headers.get('cookie'))[name] ?? null;
}
