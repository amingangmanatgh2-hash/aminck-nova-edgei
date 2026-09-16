/**
 * Export the TypeScript product catalogue to data/catalog.json.
 *
 * Why: the Python/Termux side must work with zero npm packages and zero
 * network. Rather than duplicating prices in two places (which always drifts),
 * the TS catalogue stays the single source of truth and this script derives
 * the JSON. `test/catalog-sync.test.ts` fails if the JSON goes stale, so the
 * derived file cannot silently diverge.
 *
 *   node scripts/export-catalog.mjs          # write data/catalog.json
 *   node scripts/export-catalog.mjs --check  # exit 1 if out of date
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outPath = join(root, 'data', 'catalog.json');

const entry = mkdtempSync(join(tmpdir(), 'nova-cat-'));
const entryFile = join(entry, 'entry.ts');
writeFileSync(
  entryFile,
  `import { catalogToProducts } from '${join(root, 'src/shop/catalog.ts').replace(/\\/g, '/')}';
   import { RANKS } from '${join(root, 'src/config.ts').replace(/\\/g, '/')}';
   console.log(JSON.stringify({
     generated_by: 'scripts/export-catalog.mjs',
     products: catalogToProducts(),
     ranks: RANKS,
   }));
`,
);

const bundlePath = join(entry, 'bundle.mjs');
await build({
  entryPoints: [entryFile],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  outfile: bundlePath,
  external: ['cloudflare:workers'],
  logLevel: 'warning',
});

const stdout = execFileSync(process.execPath, [bundlePath], { encoding: 'utf8' });
const parsed = JSON.parse(stdout);

// Stable shape for the offline reader.
const payload = {
  generated_by: parsed.generated_by,
  generated_at: 'static',
  count: parsed.products.length,
  products: parsed.products.map((p) => ({
    id: p.id,
    sku: p.sku,
    kind: p.kind,
    title_fa: p.titleFa,
    title_en: p.titleEn,
    description: p.description,
    price_usd: p.priceUsd,
    base_usd: p.baseUsd,
    meta: p.meta,
    visible_before_auth: p.visibleBeforeAuth,
  })),
  ranks: parsed.ranks,
};

const text = `${JSON.stringify(payload, null, 2)}\n`;

if (process.argv.includes('--check')) {
  if (!existsSync(outPath)) {
    console.error(`data/catalog.json missing — run: node scripts/export-catalog.mjs`);
    process.exit(1);
  }
  const current = readFileSync(outPath, 'utf8');
  if (current !== text) {
    console.error('data/catalog.json is out of date — run: node scripts/export-catalog.mjs');
    process.exit(1);
  }
  console.log(`data/catalog.json in sync (${payload.count} products)`);
} else {
  writeFileSync(outPath, text, 'utf8');
  console.log(`wrote ${outPath} (${payload.count} products)`);
}
