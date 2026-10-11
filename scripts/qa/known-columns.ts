/**
 * Print the text-like columns of one or more Drizzle dirs as `table.column,…`
 * for scrub-pii.sql (`psql -v known="$(bun scripts/qa/known-columns.ts [dir…])"`).
 *
 * The Visual QA clone is prod's schema plus the capture ref's migrations. The
 * workflow runs this harness from trunk and passes both snapshots: trunk's
 * (prod's schema, which this scrub has decisions for) and the capture ref's
 * (columns its own migrations add, which the app under audit reads).
 * scrub-pii.sql overwrites every text-like column NOT on the list, so a column
 * neither side knows can never leak through.
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

const OWN_DRIZZLE_DIR = join(__dirname, '..', '..', 'packages', 'core', 'drizzle');

/**
 * The union of each Drizzle dir's latest snapshot (default: this checkout's).
 * Visual QA passes two: the harness's (trunk, which covers prod's schema) and
 * the capture ref's (columns its own migrations add, which its app reads).
 */
export function knownColumns(...drizzleDirs: string[]): string[] {
  const dirs = drizzleDirs.length > 0 ? drizzleDirs : [OWN_DRIZZLE_DIR];
  const out = new Set<string>();
  for (const dir of dirs) {
    for (const c of textColumns(JSON.parse(readFileSync(latestSnapshotPath(dir), 'utf8')))) out.add(c);
  }
  return [...out].sort();
}

if (import.meta.main) {
  const cols = knownColumns(...process.argv.slice(2));
  if (cols.length === 0) throw new Error('known-columns: no text columns found in the latest snapshot');
  process.stdout.write(cols.join(','));
}
