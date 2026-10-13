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
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const TEXT_LIKE = /^(text|varchar|character varying|char|character|json|jsonb)(\(\d+\))?(\[\])?$/;

interface Snapshot {
  tables: Record<string, { name: string; schema: string; columns: Record<string, { name: string; type: string; typeSchema?: string }> }>;
}

/**
 * A snapshot in either format: drizzle 0.x's `tables{}` as is, or drizzle v1's
 * `ddl[]` of entities, reshaped into the same `tables{}` (an array column's
 * `dimensions` become `[]` suffixes, as 0.x spelled them). The capture ref's
 * drizzle dir may be in either layout, so both readers below take either.
 */
export function normalizeSnapshot(raw: unknown): Snapshot {
  const snap = raw as { tables?: Snapshot['tables']; ddl?: Array<Record<string, unknown>> };
  if (snap.tables) return { tables: snap.tables };
  if (!Array.isArray(snap.ddl)) throw new Error('known-columns: snapshot has neither tables{} nor ddl[]');
  const tables: Snapshot['tables'] = {};
  const key = (schema: unknown, name: unknown) => `${schema || 'public'}.${name}`;
  for (const e of snap.ddl) {
    if (e.entityType === 'tables') tables[key(e.schema, e.name)] = { name: String(e.name), schema: String(e.schema || 'public'), columns: {} };
  }
  for (const e of snap.ddl) {
    if (e.entityType !== 'columns') continue;
    const table = tables[key(e.schema, e.table)];
    if (!table) continue;
    const dims = typeof e.dimensions === 'number' ? e.dimensions : 0;
    table.columns[String(e.name)] = {
      name: String(e.name),
      type: `${String(e.type)}${'[]'.repeat(dims)}`,
      ...(typeof e.typeSchema === 'string' ? { typeSchema: e.typeSchema } : {}),
    };
  }
  return { tables };
}

/** The newest snapshot of a drizzle dir, in the journal layout or drizzle v1's folders. */
export function latestSnapshotPath(drizzleDir: string): string {
  if (!existsSync(join(drizzleDir, 'meta', '_journal.json'))) {
    const folders = readdirSync(drizzleDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{14}_[A-Za-z0-9_]+$/.test(d.name))
      .map((d) => d.name)
      .sort();
    if (folders.length === 0) throw new Error(`known-columns: ${drizzleDir} has neither a journal nor migration folders`);
    return join(drizzleDir, folders[folders.length - 1]!, 'snapshot.json');
  }
  const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number }[] };
  const idx = Math.max(...journal.entries.map(e => e.idx));
  return join(drizzleDir, 'meta', `${String(idx).padStart(4, '0')}_snapshot.json`);
}

export function textColumns(raw: unknown): string[] {
  const out: string[] = [];
  for (const t of Object.values(normalizeSnapshot(raw).tables)) {
    if ((t.schema || 'public') !== 'public') continue;
    for (const c of Object.values(t.columns)) {
      if (TEXT_LIKE.test(c.type)) out.push(`${t.name}.${c.name}`);
    }
  }
  return out.sort();
}

/**
 * Every public table → column → SQL type of a snapshot, for scrub-pii.sql's
 * `-v shape` (`--shape <dir>`). The scrub runs from trunk, so it names trunk's
 * objects; any the clone lacks (trunk ahead of prod and the capture ref) are
 * added empty for the scrub and dropped again before it commits.
 */
export function schemaShape(raw: unknown): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const t of Object.values(normalizeSnapshot(raw).tables)) {
    if ((t.schema || 'public') !== 'public') continue;
    const cols: Record<string, string> = {};
    for (const c of Object.values(t.columns)) cols[c.name] = c.typeSchema && c.typeSchema !== 'public' ? `${c.typeSchema}.${c.type}` : c.type;
    out[t.name] = cols;
  }
  return out;
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

if (import.meta.main && process.argv[2] === '--shape') {
  const dir = process.argv[3] ?? OWN_DRIZZLE_DIR;
  const shape = schemaShape(JSON.parse(readFileSync(latestSnapshotPath(dir), 'utf8')));
  if (!shape.tasks) throw new Error('known-columns --shape: no tasks table in the latest snapshot');
  process.stdout.write(JSON.stringify(shape));
} else if (import.meta.main) {
  const cols = knownColumns(...process.argv.slice(2));
  if (cols.length === 0) throw new Error('known-columns: no text columns found in the latest snapshot');
  process.stdout.write(cols.join(','));
}
