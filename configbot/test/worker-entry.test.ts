import { describe, it, expect } from 'vitest';
import worker, { adminCookie, type Env } from '../src/index';

/**
 * These drive the real `fetch` handler exported by the Worker.
 *
 * The admin login path was broken in exactly the way that a unit test of
 * `readAdminSession` would never catch: the session check was correct, the
 * allow-list check was correct, and nothing in between ever wrote the cookie —
 * so the panel sat on the login screen forever. Only a request that goes
 * through `fetch` and comes back with a `Set-Cookie` proves the loop closes.
 */

/** A D1 that answers every query with no rows. Enough for the auth paths,
 *  which must succeed or fail without touching the database. */
const emptyDb = {
  prepare() {
    const stmt = {
      bind() {
        return stmt;
      },
      first: async () => null,
      run: async () => ({ meta: {}, results: [] }),
      all: async () => ({ results: [], meta: {} }),
    };
    return stmt;
  },
  batch: async () => [],
} as unknown as Env['DB'];

const env: Env = {
  DB: emptyDb,
  BOT_TOKEN: '123:abc',
  WEBHOOK_SECRET: 'a'.repeat(64),
  ADMIN_USER_IDS: '111,222',
  PUBLIC_URL: 'https://bot.example.workers.dev',
};

const ctx = { waitUntil: () => undefined } as never;

function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return worker.fetch(new Request(`https://bot.example.workers.dev${path}`, { headers }), env, ctx);
}

function cookieOf(res: Response): string {
  return res.headers.get('set-cookie') ?? '';
}

describe('admin login', () => {
  it('shows the login form when there is no session', async () => {
    const res = await get('/admin');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('ورود به پنل مدیریت');
  });

  it('an allowed Telegram id gets a session cookie and a redirect', async () => {
    const res = await get('/admin?tg=111');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin');
    const cookie = cookieOf(res);
    expect(cookie).toContain('admin_session=111');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Path=/admin');
  });

  it('that cookie actually opens the panel on the next request', async () => {
    // This is the assertion the broken version failed: without a cookie being
    // issued, this second request could never succeed.
    const login = await get('/admin?tg=111');
    const cookie = cookieOf(login).split(';')[0]!;
    const panel = await get('/admin', { cookie });
    expect(panel.status).toBe(200);
    expect(await panel.text()).toContain('پنل مدیریت کانفیگ‌بات');
  });

  it('an id that is not on the allow-list is refused', async () => {
    const res = await get('/admin?tg=999');
    expect(res.status).toBe(200); // a form, not a redirect
    expect(cookieOf(res)).toBe('');
    expect(await res.text()).toContain('اجازه‌ی ورود نداری');
  });

  it('the refusal does not confirm whether the panel exists', async () => {
    const wrongId = await (await get('/admin?tg=999')).text();
    const badShape = await (await get('/admin?tg=abc')).text();
    // Same class of message; no "not on the list" vs "malformed" distinction.
    expect(wrongId).toContain('اجازه‌ی ورود نداری');
    expect(badShape).toContain('شناسه باید یک عدد باشد');
  });

  it('a forged cookie for an id outside the allow-list does not work', async () => {
    const res = await get('/admin', { cookie: 'admin_session=999' });
    // Read the body once: a Response body is a stream and cannot be re-read.
    const body = await res.text();
    expect(body).toContain('ورود به پنل مدیریت');
    expect(body).not.toContain('پنل مدیریت کانفیگ‌بات');
  });

  it('logout clears the cookie', async () => {
    const res = await get('/admin/logout', { cookie: 'admin_session=111' });
    expect(cookieOf(res)).toContain('Max-Age=0');
  });

  it('admin API refuses an unauthenticated caller', async () => {
    const res = await get('/admin/api/dashboard');
    expect(res.status).toBe(401);
  });
});

describe('adminCookie', () => {
  it('is scoped, HttpOnly, Secure and expires within a day', async () => {
    const c = adminCookie(111);
    expect(c).toBe(
      'admin_session=111; Path=/admin; HttpOnly; Secure; SameSite=Lax; Max-Age=86400',
    );
  });

  it('the cookie it produces is accepted by the session check', async () => {
    const res = await get('/admin', { cookie: adminCookie(222).split(';')[0]! });
    expect(await res.text()).toContain('پنل مدیریت کانفیگ‌بات');
  });
});

describe('webhook authentication', () => {
  it('refuses to run at all when WEBHOOK_SECRET is unset', async () => {
    const res = await worker.fetch(
      new Request('https://bot.example.workers.dev/webhook', { method: 'POST', body: '{}' }),
      { ...env, WEBHOOK_SECRET: '' },
      ctx,
    );
    expect(res.status).toBe(503);
  });

  it('rejects a request with no secret header', async () => {
    const res = await worker.fetch(
      new Request('https://bot.example.workers.dev/webhook', { method: 'POST', body: '{}' }),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it('rejects a wrong secret', async () => {
    const res = await worker.fetch(
      new Request('https://bot.example.workers.dev/webhook', {
        method: 'POST',
        headers: { 'x-telegram-bot-api-secret-token': 'b'.repeat(64) },
        body: '{"update_id":1}',
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it('rejects a non-POST method', async () => {
    const res = await get('/webhook');
    expect(res.status).toBe(405);
  });

  it('rejects a body with no update_id', async () => {
    const res = await worker.fetch(
      new Request('https://bot.example.workers.dev/webhook', {
        method: 'POST',
        headers: {
          'x-telegram-bot-api-secret-token': env.WEBHOOK_SECRET,
          'content-type': 'application/json',
        },
        body: '{"nope":1}',
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });
});

describe('public routes', () => {
  it('healthz answers without touching the database', async () => {
    const res = await get('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('an unknown subscription token is a 404, not a 500', async () => {
    const res = await get('/s/abcdefghijklmnop');
    expect(res.status).toBe(404);
  });

  it('a too-short token is refused without a query', async () => {
    const res = await get('/s/abc');
    expect(res.status).toBe(404);
  });

  it('robots.txt keeps the admin panel and subscription links out of crawlers', async () => {
    const res = await get('/robots.txt');
    const body = await res.text();
    expect(body).toContain('Disallow: /admin');
    expect(body).toContain('Disallow: /s/');
  });

  it('the mini app ships a CSP that blocks framing from anywhere but Telegram', async () => {
    const res = await get('/app');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('frame-ancestors https://web.telegram.org');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('an unknown path is a JSON 404', async () => {
    const res = await get('/does-not-exist');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false });
  });
});
