/**
 * Catalogue seeding.
 *
 * The product list lives in code (src/shop/catalog.ts) so it is type-checked
 * and versioned with the app, but the pricing cron and the price_events table
 * read from D1 — so the catalogue must be mirrored into the database.
 *
 * This is idempotent: running it twice is safe, and it never overwrites a
 * price that the pricing engine has since adjusted.
 */
import { CATALOG } from '../shop/catalog';
import { newId, now } from '../utils';

export async function seedCatalogue(db: D1Database): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;
  for (const c of CATALOG) {
    const id = `p-${c.sku}`;
    const existing = await db.prepare('SELECT id FROM products WHERE id = ?').bind(id).first();
    if (existing) {
      skipped++;
      continue;
    }
    await db
      .prepare(
        `INSERT INTO products (id, kind, sku, title_fa, title_en, description, price_usd, base_usd,
            image_key, meta, active, visible_before_auth, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)`,
      )
      .bind(
        id,
        c.kind,
        c.sku,
        c.titleFa,
        c.titleEn,
        c.description,
        c.priceUsd,
        c.priceUsd,
        `/img/shop/${c.sku}.png`,
        JSON.stringify(c.meta),
        c.visibleBeforeAuth ? 1 : 0,
        now(),
      )
      .run();
    inserted++;
  }
  return { inserted, skipped };
}

/** Minimal platform settings row so the panel has something to read. */
export async function seedSettings(db: D1Database): Promise<void> {
  await db
    .prepare(
      `INSERT INTO platform_settings (key, value, updated_at) VALUES ('platform', ?, ?)
       ON CONFLICT(key) DO NOTHING`,
    )
    .bind(JSON.stringify({ serverName: 'Minecraft God Server', shopEnabled: true }), now())
    .run();
}

export const seedRunId = (): string => newId();
