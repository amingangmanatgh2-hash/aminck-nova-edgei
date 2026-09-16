import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CATALOG, catalogToProducts } from '../src/shop/catalog';

/**
 * `data/catalog.json` is what the offline Termux app reads. It is generated
 * from this file by scripts/export-catalog.mjs, so it must never drift.
 */
const ROOT = join(__dirname, '..');
const EXPORTED = JSON.parse(
  readFileSync(join(ROOT, 'data/catalog.json'), 'utf8'),
) as { count: number; products: Record<string, unknown>[]; ranks: Record<string, unknown> };

describe('exported catalogue', () => {
  it('has the same number of products as the TypeScript catalogue', () => {
    expect(EXPORTED.count).toBe(CATALOG.length);
    expect(EXPORTED.products).toHaveLength(catalogToProducts().length);
  });

  it('contains every sku from the source of truth', () => {
    const exportedSkus = new Set(EXPORTED.products.map((p) => p.sku));
    for (const entry of CATALOG) {
      expect(exportedSkus.has(entry.sku), `missing sku ${entry.sku}`).toBe(true);
    }
  });

  it('carries the same prices, in integer cents', () => {
    const byId = new Map(catalogToProducts().map((p) => [p.sku, p]));
    for (const product of EXPORTED.products) {
      const source = byId.get(product.sku as string);
      expect(source, `unknown sku ${String(product.sku)}`).toBeDefined();
      expect(product.price_usd).toBe(source!.priceUsd);
      expect(Number.isInteger(product.price_usd)).toBe(true);
      expect(product.title_fa).toBe(source!.titleFa);
    }
  });

  it('is reported in sync by the exporter itself', () => {
    const out = execFileSync(process.execPath, [
      'scripts/export-catalog.mjs',
      '--check',
    ], { cwd: ROOT, encoding: 'utf8' });
    expect(out).toContain('in sync');
  });
});
