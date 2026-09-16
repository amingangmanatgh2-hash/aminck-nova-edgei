/**
 * End-to-end tests against the REAL Worker (src/index.ts) running in Miniflare
 * with real D1, KV and R2 bindings. Nothing here is mocked out.
 */
import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exec } from './helpers';
import { seedCatalogue, seedSettings } from '../src/db/seed';

let mf: Miniflare;
const BUNDLE_DIR = join(process.cwd(), '.nova-test-workdir');
const BUNDLE = join(BUNDLE_DIR, 'worker.mjs');

const ORIGIN = 'https://example.test';

beforeAll(async () => {
  // Miniflare executes plain JS, so bundle the TypeScript entrypoint first.
  mkdirSync(BUNDLE_DIR, { recursive: true });
  const res = await build({
    entryPoints: ['src/index.ts'],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'neutral',
    outfile: BUNDLE,
    external: ['cloudflare:workers'],
  });
  if (res.errors.length) throw new Error(JSON.stringify(res.errors));

  mf = new Miniflare({
    modules: true,
    scriptPath: BUNDLE,
    compatibilityDate: '2026-08-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: { GODDB: 'it-db' },
    kvNamespaces: { GODKV: 'it-kv' },
    r2Buckets: { GODR2: 'it-r2' },
    durableObjects: {
      SERVER_LOCK: 'ServerLock',
      MATCHMAKER: 'Matchmaker',
      ANTICHEAT: 'AntiCheatOracle',
    },
    bindings: {
      ADMIN_PASSWORD: 'super-secret-admin-pw',
      SESSION_SECRET: 'session-secret-for-tests',
      OTP_SECRET: 'otp-secret-for-tests',
      SERVER_INGEST_SECRET: 'ingest-secret',
      DEBUG_ERRORS: '1',
    },
  });
  const db = await mf.getD1Database('GODDB');
  await exec(db, 'src/db/schema.sql');
  await seedCatalogue(db);
  await seedSettings(db);
}, 90_000);

afterAll(async () => {
  await mf?.dispose();
  rmSync(BUNDLE_DIR, { recursive: true, force: true });
});

async function call(path: string, init: RequestInit = {}, origin = ORIGIN) {
  const incoming = (init.headers as Record<string, string> | undefined) ?? {};
  // A string body without an explicit content-type would not be parsed as JSON
  // by the router, so default it here.
  const needsJson = typeof init.body === 'string' && !('content-type' in incoming);
  const res = await mf.dispatchFetch(`${origin}${path}`, {
    ...init,
    headers: {
      origin,
      ...(needsJson ? { 'content-type': 'application/json' } : {}),
      ...incoming,
    },
  } as Parameters<typeof mf.dispatchFetch>[1]);
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { _text: text.slice(0, 200) };
  }
  if (process.env.DEBUG_API && res.status >= 400) {
    // eslint-disable-next-line no-console
    console.log(`[dbg] ${init.method ?? 'GET'} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  }
  return { status: res.status, body, headers: res.headers, text };
}

/** Full Set-Cookie header, attributes included (for asserting flags). */
const rawCookie = (res: { headers: { get(k: string): string | null } }): string =>
  res.headers.get('set-cookie') ?? '';

/** Just the name=value pair, for sending back on the next request. */
const cookieFrom = (res: { headers: { get(k: string): string | null } }): string =>
  rawCookie(res).split(';')[0] ?? '';

describe('public surface', () => {
  it('serves a health check', async () => {
    const r = await call('/healthz');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it('serves the website HTML', async () => {
    const r = await call('/');
    expect(r.status).toBe(200);
    expect(r.text).toContain('سرور خدای ماینکرفت');
  });

  it('serves the admin panel', async () => {
    const r = await call('/admin');
    expect(r.status).toBe(200);
    expect(r.text).toContain('پنل مدیریت');
  });

  it('adds security headers to every response', async () => {
    const r = await call('/api/status');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  it('returns 404 for unknown routes', async () => {
    const r = await call('/api/does-not-exist');
    expect(r.status).toBe(404);
  });

  it('reports status with modes and ranks', async () => {
    const r = await call('/api/status');
    expect(r.status).toBe(200);
    const modes = r.body.modes as { id: string }[];
    expect(modes.length).toBe(14);
    expect((r.body.ranks as unknown[]).length).toBe(6);
  });

  it('reports Bedrock honestly when it is not exposed', async () => {
    const db = await mf.getD1Database('GODDB');
    await db
      .prepare(
        `INSERT INTO servers (id,name,host,java_port,bedrock_enabled,edition,runtime,status,created_at,updated_at)
         VALUES ('s1','Main','play.test',25565,0,'java','paper','offline',1,1)`,
      )
      .run();
    const r = await call('/api/status');
    const sv = (r.body.servers as { bedrock: unknown; java: unknown }[])[0]!;
    expect(sv.bedrock).toBeNull();
    expect(sv.java).toBeTruthy();
  });
});

describe('shop is gated behind OTP', () => {
  it('shows almost nothing before verification', async () => {
    const r = await call('/api/products/public');
    expect(r.body.gated).toBe(true);
    const prods = r.body.products as { sku: string }[];
    expect(prods.every((p) => p.sku === 'rank-free')).toBe(true);
  });

  it('refuses the full catalogue without a session', async () => {
    const r = await call('/api/products');
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('not_authenticated');
  });
});

describe('OTP login flow', () => {
  it('issues a code, verifies it, and unlocks the shop', async () => {
    const req = await call('/api/auth/otp/request', {
      method: 'POST',
      body: JSON.stringify({ phone: '09123000111' }),
    });
    expect(req.status).toBe(200);
    // No SMS/Telegram provider is configured in tests, so dev mode returns it.
    const code = req.body.devCode as string;
    expect(code).toMatch(/^\d{5}$/);

    const ver = await call('/api/auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ phone: '09123000111', code }),
    });
    expect(ver.status).toBe(200);
    expect(ver.body.ok).toBe(true);
    const cookie = cookieFrom(ver);
    const raw = rawCookie(ver);
    expect(cookie).toContain('god_session=');
    // The security attributes live on the full header, not the split pair.
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('Secure');
    expect(raw).toContain('SameSite=Strict');
    // The session token must be opaque, not the raw phone number.
    expect(cookie).not.toContain('09123000111');

    const me = await call('/api/me', { headers: { cookie } });
    expect(me.status).toBe(200);
    expect((me.body.user as { rankId: string }).rankId).toBe('free');

    const shop = await call('/api/products', { headers: { cookie } });
    expect(shop.status).toBe(200);
    expect(shop.body.gated).toBe(false);
    expect((shop.body.products as unknown[]).length).toBeGreaterThan(20);
  }, 60_000);

  it('rejects a wrong code', async () => {
    await call('/api/auth/otp/request', { method: 'POST', body: JSON.stringify({ phone: '09123000222' }) });
    const bad = await call('/api/auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ phone: '09123000222', code: '00000' }),
    });
    expect(bad.status).toBe(401);
  });
});

describe('CSRF protection', () => {
  it('blocks a cross-origin mutating request', async () => {
    const res = await mf.dispatchFetch(`${ORIGIN}/api/auth/otp/request`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '09123000333' }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('cross_origin_request_blocked');
  });
});

describe('admin panel', () => {
  let adminCookie = '';

  it('rejects a wrong password', async () => {
    const r = await call('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'AMINCK', password: 'wrong' }),
    });
    expect(r.status).toBe(401);
  });

  it('logs the owner in with ADMIN_PASSWORD and bootstraps the admin row', async () => {
    const r = await call('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'AMINCK', password: 'super-secret-admin-pw' }),
    });
    expect(r.status).toBe(200);
    expect(r.body.role).toBe('owner');
    adminCookie = cookieFrom(r);
    expect(adminCookie).toContain('god_admin=');

    const db = await mf.getD1Database('GODDB');
    const { results } = await db.prepare("SELECT role FROM admins WHERE username='AMINCK'").all<{ role: string }>();
    expect(results![0]!.role).toBe('owner');
  });

  it('refuses the overview without a session', async () => {
    expect((await call('/api/admin/overview')).status).toBe(401);
  });

  it('serves the dashboard overview', async () => {
    const r = await call('/api/admin/overview', { headers: { cookie: adminCookie } });
    expect(r.status).toBe(200);
    expect((r.body.stats as { users: number }).users).toBeGreaterThan(0);
  });

  it('round-trips settings and never echoes the card number', async () => {
    const put = await call('/api/admin/settings', {
      method: 'PUT',
      headers: { cookie: adminCookie },
      body: JSON.stringify({
        serverName: 'تست سرور',
        serverIp: 'play.test.com',
        cardNumber: '6037991234567890',
        cardHolder: 'امین',
        card2cardEnabled: true,
      }),
    });
    expect(put.status).toBe(200);
    const s = put.body.settings as { serverName: string; cardNumber: string };
    expect(s.serverName).toBe('تست سرور');
    expect(s.cardNumber).toContain('*');
    expect(s.cardNumber).not.toContain('6037991234567890');

    const get = await call('/api/admin/settings', { headers: { cookie: adminCookie } });
    expect((get.body.settings as { cardNumber: string }).cardNumber).toContain('*');
  });

  it('records a permanent ban with the admin as actor', async () => {
    const db = await mf.getD1Database('GODDB');
    await db
      .prepare(
        `INSERT INTO players (id, server_id, mc_uuid, mc_name, edition, online, created_at)
         VALUES ('pl1','s1','069a79f4-44e9-4726-a5be-fca90e38aaf5','Cheater','java',0,1)`,
      )
      .run();
    const r = await call('/api/admin/ban/permanent', {
      method: 'POST',
      headers: { cookie: adminCookie },
      body: JSON.stringify({ playerId: 'pl1', reason: 'confirmed after evidence review' }),
    });
    expect(r.status).toBe(200);
    expect(r.body.permanent).toBe(true);

    const { results } = await db.prepare('SELECT actor, action FROM audit_logs ORDER BY created_at DESC LIMIT 1').all<{ actor: string; action: string }>();
    expect(results![0]!.action).toBe('ban.permanent');

    const { results: bans } = await db.prepare("SELECT temp FROM bans WHERE player_id='pl1'").all<{ temp: number }>();
    expect(bans![0]!.temp).toBe(0);
  });
});

describe('game runtime ingest', () => {
  it('rejects a heartbeat without the shared secret', async () => {
    const r = await call('/api/server/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ serverId: 's1', players: 3 }),
    });
    expect(r.status).toBe(401);
  });

  it('accepts a heartbeat with the secret and updates the server', async () => {
    const r = await call('/api/server/heartbeat', {
      method: 'POST',
      headers: { 'x-server-secret': 'ingest-secret' },
      body: JSON.stringify({ serverId: 's1', players: 12, tps: 19.5, memUsedMb: 900, memMaxMb: 2048 }),
    });
    expect(r.status).toBe(200);
    const st = await call('/api/status');
    const sv = (st.body.servers as { onlinePlayers: number; status: string }[])[0]!;
    expect(sv.onlinePlayers).toBe(12);
    expect(sv.status).toBe('online');
  });

  it('rejects an unknown server id', async () => {
    const r = await call('/api/server/heartbeat', {
      method: 'POST',
      headers: { 'x-server-secret': 'ingest-secret' },
      body: JSON.stringify({ serverId: 'ghost', players: 1 }),
    });
    expect(r.status).toBe(404);
  });

  it('validates a Minecraft username before storing a player', async () => {
    const bad = await call('/api/server/player', {
      method: 'POST',
      headers: { 'x-server-secret': 'ingest-secret' },
      body: JSON.stringify({ serverId: 's1', mcUuid: 'x'.repeat(32), mcName: 'a b' }),
    });
    expect(bad.status).toBe(400);

    const good = await call('/api/server/player', {
      method: 'POST',
      headers: { 'x-server-secret': 'ingest-secret' },
      body: JSON.stringify({
        serverId: 's1',
        mcUuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5',
        mcName: 'Notch',
      }),
    });
    expect(good.status).toBe(200);
  });
});
