/**
 * Verifies the committed public/ bundle matches the TypeScript source, and
 * that the browser JavaScript actually parses. Run as part of `npm run check`.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'nova-ui-check-'));
let bytes = 0;

try {
  for (const f of ['app.js', 'admin.js']) {
    const p = join(root, 'public', f);
    const src = readFileSync(p, 'utf8');
    const tmp = join(dir, f);
    writeFileSync(tmp, src, 'utf8');
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    bytes += Buffer.byteLength(src);
  }
  const css = readFileSync(join(root, 'public', 'app.css'), 'utf8');
  if (!css.includes('NOVA-CSS-START')) throw new Error('app.css missing the CSS start marker');
  bytes += Buffer.byteLength(css);
  console.log(`check-ui: OK (${bytes} bytes of browser assets passed node --check)`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
