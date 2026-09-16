import { readFileSync } from 'node:fs';

/**
 * Applies src/db/schema.sql to a test D1, statement by statement.
 *
 * Full-line comments are stripped from INSIDE each statement; dropping chunks
 * that merely start with a comment would silently skip the CREATE TABLE glued
 * to its section banner and the schema would appear to apply.
 */
export async function exec(db: D1Database, path: string): Promise<void> {
  const sql = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
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
  for (const stmt of statements) await db.prepare(stmt).run();
}
