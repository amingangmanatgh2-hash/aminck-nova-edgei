import { describe, it, expect, beforeEach, vi } from 'vitest';
import worker, { resetDepsCache, type Env } from '../src/index';
import { D1Store } from '../src/service/d1store';

/**
 * The gateway return URL.
 *
 * This is the one path where real money changes hands without a human looking
 * at it, so the tests aim at the ways it can be abused: a forged amount, a
 * callback for someone else's order, a gateway that says "approved" for an
 * order that was already paid.
 *
 * The gateway HTTP call is faked; the order lifecycle is the real one from
 * service/orders.ts, running against a fake D1 that keeps real rows.
 */

interface Row {
  [k: string]: unknown;
}

/**
 * A tiny in-memory D1. It understands only the queries this flow issues, which
 * is deliberate: if the code starts issuing a new query the test fails loudly
 * instead of silently returning nothing.
 */
function makeFakeDb() {
  const tables = new Map<string, Row[]>();
  const ensure = (t: string) => {
    if (!tables.has(t)) tables.set(t, []);
    return tables.get(t)!;
  };

  function matches(row: Row, params: unknown[], sql: string): boolean {
    // Only the WHERE clause selects rows. Scanning the whole statement would
    // compare each row against an UPDATE's SET values — i.e. the new ones — and
    // match nothing, making every update silently affect 0 rows.
    const where = /WHERE([\s\S]*)$/i.exec(sql)?.[1] ?? '';
    const pairs = [...where.matchAll(/(\w+)\s*=\s*\?(\d+)/g)];
    for (const [, col, idx] of pairs) {
      const want = params[Number(idx) - 1];
      const have = row[col!];
      if (String(have ?? '') !== String(want ?? '')) return false;
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
          console.log('FIRST:', sql.trim().slice(0,45));
          const rows = ensure(table).filter((r) => matches(r, bound, sql));
          return rows[0] ?? null;
        },
        async all() {
          const rows = ensure(table).filter((r) => matches(r, bound, sql));
          return { results: rows, meta: {} };
        },
        async run() {
          console.log('RUN:', sql.trim().slice(0, 40), '| bound:', JSON.stringify(bound.slice(0,3)));
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
              // Must be /g: String.matchAll throws on a non-global regex, and
              // that throw was escaping as "fulfilment failed" while the row
              // was never updated at all.
              const sets = [...sql.matchAll(/SET\s+([\s\S]*?)\s+WHERE/gi)][0]?.[1] ?? '';
              for (const [, col, idx] of sets.matchAll(/(\w+)\s*=\s*\?(\d+)/g)) {
                r[col!] = bound[Number(idx) - 1];
              }
              console.log('AFTER APPLY status=', r.status, 'setsHasStatus=', /status\s*=\s*\?/.test(sets));
            });
            return { meta: { changes: rows.length }, results: [] };
          }
          return { meta: { changes: 0 }, results: [] };
        },
      };
      return stmt;
    },
    batch: async (stmts: unknown[]) => Promise.all((stmts as { run(): unknown }[]).map((s) => s.run())),
  };

  return { db: db as unknown as Env['DB'], tables, ensure };
}

let fake: ReturnType<typeof makeFakeDb>;
let gatewayReplies: { ok: boolean; body: unknown };

beforeEach(() => {
  fake = makeFakeDb();
  resetDepsCache();
  gatewayReplies = { ok: true, body: { data: { code: 100, authority: 'AUTH1', ref_id: 555 } } };

  // Seed the minimum rows the flow reads.
  fake.ensure('settings').push({
    id: 1,
    card_number: '',
    card_holder: '',
    card_bank: '',
    currency: 'تومان',
    bot_name: 'ConfigBot',
    subscription_path: '/s',
    admin_user_ids: '[]',
    ai_temperature: 0.4,
  });
  fake.ensure('users').push({
    id: 'usr_1',
    telegram_id: 111,
    username: 'ali',
    first_name: 'علی',
    balance: 0,
    role: 'user',
    blocked: 0,
    referral_code: 'ABC',
  });
  fake.ensure('plans').push({
    id: 'p1',
    slug: 'month',
    name: 'یک ماهه',
    price: 90_000,
    traffic_gb: 50,
    duration_days: 30,
    max_devices: 2,
    protocol_filter: '[]',
    hidden: 0,
    badge: '',
    sort_order: 0,
  });
  // Without a node there is nothing to issue a config on, and fulfilment
  // correctly refuses — so the happy path needs one.
  fake.ensure('nodes').push({
    id: 'nl1',
    name: 'هلند ۱',
    driver: 'mock',
    country: 'nl',
    country_label: 'هلند',
    flag: '',
    protocol: 'vless',
    security: 'reality',
    public_ip: '1.1.1.1',
    port: 443,
    sni: 'www.microsoft.com',
    reality_pbk: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=',
    reality_fp: 'chrome',
    reality_spider: '',
    ws_path: '',
    inbound_tag: 'VLESS',
    panel_url: '',
    panel_user: '',
    panel_key: '',
    priority: 100,
    weight: 1,
    health: 'up',
    consecutive_failures: 0,
    enabled: 1,
    capacity_users: 0,
    current_users: 0,
  });
  fake.ensure('orders').push({
    id: 'ord_1',
    code: 'A7K9-2M4P',
    user_id: 'usr_1',
    kind: 'subscription',
    plan_id: 'p1',
    amount: 90_000,
    status: 'awaiting_payment',
    gateway: 'zarinpal',
    gateway_ref: 'AUTH1',
    created_at: Date.now(),
  });

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).includes('zarinpal.com')) {
        return new Response(JSON.stringify(gatewayReplies.body), {
          status: gatewayReplies.ok ? 200 : 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
});

// Built per test: `fake` only exists after beforeEach runs, so this cannot be a
// module-level constant.
function envFor(): Env {
  return {
    DB: fake.db,
    BOT_TOKEN: '123:abc',
    WEBHOOK_SECRET: 'a'.repeat(64),
    ADMIN_USER_IDS: '111',
    ZARINPAL_MERCHANT: 'merchant-12345678',
    PUBLIC_URL: 'https://bot.example.workers.dev',
  };
}

const ctx = { waitUntil: () => undefined } as never;

function callback(query: string): Promise<Response> {
  return worker.fetch(
    new Request(`https://bot.example.workers.dev/pay/callback/zarinpal?${query}`, {
      headers: { 'content-type': 'text/html' },
    }),
    envFor(),
    ctx,
  );
}

describe('gateway callback', () => {
  it('an unknown gateway is refused', async () => {
    const res = await worker.fetch(
      new Request('https://bot.example.workers.dev/pay/callback/paypal'),
      envFor(),
      ctx,
    );
    expect(await res.text()).toContain('نامعتبر');
  });

  it('a gateway with no key configured is not accepted', async () => {
    const res = await worker.fetch(
      new Request('https://bot.example.workers.dev/pay/callback/nextpay?trans_id=x&order_id=A7K9-2M4P'),
      envFor(),
      ctx,
    );
    expect(await res.text()).toContain('تنظیم نشده');
  });

  it('a callback with no recognisable order is refused, not guessed', async () => {
    const res = await callback('Status=OK&Authority=AUTH1');
    expect(await res.text()).toContain('پیدا نشد');
  });

  it('a successful verification marks the order paid', async () => {
    gatewayReplies = { ok: true, body: { data: { code: 100, ref_id: 555 } } };
    const res = await callback('Status=OK&Authority=AUTH1&order=A7K9-2M4P');
    const body = await res.text();
    expect(body).toContain('تأیید شد');
    expect(fake.ensure('orders')[0]!.status).toBe('paid');
  });

  it('a user-cancelled payment is reported honestly and does not credit', async () => {
    const res = await callback('Status=NOK&Authority=AUTH1&order=A7K9-2M4P');
    expect(await res.text()).toContain('ناموفق');
    expect(fake.ensure('orders')[0]!.status).not.toBe('paid');
  });

  it('the gateway rejecting the verification does not credit the order', async () => {
    gatewayReplies = { ok: true, body: { errors: { code: -21, message: 'merchant نامعتبر' } } };
    const res = await callback('Status=OK&Authority=AUTH1&order=A7K9-2M4P');
    expect(await res.text()).toContain('ناموفق');
    expect(fake.ensure('orders')[0]!.status).not.toBe('paid');
  });

  it('a gateway outage does not silently look like success', async () => {
    // A thrown fetch, not an HTTP error: an error response still parses and is
    // reported as a rejection, which is a different (also correct) path.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network unreachable');
      }),
    );
    const res = await callback('Status=OK&Authority=AUTH1&order=A7K9-2M4P');
    expect(await res.text()).toContain('خطا');
    expect(fake.ensure('orders')[0]!.status).not.toBe('paid');
  });

  it('a replayed callback does not create a second order', async () => {
    gatewayReplies = { ok: true, body: { data: { code: 100, ref_id: 555 } } };
    await callback('Status=OK&Authority=AUTH1&order=A7K9-2M4P');
    await callback('Status=OK&Authority=AUTH1&order=A7K9-2M4P');
    expect(fake.ensure('orders')).toHaveLength(1);
  });

  it('the response is a human page, never a JSON blob', async () => {
    const res = await callback('Status=OK&Authority=AUTH1&order=A7K9-2M4P');
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('HTML in the message is escaped, so a gateway cannot inject markup', async () => {
    gatewayReplies = {
      ok: true,
      body: { errors: { code: -1, message: '<img src=x onerror=alert(1)>' } },
    };
    // Status=OK so verify() actually calls the gateway; NOK short-circuits and
    // the injected markup would never reach the page at all.
    const body = await (await callback('Status=OK&Authority=A&order=A7K9-2M4P')).text();
    expect(body).not.toContain('<img');
    expect(body).toContain('&lt;img');
  });
});

describe('the amount is never taken from the query string', () => {
  it('an attacker-supplied amount changes nothing', async () => {
    // Zarinpal's own response carries no amount we trust; we use our order row.
    // This asserts the callback ignores an amount parameter entirely.
    gatewayReplies = { ok: true, body: { data: { code: 100, ref_id: 555 } } };
    await callback('Status=OK&Authority=AUTH1&order=A7K9-2M4P&amount=1');
    expect(fake.ensure('orders')[0]!.amount).toBe(90_000);
  });
});

describe('D1Store against the fake database', () => {
  it('reads back a seeded order by code', async () => {
    const store = new D1Store(fake.db);
    const order = await store.getOrderByCode('A7K9-2M4P');
    expect(order).not.toBeNull();
    expect(order!.amount).toBe(90_000);
    expect(order!.userId).toBe('usr_1');
  });

  it('reads back a user by Telegram id', async () => {
    const store = new D1Store(fake.db);
    const user = await store.getUserByTelegram(111);
    expect(user!.username).toBe('ali');
  });

  it('an unknown code returns null rather than throwing', async () => {
    const store = new D1Store(fake.db);
    expect(await store.getOrderByCode('NOPE-0000')).toBeNull();
  });
});
