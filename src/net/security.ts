/**
 * HTTP security layer: response headers, Same-Origin checks for mutating
 * requests, and a KV-backed rate limiter.
 *
 * Rate limits live in KV rather than a Durable Object so they survive isolate
 * eviction and work across colo boundaries. The counters are coarse by design:
 * KV is eventually consistent, so these are abuse brakes, not exact quotas.
 */
import { newId } from '../utils';

export const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'x-xss-protection': '0',
};

/**
 * CSP. Deliberately strict: no unsafe-eval, no wildcard script sources.
 * The panel is served from the same origin, so 'self' is enough.
 */
export function contentSecurityPolicy(opts: { allowImages?: boolean } = {}): string {
  const img = opts.allowImages ? "'self' data: blob: https:" : "'self' data:";
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src ${img}`,
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join('; ');
}

export function withSecurityHeaders(res: Response, opts: { cors?: boolean; csp?: boolean } = {}): Response {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!h.has(k)) h.set(k, v);
  if (opts.csp !== false) h.set('content-security-policy', contentSecurityPolicy());
  h.set('x-request-id', newId());
  if (opts.cors) {
    h.set('access-control-allow-origin', '*');
    h.set('access-control-allow-methods', 'GET,OPTIONS');
    h.set('access-control-max-age', '600');
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

/**
 * Same-Origin enforcement for mutating requests. Cookie-authenticated APIs are
 * otherwise exposed to CSRF; SameSite=Strict already helps, but this is the
 * defence-in-depth layer that also blocks cross-site form posts.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  // Requests with no Origin header come from same-origin navigations, curl, or
  // the Minecraft server's own heartbeat calls. Those are allowed; the cookie
  // is SameSite=Strict so a browser cannot omit Origin on a cross-site POST.
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

export function requireSameOrigin(request: Request): Response | null {
  if (isSameOrigin(request)) return null;
  return json({ error: 'cross_origin_request_blocked' }, 403);
}

// ------------------------------------------------------------- rate limit
export interface RateLimitRule {
  /** KV key prefix. */
  key: string;
  /** Requests allowed inside `windowMs`. */
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  resetMs: number;
  limit: number;
}

/**
 * Token-window limiter. Uses a single KV key per (rule, subject) holding a JSON
 * window. Coarse but adequate: the goal is stopping scripted abuse, not
 * accounting to the request.
 */
export async function rateLimit(
  kv: KVNamespace,
  rule: RateLimitRule,
  subject: string,
  nowMs = Date.now(),
): Promise<RateLimitResult> {
  const kvKey = `rl:${rule.key}:${subject}`;
  const resetMs = rule.windowMs;
  try {
    const raw = await kv.get(kvKey);
    if (!raw) {
      await kv.put(
        kvKey,
        JSON.stringify({ start: nowMs, count: 1 }),
        { expirationTtl: Math.max(60, Math.ceil(rule.windowMs / 1000)) },
      );
      return { ok: true, remaining: rule.limit - 1, resetMs, limit: rule.limit };
    }
    const w = JSON.parse(raw) as { start: number; count: number };
    if (nowMs - w.start >= rule.windowMs) {
      await kv.put(
        kvKey,
        JSON.stringify({ start: nowMs, count: 1 }),
        { expirationTtl: Math.max(60, Math.ceil(rule.windowMs / 1000)) },
      );
      return { ok: true, remaining: rule.limit - 1, resetMs, limit: rule.limit };
    }
    const count = w.count + 1;
    const remaining = Math.max(0, rule.limit - count);
    await kv.put(
      kvKey,
      JSON.stringify({ start: w.start, count }),
      { expirationTtl: Math.max(60, Math.ceil((rule.windowMs - (nowMs - w.start)) / 1000)) },
    );
    return { ok: count <= rule.limit, remaining, resetMs: rule.windowMs - (nowMs - w.start), limit: rule.limit };
  } catch {
    // If KV is unavailable we fail OPEN for reads but the caller should treat a
    // missing limiter as degraded. Failing closed would take the site down.
    return { ok: true, remaining: rule.limit, resetMs, limit: rule.limit };
  }
}

export function rateLimitHeaders(r: RateLimitResult): Record<string, string> {
  return {
    'ratelimit-limit': String(r.limit),
    'ratelimit-remaining': String(r.remaining),
    'retry-after': String(Math.ceil(r.resetMs / 1000)),
  };
}

// ----------------------------------------------------------------- errors
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function err(code: string, status: number, extra: Record<string, unknown> = {}): Response {
  return json({ error: code, ...extra }, status);
}

/** Client IP, respecting the CF-Connecting-IP header set by the edge. */
export function clientIp(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    '0.0.0.0'
  );
}

/** Two-letter country from the edge, used for Iran latency calibration. */
export function clientCountry(request: Request): string {
  return request.headers.get('cf-ipcountry') ?? '';
}

/** Best-effort user agent, truncated so it cannot bloat the DB. */
export function userAgent(request: Request): string {
  return (request.headers.get('user-agent') ?? '').slice(0, 200);
}

export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T | null> {
  try {
    const ct = request.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) return (await request.json()) as T;
    if (ct.includes('application/x-www-form-urlencoded')) {
      const form = await request.formData();
      const out: Record<string, string> = {};
      for (const [k, v] of form.entries()) out[k] = String(v);
      return out as unknown as T;
    }
    return null;
  } catch {
    return null;
  }
}
