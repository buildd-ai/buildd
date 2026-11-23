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
 * schema.ts), or, from drizzle-kit 1.0.0-rc.6's snapshot format 10, the schema
 * replayed from the base snapshot and every diff (`snapshotOf`). Same column
 * types the guard scans.
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

type Entity = Record<string, unknown>;
type Delta = { op?: string; row?: Entity; key?: string; set?: Entity };

/**
 * `<entityType>|<schema>|<table>|<name>` of an entity, and of a delta key
 * `<entityType>\0["schema",…,"name"]`. Index names are schema-wide in Postgres,
 * so the kit keys an index by [schema, name] although its row names a table.
 */
const SCHEMA_KEYED = new Set(['indexes']);
const rowKey = (e: Entity) => [e.entityType, e.schema ?? 'public', SCHEMA_KEYED.has(String(e.entityType)) ? '' : (e.table ?? ''), e.name].join('|');
function deltaKey(key: string): string {
  const at = key.indexOf('\u0000');
  if (at < 0) throw new Error(`known-columns: malformed delta key ${JSON.stringify(key)}`);
  const type = key.slice(0, at);
  const parts = JSON.parse(key.slice(at + 1)) as string[];
  // Table-scoped entities name [schema, table, name]; the rest [schema, name].
  return parts.length >= 3 ? [type, parts[0], parts[1], parts[parts.length - 1]].join('|') : [type, parts[0], '', parts[parts.length - 1]].join('|');
}

/**
 * The schema of a drizzle format-10 folder tree (drizzle-kit 1.0.0-rc.6+): the
 * base snapshot's `ddl` with every diff snapshot's `deltas` applied in folder
 * order. Parallel leaves were proved to commute by `drizzle-kit check`, so
 * applying every folder is their union. Deliberately free of drizzle-kit: this
 * harness runs from trunk against whatever drizzle the capture ref installed.
 *
 * Tables and columns are what the scrub reads; other entities are carried along.
 * A table rename re-points its columns. An op this does not know throws, so the
 * scrub step fails closed instead of guessing a column list.
 */
export function replayDiffTree(drizzleDir: string): { ddl: Entity[] } {
  const folders = readdirSync(drizzleDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{14}_[A-Za-z0-9_]+$/.test(d.name))
    .map((d) => d.name)
    .sort();
  const byKey = new Map<string, Entity>();
  let sawBase = false;
  for (const folder of folders) {
    const snap = JSON.parse(readFileSync(join(drizzleDir, folder, 'snapshot.json'), 'utf8')) as { type?: string; ddl?: Entity[]; deltas?: Delta[] };
    if (snap.type === 'base') {
      if (sawBase) throw new Error(`known-columns: ${folder} is a second base snapshot`);
      sawBase = true;
      for (const e of snap.ddl ?? []) byKey.set(rowKey(e), e);
      continue;
    }
    if (snap.type !== 'diff' || !Array.isArray(snap.deltas)) throw new Error(`known-columns: ${folder}/snapshot.json is not a format-10 snapshot`);
    if (!sawBase) throw new Error(`known-columns: ${folder} comes before the base snapshot`);
    for (const d of snap.deltas) {
      if (d.op === 'create' && d.row) {
        byKey.set(rowKey(d.row), d.row);
      } else if (d.op === 'drop' && typeof d.key === 'string') {
        const k = deltaKey(d.key);
        if (!byKey.delete(k)) throw new Error(`known-columns: ${folder} drops ${k}, which the replay does not hold`);
      } else if ((d.op === 'alter' || d.op === 'rename') && typeof d.key === 'string' && d.set) {
        const k = deltaKey(d.key);
        const cur = byKey.get(k);
        if (!cur) throw new Error(`known-columns: ${folder} alters ${k}, which the replay does not hold`);
        const next = { ...cur, ...d.set };
        byKey.delete(k);
        byKey.set(rowKey(next), next);
        if (d.op === 'rename' && cur.entityType === 'tables' && typeof d.set.name === 'string') {
          for (const [ek, e] of [...byKey]) {
            if (e.table === cur.name && (e.schema ?? 'public') === (cur.schema ?? 'public')) {
              byKey.delete(ek);
              const moved = { ...e, table: d.set.name };
              byKey.set(rowKey(moved), moved);
            }
          }
        }
      } else {
        throw new Error(`known-columns: ${folder} has a delta this replay does not know: ${JSON.stringify(d).slice(0, 120)}`);
      }
    }
  }
  if (!sawBase) throw new Error(`known-columns: ${drizzleDir} has no base snapshot`);
  return { ddl: [...byKey.values()] };
}

/** The schema snapshot of a drizzle dir in any layout: the newest file, or the format-10 replay. */
export function snapshotOf(drizzleDir: string): unknown {
  const latest = JSON.parse(readFileSync(latestSnapshotPath(drizzleDir), 'utf8')) as { type?: unknown };
  return latest.type === undefined ? latest : replayDiffTree(drizzleDir);
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
    for (const c of textColumns(snapshotOf(dir))) out.add(c);
  }
  return [...out].sort();
}

if (import.meta.main && process.argv[2] === '--shape') {
  const dir = process.argv[3] ?? OWN_DRIZZLE_DIR;
  const shape = schemaShape(snapshotOf(dir));
  if (!shape.tasks) throw new Error('known-columns --shape: no tasks table in the latest snapshot');
  process.stdout.write(JSON.stringify(shape));
} else if (import.meta.main) {
  const cols = knownColumns(...process.argv.slice(2));
  if (cols.length === 0) throw new Error('known-columns: no text columns found in the latest snapshot');
  process.stdout.write(cols.join(','));
}
