/**
 * Verifies src/db/schema.sql actually applies against a real D1 (SQLite)
 * instance, and that foreign keys / indexes exist. A schema that does not
 * apply is a deployment failure, so this runs in CI.
 */
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let mf: Miniflare;
type TestDb = Awaited<ReturnType<Miniflare['getD1Database']>>;
let db: TestDb;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch(){ return new Response("ok") } }',
    d1Databases: { GODDB: 'test-db' },
  });
  db = await mf.getD1Database('GODDB');
  const sql = readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8');
  // D1 batch splits statements; apply them individually so a failure names
  // the exact statement instead of aborting the batch silently.
  // Strip full-line comments from INSIDE each statement. Filtering out chunks
  // that merely START with a comment would silently drop the CREATE TABLE
  // glued to its section banner, and the schema would look like it applied.
  const statements = sql
    .split(';')
    .map((chunk) =>
      chunk
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await db.prepare(stmt).run();
  }
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

describe('D1 schema', () => {
  it('creates every core table', async () => {
    const { results } = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all<{ name: string }>();
    const names = new Set(results!.map((r) => r.name));
    for (const t of [
      'users', 'ranks', 'admins', 'admin_sessions', 'servers', 'server_settings',
      'players', 'products', 'orders', 'payment_receipts', 'entitlements',
      'cheat_signals', 'cheat_cases', 'bans', 'appeals', 'bot_profiles',
      'matches', 'match_participants', 'transactions', 'subscriptions',
      'referrals', 'otp_attempts', 'fraud_alerts', 'health_checks',
      'audit_logs', 'price_events', 'discount_campaigns', 'cosmetics',
      'user_cosmetics', 'parties', 'party_members', 'invites',
      'platform_settings', 'seasons', 'connection_configs',
    ]) {
      expect(names.has(t), `missing table: ${t}`).toBe(true);
    }
  });

  it('creates indexes', async () => {
    const { results } = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
      .all<{ name: string }>();
    expect(results!.length).toBeGreaterThan(30);
  });

  it('enforces foreign keys', async () => {
    await db.prepare('PRAGMA foreign_keys = ON').run();
    await expect(
      db
        .prepare(
          "INSERT INTO entitlements (id, user_id, kind, ref, granted_at) VALUES ('e1','ghost','rank','pro',1)",
        )
        .run(),
    ).rejects.toThrow();
  });

  it('enforces the unique phone constraint', async () => {
    await db
      .prepare(
        "INSERT INTO users (id, phone_e164, phone_hash, created_at) VALUES ('u1','+989120000000','h1',1)",
      )
      .run();
    await expect(
      db
        .prepare(
          "INSERT INTO users (id, phone_e164, phone_hash, created_at) VALUES ('u2','+989120000000','h2',2)",
        )
        .run(),
    ).rejects.toThrow();
  });

  it('stores an audit log row with no foreign dependency', async () => {
    await db
      .prepare(
        "INSERT INTO audit_logs (id, actor, action, target, created_at) VALUES ('a1','system','boot',NULL,1)",
      )
      .run();
    const { results } = await db.prepare('SELECT COUNT(*) AS n FROM audit_logs').all<{ n: number }>();
    expect(results![0]!.n).toBe(1);
  });
});
