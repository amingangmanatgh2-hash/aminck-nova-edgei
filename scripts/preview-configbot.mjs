/**
 * Local preview for the ConfigBot shop.
 *
 * This is a development harness, not part of the Worker. It exists so the site
 * can actually be looked at in a browser: Miniflare runs the real Worker
 * bundle against a real (SQLite-backed) D1, so what you see is what the
 * deployed Worker would serve — not a re-implementation of it.
 *
 *   node scripts/preview-configbot.mjs
 *
 * Constraints learned the hard way and kept:
 *   • Miniflare's `scriptPath` cannot load TypeScript, so esbuild bundles
 *     src/index.ts first, with `cloudflare:workers` left external.
 *   • compatibility_date must stay at 2026-08-01; newer dates make workerd
 *     refuse to start.
 *   • Bind 0.0.0.0, not localhost, or the preview proxy cannot reach it.
 */
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = new URL('../.preview/bundle.mjs', import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 8787);

mkdirSync(new URL('../.preview', import.meta.url).pathname, { recursive: true });

// ------------------------------------------------------------------ bundle --
await build({
  entryPoints: [`${ROOT}/configbot/src/index.ts`],
  outfile: OUT,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'neutral',
  external: ['cloudflare:workers'],
  logLevel: 'warning',
});
console.log('bundled ->', OUT);

// ---------------------------------------------------------------- miniflare --
const mf = new Miniflare({
  scriptPath: OUT,
  modules: true,
  compatibilityDate: '2026-08-01',
  compatibilityFlags: ['nodejs_compat'],
  d1Databases: ['DB'],
  r2Buckets: ['R2'],
  bindings: {
    BOT_TOKEN: '', // empty on purpose: the preview must work with no bot
    WEBHOOK_SECRET: 'preview-secret'.padEnd(64, '0'),
    ADMIN_USER_IDS: '111',
    PUBLIC_URL: '',
  },
});

const db = await mf.getD1Database('DB');

// Schema, then enough seed data for the site to have something real to show.
const schema = readFileSync(`${ROOT}/configbot/src/db/schema.sql`, 'utf8');
// Split only on a `;` that ends a line. schema.sql has a semicolon *inside a
// comment* on the subscriptions.token line, and splitting on every semicolon
// cuts that statement in half ("incomplete input"). Comments are left in
// place — SQLite understands `--` to end of line.
const statements = schema
  .split(/;\s*(?:\n|$)/)
  .map((s) => s.trim())
  .filter((s) => /CREATE\s+(TABLE|INDEX|UNIQUE|VIRTUAL)/i.test(s));
let created = 0;
for (const stmt of statements) {
  await db.prepare(stmt).run();
  created++;
}
console.log(`schema: ${created} statements applied`);

const now = Date.now();
const day = 86_400_000;

await db
  .prepare(
    `INSERT INTO settings (id, bot_name, support_chat, support_channel, currency,
       card_holder, card_number, card_bank, payment_message, subscription_path,
       expire_warn_days, low_traffic_warn_percent, admin_user_ids, updated_at)
     VALUES (1,?1,?2,?3,?4,?5,?6,?7,?8,'/s',3,15,'[111]',?9)`,
  )
  .bind(
    'ConfigBot',
    'https://t.me/configbot_support',
    'https://t.me/configbot_news',
    'تومان',
    'علی محمدی',
    '6104337890123456',
    'ملت',
    'کد پیگیری را حتماً در توضیحات بنویس',
    now,
  )
  .run();

// id, slug, name, description, price, traffic_gb, duration_days, max_devices,
// sort_order, badge — every column name checked against schema.sql.
const plans = [
  ['p1', 'week', 'یک هفته‌ای', 'برای امتحان کردن سرویس', 35_000, 15, 7, 1, 1, 'شروع'],
  ['p2', 'month', 'یک ماهه', 'محبوب‌ترین انتخاب', 90_000, 50, 30, 2, 2, 'پرفروش'],
  ['p3', 'three', 'سه ماهه', '۱۱٪ ارزان‌تر از ماهانه', 240_000, 180, 90, 3, 3, ''],
  ['p4', 'year', 'یک ساله', 'به‌صرفه‌ترین', 850_000, 900, 365, 5, 4, 'به‌صرفه'],
];
for (const [id, slug, name, desc, price, gb, days, dev, sort, badge] of plans) {
  await db
    .prepare(
      `INSERT INTO plans (id, slug, name, description, kind, protocol_filter,
         price, traffic_gb, duration_days, max_devices, allow_refill,
         sort_order, badge, hidden, created_at, updated_at)
       VALUES (?1,?2,?3,?4,'subscription','[]',?5,?6,?7,?8,1,?9,?10,0,?11,?11)`,
    )
    .bind(id, slug, name, desc, price, gb, days, dev, sort, badge, now)
    .run();
}

// One demo account + subscription so /panel has something to show.
await db
  .prepare(
    `INSERT INTO users (id, telegram_id, username, first_name, balance, role,
       referral_code, created_at, updated_at)
     VALUES ('usr_demo',111,'demo','کاربر نمونه',0,'user','DEMO1',?1,?1)`,
  )
  .bind(now)
  .run();

await db
  .prepare(
    `INSERT INTO subscriptions (id, token, user_id, plan_id, label, traffic_gb,
       traffic_used_bytes, duration_days, expires_at, status, format_lock,
       rotation_count, rotate_after_bytes, rotate_after_days, created_at, updated_at)
     VALUES ('sub_demo','demotoken123456','usr_demo','p2','اشتراک اصلی',50,
       ?1,30,?2,'active','',2,0,0,?3,?3)`,
  )
  .bind(Math.round(7.4 * 1024 ** 3), now + 20 * day, now)
  .run();

const nodes = [
  ['nl1', 'هلند ۱', 'nl', 'هلند', '🇳🇱', 1],
  ['de1', 'آلمان ۱', 'de', 'آلمان', '🇩🇪', 2],
  ['fr1', 'فرانسه ۱', 'fr', 'فرانسه', '🇫🇷', 3],
];
for (const [id, name, cc, label, flag, prio] of nodes) {
  await db
    .prepare(
      `INSERT INTO nodes (id, name, driver, country, country_label, flag, protocol,
         security, public_ip, port, sni, reality_pbk, reality_fp, reality_spider,
         ws_path, inbound_tag, panel_url, panel_user, panel_key, priority, weight,
         health, consecutive_failures, enabled, capacity_users, current_users,
         created_at, updated_at)
       VALUES (?1,?2,'mock',?3,?4,?5,'vless','reality','203.0.113.10',443,
         'www.microsoft.com','AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=',
         'chrome','','','VLESS','','','',?6,1,'up',0,1,0,0,?7,?7)`,
    )
    .bind(id, name, cc, label, flag, prio, now)
    .run();
}

for (let i = 0; i < nodes.length; i++) {
  const n = nodes[i];
  const remark = `${n[4]} ${n[3]} ${i + 1}`;
  await db
    .prepare(
      `INSERT INTO credentials (id, user_id, sub_id, node_id, protocol,
         panel_user_id, username, uuid, remark, watermark, uri,
         traffic_limit_bytes, expires_at, status, created_at, updated_at)
       VALUES (?1,'usr_demo','sub_demo',?2,'vless',?3,?4,?5,?6,?7,?8,0,?9,'active',?10,?10)`,
    )
    .bind(
      `cr_${i}`,
      n[0],
      `demo-user-${i}`,
      `demo${i}`,
      `a1b2c3d4-000${i}-4000-8000-00000000000${i}`,
      remark,
      `a1b2c${i}`,
      // A real-shaped VLESS Reality URI, percent-encoded remark and all.
      `vless://a1b2c3d4-000${i}-4000-8000-00000000000${i}@203.0.113.1${i}:443` +
        `?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.microsoft.com` +
        `&fp=chrome&pbk=AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA%3D` +
        `&sid=abcdef01&type=tcp&headerType=none#${encodeURIComponent(remark)}`,
      now + 30 * day,
      now,
    )
    .run();
}

console.log('seeded: 4 plans, 3 nodes, 1 demo subscription');
console.log('  demo subscription token: demotoken123456');

// ------------------------------------------------------------------- serve --
const server = createServer(async (req, res) => {
  const url = `http://127.0.0.1:${PORT}${req.url ?? '/'}`;
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
  delete headers.host;

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    body = Buffer.concat(chunks);
  }

  try {
    const r = await mf.dispatchFetch(url, { method: req.method, headers, body });
    res.writeHead(r.status, Object.fromEntries(r.headers.entries()));
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('preview error: ' + (e?.stack ?? e));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ConfigBot preview on http://0.0.0.0:${PORT}/`);
  console.log(`    /          ویترین و پلن‌ها`);
  console.log(`    /download  دانلود برنامه‌ها`);
  console.log(`    /panel     کانفیگ‌های من (توکن: demotoken123456)`);
  console.log(`    /admin     پنل ادمین (آیدی ۱۱۱)\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    server.close();
    await mf.dispose();
    process.exit(0);
  });
}
