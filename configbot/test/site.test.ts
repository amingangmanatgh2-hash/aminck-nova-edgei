import { describe, it, expect, beforeEach, vi } from 'vitest';
import worker, { resetDepsCache, type Env } from '../src/index';
import { orderCookie } from '../src/api/public';

/**
 * The public website and its API, driven through the real `fetch` handler.
 *
 * The thing worth proving here is not that the HTML renders — it is that every
 * control on the page reaches an endpoint that exists. A site with a download
 * button pointing at a 404, or a buy button that posts nowhere, is the exact
 * failure mode this project has already been burned by twice.
 */

interface Row {
  [k: string]: unknown;
}

function makeFakeDb() {
  const tables = new Map<string, Row[]>();
  const ensure = (t: string) => {
    if (!tables.has(t)) tables.set(t, []);
    return tables.get(t)!;
  };

  function matches(row: Row, params: unknown[], sql: string): boolean {
    const where = /WHERE([\s\S]*?)(?:ORDER BY|LIMIT|$)/i.exec(sql)?.[1] ?? '';
    // Bound params: col = ?N
    for (const [, col, idx] of where.matchAll(/(\w+)\s*=\s*\?(\d+)/g)) {
      if (String(row[col!] ?? '') !== String(params[Number(idx) - 1] ?? '')) return false;
    }
    // Literals: col = 0. Without this the fake cannot express `hidden = 0`, so
    // listPlans(false) would return hidden plans too and the test would pass
    // for the wrong reason.
    for (const [, col, lit] of where.matchAll(/(\w+)\s*=\s*(\d+)(?!\d)/g)) {
      if (String(row[col!] ?? '') !== lit) return false;
    }
    return true;
  }

  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const table = /(?:FROM|INTO|UPDATE)\s+(\w+)/.exec(sql)?.[1] ?? '';
      const stmt = {
        bind(...v: unknown[]) {
          bound = v;
          return stmt;
        },
        async first() {
          return ensure(table).filter((r) => matches(r, bound, sql))[0] ?? null;
        },
        async all() {
          return { results: ensure(table).filter((r) => matches(r, bound, sql)), meta: {} };
        },
        async run() {
          if (/^INSERT/i.test(sql.trim())) {
            const row: Row = {};
            const cols = /\(([^)]+)\)\s*VALUES/i.exec(sql)?.[1]?.split(',').map((c) => c.trim()) ?? [];
            cols.forEach((c, i) => {
              row[c] = bound[i] ?? null;
            });
            ensure(table).push(row);
            return { meta: { changes: 1 }, results: [] };
          }
          if (/^UPDATE/i.test(sql.trim())) {
            const rows = ensure(table).filter((r) => matches(r, bound, sql));
            rows.forEach((r) => {
              // /g is required: matchAll throws on a non-global regex.
              const sets = [...sql.matchAll(/SET\s+([\s\S]*?)\s+WHERE/gi)][0]?.[1] ?? '';
              for (const [, col, idx] of sets.matchAll(/(\w+)\s*=\s*\?(\d+)/g)) {
                r[col!] = bound[Number(idx) - 1];
              }
            });
            return { meta: { changes: rows.length }, results: [] };
          }
          return { meta: { changes: 0 }, results: [] };
        },
      };
      return stmt;
    },
    batch: async (s: { run: () => Promise<unknown> }[]) => Promise.all(s.map((x) => x.run())),
  };

  return { db: db as unknown as Env['DB'], tables, ensure };
}

let fake: ReturnType<typeof makeFakeDb>;

beforeEach(() => {
  fake = makeFakeDb();
  resetDepsCache();

  fake.ensure('settings').push({
    id: 1,
    bot_name: 'ConfigBot',
    support_chat: 'https://t.me/support',
    support_channel: 'https://t.me/news',
    currency: 'تومان',
    trial_enabled: 0,
    trial_days: 3,
    trial_traffic_gb: 5,
    referral_enabled: 0,
    referral_percent: 10,
    card_holder: 'علی محمدی',
    card_number: '',
    card_bank: 'ملت',
    payment_message: '',
    subscription_path: '/s',
    sub_base_url: '',
    traffic_overage_per_gb: 0,
    low_balance_warn_percent: 20,
    low_traffic_warn_percent: 15,
    expire_warn_days: 3,
    maintenance_mode: 0,
    maintenance_message: '',
    ai_enabled: 0,
    ai_temperature: 0.4,
    admin_user_ids: '[]',
  });

  fake.ensure('plans').push(
    {
      id: 'p1', slug: 'month', name: 'یک ماهه', price: 90_000, traffic_gb: 50,
      duration_days: 30, max_devices: 2, protocol_filter: '[]', country_filter: '[]',
      hidden: 0, badge: '', sort_order: 1,
    },
    {
      id: 'p2', slug: 'hidden', name: 'پلن مخفی', price: 10, traffic_gb: 1,
      duration_days: 1, max_devices: 1, protocol_filter: '[]', country_filter: '[]',
      hidden: 1, badge: '', sort_order: 9,
    },
  );

  fake.ensure('users').push({
    id: 'usr_1', telegram_id: 111, username: 'ali', first_name: 'علی', balance: 0,
    role: 'user', blocked: 0, referral_code: 'ABC', created_at: Date.now(), updated_at: Date.now(),
  });

  fake.ensure('subscriptions').push({
    id: 'sub_1', token: 'tok_abcdefgh', user_id: 'usr_1', plan_id: 'p1', label: 'اصلی',
    traffic_gb: 50, traffic_used_bytes: 5 * 1024 ** 3, duration_days: 30,
    expires_at: Date.now() + 20 * 86_400_000, status: 'active', format_lock: '',
    rotation_count: 2, last_rotated_at: null, rotate_after_bytes: 0, rotate_after_days: 0,
    created_at: Date.now(), updated_at: Date.now(),
  });

  fake.ensure('credentials').push({
    id: 'cr_1', user_id: 'usr_1', sub_id: 'sub_1', node_id: 'nl1', panel_user_id: 'u',
    uri: 'vless://aaa@1.1.1.1:443?security=reality#nl', watermark: 'a1b2c3',
    remark: 'هلند ۱', traffic_limit_bytes: 0, expires_at: null, status: 'active',
    created_at: Date.now(),
  });
});

function envFor(extra: Partial<Env> = {}): Env {
  return {
    DB: fake.db,
    BOT_TOKEN: '123:abc',
    WEBHOOK_SECRET: 's'.repeat(64),
    ADMIN_USER_IDS: '111',
    PUBLIC_URL: 'https://shop.example.workers.dev',
    ...extra,
  };
}

const ctx = { waitUntil: () => undefined } as never;

function get(path: string, env: Env = envFor(), headers: Record<string, string> = {}) {
  return worker.fetch(
    new Request(`https://shop.example.workers.dev${path}`, { headers }),
    env,
    ctx,
  );
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

// ------------------------------------------------------------------- pages --

describe('the public site', () => {
  it('the landing page renders and shows a real plan from the database', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('یک ماهه');
    expect(html).toContain('ConfigBot');
    // The hidden plan must not be advertised.
    expect(html).not.toContain('پلن مخفی');
  });

  it('links the support chat that is actually configured', async () => {
    const html = await (await get('/')).text();
    expect(html).toContain('https://t.me/support');
  });

  it('the download page lists real clients with real file names', async () => {
    const res = await get('/download');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Hiddify-Windows-Setup-x64.exe');
    expect(html).toContain('Hiddify-Android-arm64.apk');
    // Every download href must be an absolute GitHub release URL, not a stub.
    const hrefs = [...html.matchAll(/href="(https:\/\/github\.com[^"]+)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThanOrEqual(5);
    for (const h of hrefs) expect(h).toMatch(/\/releases\/download\/[^/]+\/[^/]+$/);
  });

  it('the download page is honest about iOS having no installable file', async () => {
    const html = await (await get('/download')).text();
    expect(html).toContain('App Store');
    expect(html).not.toContain('.ipa');
  });

  it('an Android visitor gets Android first', async () => {
    const html = await (
      await get('/download', envFor(), { 'user-agent': 'Mozilla/5.0 (Linux; Android 14)' })
    ).text();
    const android = html.indexOf('id="p-android"');
    const windows = html.indexOf('id="p-windows"');
    expect(android).toBeGreaterThan(-1);
    expect(android).toBeLessThan(windows);
  });

  it('the panel page renders the lookup form', async () => {
    const html = await (await get('/panel')).text();
    expect(html).toContain('کانفیگ‌های من');
    expect(html).toContain('id="lookup"');
  });

  it('every endpoint the page script calls is a real route', async () => {
    // The dead-button test: pull the fetch targets out of the served HTML and
    // confirm each one answers rather than 404ing.
    // Read the method too: POSTing-only endpoints 404 on a GET, which would
    // look like a dead route when it is merely the wrong verb.
    const html = (await (await get('/')).text()) + (await (await get('/panel')).text());
    const calls = [...html.matchAll(/fetch\('([^']+)'(\s*,\s*\{([\s\S]*?)\})?\)/g)].map((m) => ({
      path: m[1]!.split('?')[0]!,
      method: /method\s*:\s*'(\w+)'/.exec(m[3] ?? '')?.[1] ?? 'GET',
    }));
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      const res = await worker.fetch(
        new Request(`https://shop.example.workers.dev${c.path}`, {
          method: c.method,
          headers: { 'content-type': 'application/json' },
          body: c.method === 'GET' ? undefined : '{}',
        }),
        envFor(),
        ctx,
      );
      // 400/401/422 mean the route exists and rejected our empty input, which
      // is exactly what we want to know. 404 means the page points at nothing.
      expect(res.status, `${c.method} ${c.path}`).not.toBe(404);
    }
  });

  it('robots.txt still hides the private paths but not the shop', async () => {
    const body = await (await get('/robots.txt')).text();
    expect(body).toContain('Disallow: /admin');
    // /panel serves live configs and /pub/ is a JSON surface: neither is
    // crawlable. The shop pages are.
    expect(body).toContain('Disallow: /panel');
    expect(body).toContain('Disallow: /pub/');
    expect(body).not.toContain('Disallow: /download');
    expect(body).not.toContain('Disallow: /\n');
  });
});

// ------------------------------------------------------------ public API ----

describe('/pub/api/subscription', () => {
  it('returns the configs and the subscription link for a valid token', async () => {
    const res = await get('/pub/api/subscription?token=tok_abcdefgh');
    expect(res.status).toBe(200);
    const d = await json(res);
    expect(d.ok).toBe(true);
    expect(d.subUrl).toBe('https://shop.example.workers.dev/s/tok_abcdefgh');
    const configs = d.configs as { uri: string; remark: string }[];
    expect(configs).toHaveLength(1);
    expect(configs[0]!.uri).toContain('vless://');
    expect((d.subscription as Record<string, unknown>).status).toBe('active');
  });

  it('accepts a full subscription URL, not just the bare token', async () => {
    const res = await get(
      '/pub/api/subscription?token=' +
        encodeURIComponent('https://shop.example.workers.dev/s/tok_abcdefgh'),
    );
    expect((await json(res)).ok).toBe(true);
  });

  it('an unknown token is a clean 404, not a crash', async () => {
    const res = await get('/pub/api/subscription?token=nosuchtoken123');
    expect(res.status).toBe(404);
    expect((await json(res)).ok).toBe(false);
  });

  it('a token shorter than the minimum is refused before hitting the DB', async () => {
    const res = await get('/pub/api/subscription?token=abc');
    expect(res.status).toBe(400);
  });

  it('a suspended subscription resolves but hands out no configs', async () => {
    fake.ensure('subscriptions')[0]!.status = 'suspended';
    const d = await json(await get('/pub/api/subscription?token=tok_abcdefgh'));
    expect(d.ok).toBe(true);
    expect(d.configs).toEqual([]);
  });

  it('an expired subscription hands out no configs either', async () => {
    fake.ensure('subscriptions')[0]!.expires_at = Date.now() - 1000;
    const d = await json(await get('/pub/api/subscription?token=tok_abcdefgh'));
    expect(d.configs).toEqual([]);
    expect((d.subscription as Record<string, unknown>).status).toBe('expired');
  });
});

describe('/pub/api/order', () => {
  async function place(body: unknown, cookie?: string) {
    return worker.fetch(
      new Request('https://shop.example.workers.dev/pub/api/order', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
      }),
      envFor(),
      ctx,
    );
  }

  it('refuses an account that never started the bot', async () => {
    const res = await place({ planId: 'p1', telegramId: 999 });
    expect(res.status).toBe(404);
    expect((await json(res)).error).toContain('/start');
  });

  it('refuses a non-numeric Telegram id', async () => {
    expect((await place({ planId: 'p1', telegramId: 'abc' })).status).toBe(400);
  });

  it('refuses a hidden plan', async () => {
    const res = await place({ planId: 'p2', telegramId: 111 });
    expect(res.status).toBe(400);
  });

  it('creates the order and mints a signed cookie', async () => {
    const res = await place({ planId: 'p1', telegramId: 111 });
    expect(res.status).toBe(200);
    const d = await json(res);
    expect(d.ok).toBe(true);
    expect(String(d.orderCode)).toMatch(/^[A-Z0-9-]+$/);
    // No card configured, so checkout must say so instead of offering a form.
    const pay = d.pay as { kind: string; reason?: string };
    expect(pay.kind).toBe('unavailable');
    expect(pay.reason).toContain('ربات');

    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('pub_order=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(fake.ensure('orders')).toHaveLength(1);
  });

  it('that cookie reads the order back', async () => {
    const res = await place({ planId: 'p1', telegramId: 111 });
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
    const back = await get('/pub/api/order', envFor(), { cookie });
    expect(back.status).toBe(200);
    const d = await json(back);
    expect(d.planName).toBe('یک ماهه');
    expect(d.statusText).toBeTruthy();
  });

  it('a forged cookie is rejected, not trusted', async () => {
    await place({ planId: 'p1', telegramId: 111 });
    const res = await get('/pub/api/order', envFor(), { cookie: 'pub_order=ord_x.deadbeef' });
    expect(res.status).toBe(401);
  });

  it('a cookie signed with the wrong secret is rejected', async () => {
    const res = await get('/pub/api/order', envFor(), {
      cookie: orderCookie('ord_1', 'a different secret entirely'),
    });
    expect(res.status).toBe(401);
  });

  it('with no cookie there is nothing to read', async () => {
    expect((await get('/pub/api/order')).status).toBe(401);
  });

  it('stops an account from stacking unlimited open orders', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await place({ planId: 'p1', telegramId: 111 })).status).toBe(200);
    }
    const res = await place({ planId: 'p1', telegramId: 111 });
    expect(res.status).toBe(429);
  });

  it('offers real card instructions once the admin sets a card number', async () => {
    fake.ensure('settings')[0]!.card_number = '6104337890123456';
    resetDepsCache();
    const d = await json(await place({ planId: 'p1', telegramId: 111 }));
    const pay = d.pay as { kind: string; text?: string; tracking?: string };
    expect(pay.kind).toBe('instructions');
    expect(pay.text).toContain('6104');
    expect(pay.tracking).toBeTruthy();
    expect(fake.ensure('orders')[0]!.status).toBe('awaiting_payment');
  });
});

describe('/pub/api/receipt', () => {
  it('without an order cookie there is nothing to attach a receipt to', async () => {
    const res = await worker.fetch(
      new Request('https://shop.example.workers.dev/pub/api/receipt', {
        method: 'POST',
        body: new FormData(),
      }),
      envFor(),
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it('says plainly when receipt upload is not configured, instead of eating the file', async () => {
    const cookie = orderCookie('ord_1', 's'.repeat(64));
    fake.ensure('orders').push({
      id: 'ord_1', code: 'AAAA-BBBB', user_id: 'usr_1', kind: 'subscription', plan_id: 'p1',
      amount: 90_000, status: 'awaiting_payment', gateway: 'card', gateway_ref: '',
      coupon_code: '', discount: 0, paid_from_balance: 0, paid_at: null, created_at: Date.now(),
    });
    const fd = new FormData();
    fd.set('photo', new File([new Uint8Array([1, 2, 3])], 'r.jpg', { type: 'image/jpeg' }));
    fd.set('payerCard', '1234');
    fd.set('payerName', 'علی');
    fd.set('trackingCode', 'TRK1');
    // No R2 in this env, on purpose. The cookie must actually be sent — an
    // earlier version built it and forgot, so this passed 401 for the wrong
    // reason and never reached the R2 check at all.
    const res = await worker.fetch(
      new Request('https://shop.example.workers.dev/pub/api/receipt', {
        method: 'POST',
        headers: { cookie },
        body: fd,
      }),
      envFor(),
      ctx,
    );
    expect(res.status).toBe(503);
    expect((await json(res)).error).toContain('R2');
    expect(cookie).toContain('pub_order=ord_1');
  });
});

/**
 * The dead-button guard.
 *
 * The buy flow shipped once reading `d.panelUrl` from the order response —
 * a field `placeOrder` never returned — so the link rendered as
 * href="undefined" and a web buyer could place an order with no way to pay
 * for it. Nothing failed loudly: the endpoint was fine, the HTML was fine,
 * the wiring between them was not.
 *
 * So: parse the served page, list the fields its script reads off the order
 * response, and assert the real endpoint returns every one of them.
 */
describe('the page script and the API agree', () => {
  it('every field the buy flow reads is one the order endpoint returns', async () => {
    const html = await (await get('/')).text();
    const js = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));

    // Scope to the checkout handler only. The page has two `d` variables — one
    // from /pub/api/subscription, one from /pub/api/order — and scanning the
    // whole script cross-contaminates them (d.subscription is not the order
    // endpoint's business at all).
    const from = js.indexOf('function showCheckout');
    const to = js.indexOf('// Plans with no card configured');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const checkout = js.slice(from, to);

    const reads = new Set<string>();
    for (const m of checkout.matchAll(/\bd\.([A-Za-z][A-Za-z0-9_]*)/g)) reads.add(m[1]!);
    const payReads = new Set<string>();
    for (const m of checkout.matchAll(/\bd\.pay\.([A-Za-z][A-Za-z0-9_]*)/g)) payReads.add(m[1]!);
    expect(reads.size).toBeGreaterThan(0);
    expect(payReads.size).toBeGreaterThan(0);

    // `pay` has two shapes — card instructions, or "unavailable" with a reason
    // — and the page branches on `pay.kind`. So the honest check is against the
    // union of both, not against whichever one this fixture happens to produce.
    const shape = async (cardNumber: string) => {
      if (cardNumber) fake.ensure('settings')[0]!.card_number = cardNumber;
      else fake.ensure('settings')[0]!.card_number = '';
      resetDepsCache();
      const res = await worker.fetch(
        new Request('https://shop.example.workers.dev/pub/api/order', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ planId: 'p1', telegramId: 111 }),
        }),
        envFor(),
        ctx,
      );
      return (await res.json()) as Record<string, unknown>;
    };

    const withoutCard = await shape('');
    expect(withoutCard.ok).toBe(true);
    const withCard = await shape('6104337890123456');
    expect(withCard.ok).toBe(true);
    expect((withCard.pay as { kind: string }).kind).toBe('instructions');
    expect((withoutCard.pay as { kind: string }).kind).toBe('unavailable');

    const topKeys = new Set([...Object.keys(withoutCard), ...Object.keys(withCard)]);
    const payKeys = new Set([
      ...Object.keys(withoutCard.pay as object),
      ...Object.keys(withCard.pay as object),
    ]);

    for (const key of reads) {
      expect([...topKeys], `page reads d.${key} but the API never returns it`).toContain(key);
    }
    for (const key of payReads) {
      expect([...payKeys], `page reads d.pay.${key} but the API never returns it`).toContain(key);
    }
  });

  it('the page contains no href to a literal undefined', async () => {
    for (const path of ['/', '/download', '/panel']) {
      const html = await (await get(path)).text();
      expect(html, path).not.toContain('href="undefined"');
      expect(html, path).not.toContain('>undefined<');
    }
  });

  it('the receipt endpoint is actually reachable from the page script', async () => {
    // An endpoint with no caller is a feature that does not exist. The buy
    // flow has to hand the customer a way to send the receipt.
    const html = await (await get('/')).text();
    expect(html).toContain('/pub/api/receipt');
    expect(html).toContain("type=\"file\"");
  });
});

describe('content security policy', () => {
  it('the public shop is not pinned to Telegram\'s iframe', async () => {
    // A frame-ancestors list naming only telegram.org would stop anything else
    // from embedding the shop — including a review panel or a preview. The
    // shop holds no Telegram-only session, so it gains nothing from the pin.
    const csp = (await get('/')).headers.get('content-security-policy') ?? '';
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain('web.telegram.org');
  });

  it('the mini app and admin panel are still pinned to Telegram', async () => {
    for (const path of ['/app', '/admin']) {
      const csp = (await get(path)).headers.get('content-security-policy') ?? '';
      expect(csp, path).toContain('frame-ancestors https://web.telegram.org');
    }
  });

  it('the shop page never loads a script from a third party', async () => {
    const csp = (await get('/')).headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain('https://telegram.org');
  });
});

describe('unknown routes', () => {
  it('an unknown /pub/api path is 404, not 500', async () => {
    const res = await get('/pub/api/nope');
    expect(res.status).toBe(404);
  });
});

// Keeps `vi` imported for the stub-free tests above and future ones.
void vi;
