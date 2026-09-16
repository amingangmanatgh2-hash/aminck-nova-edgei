/**
 * Generates public/ from the TypeScript UI modules.
 *
 * The UI lives in TS so it is type-checked and sits next to the code that
 * serves it; public/ is a build artifact, and test/artifacts.test.ts fails the
 * build if the two drift apart.
 *
 * Uses esbuild's JS API rather than shelling out to the binary, which avoids
 * platform-binary path problems across operating systems.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public');
const tmp = join(root, '.nova-build');
mkdirSync(outDir, { recursive: true });
mkdirSync(tmp, { recursive: true });

// One entry that imports the UI strings and writes them out. Bundling it for
// node means the TS is compiled and executed in a single step.
const entry = join(tmp, 'emit.mjs');
writeFileSync(
  entry,
  `import { writeFileSync } from 'node:fs';
import { CSS } from ${JSON.stringify(join(root, 'src/ui/styles.ts'))};
import { SITE_JS } from ${JSON.stringify(join(root, 'src/ui/site.ts'))};
import { ADMIN_JS } from ${JSON.stringify(join(root, 'src/ui/admin.ts'))};
const out = ${JSON.stringify(outDir)};
writeFileSync(out + '/app.css', CSS, 'utf8');
writeFileSync(out + '/app.js', SITE_JS, 'utf8');
writeFileSync(out + '/admin.js', ADMIN_JS, 'utf8');
`,
  'utf8',
);

const result = await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: join(tmp, 'emit.bundle.mjs'),
  write: true,
});
if (result.errors.length) {
  console.error(result.errors);
  process.exit(1);
}

await import(`file://${join(tmp, 'emit.bundle.mjs')}`);

// Validate the generated browser JS actually parses.
for (const f of ['app.js', 'admin.js']) {
  execFileSync(process.execPath, ['--check', join(outDir, f)], { stdio: 'pipe' });
}

const sizes = ['app.css', 'app.js', 'admin.js']
  .map((f) => `${f} ${readFileSync(join(outDir, f)).length}B`)
  .join(', ');
console.log(`build-public: wrote ${sizes}`);
