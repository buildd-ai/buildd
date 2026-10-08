/**
 * Print this checkout's text-like columns as `table.column,…` for
 * scrub-pii.sql (`psql -v known="$(bun scripts/qa/known-columns.ts)"`).
 *
 * The Visual QA clone is prod's schema plus this branch's migrations. A branch
 * cut before a table or column reached prod has no scrub decision for it: the
 * coverage test (scrub-pii.test.ts) can only check this checkout's schema.ts.
 * scrub-pii.sql overwrites every text-like column NOT on this list, so prod
 * being ahead of the branch can never leak through.
 *
 * Source: the newest Drizzle snapshot (CI's schema-drift job keeps it equal to
 * schema.ts). Same column types the guard scans.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const TEXT_LIKE = /^(text|varchar|character varying|char|character|json|jsonb)(\(\d+\))?(\[\])?$/;

interface Snapshot {
  tables: Record<string, { name: string; schema: string; columns: Record<string, { name: string; type: string }> }>;
}

export function latestSnapshotPath(drizzleDir: string): string {
  const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number }[] };
  const idx = Math.max(...journal.entries.map(e => e.idx));
  return join(drizzleDir, 'meta', `${String(idx).padStart(4, '0')}_snapshot.json`);
}

export function textColumns(snapshot: Snapshot): string[] {
  const out: string[] = [];
  for (const t of Object.values(snapshot.tables)) {
    if ((t.schema || 'public') !== 'public') continue;
    for (const c of Object.values(t.columns)) {
      if (TEXT_LIKE.test(c.type)) out.push(`${t.name}.${c.name}`);
    }
  }
  return out.sort();
}

export function knownColumns(drizzleDir = join(__dirname, '..', '..', 'packages', 'core', 'drizzle')): string[] {
  return textColumns(JSON.parse(readFileSync(latestSnapshotPath(drizzleDir), 'utf8')));
}

if (import.meta.main) {
  const cols = knownColumns();
  if (cols.length === 0) throw new Error('known-columns: no text columns found in the latest snapshot');
  process.stdout.write(cols.join(','));
}
