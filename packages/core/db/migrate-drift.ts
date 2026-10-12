// Drift classification for scripts/check-schema-drift.ts.
//
// The gate used to print `[pending]` for every snapshot column missing from the
// production DB and then exit 0. That is correct for a migration that has not
// run yet — migrations run during the deploy, i.e. AFTER this gate — and wrong
// for a migration the tracking table already claims is applied. That second case
// is precisely the 0067 silent skip (a `when` below the high-water mark, never
// applied, deploy green) and the bogus-backfill bug (a tracking row written
// without the DDL ever running). Both used to read as `[pending]` and pass.
//
// This module does the classification. It lives in packages/core rather than in
// scripts/ so that the gate script stays a thin top-to-bottom script while every
// decision it makes is unit-testable in isolation.
//
// No drizzle-orm import on purpose: scripts/ runs from the repo root, where
// drizzle-orm is not resolvable. `folderMillis` in the tracking table is just
// the journal entry's `when`, and statements are the file split on drizzle's
// statement-breakpoint marker — both trivially readable with fs.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveAssertions } from './migrate-backfill';
import type { LegacyMigration } from './legacy-migrations';
import { readMigrationTree } from './migrate-tree';

export interface MigrationSource {
  /** Display label: the journal tag, or the v1 folder name. */
  tag: string;
  /**
   * The exact-ms journal `when` the old migrator stored as created_at. Set for
   * legacy-layout entries and for legacy folders of a v1 tree; null for a
   * post-cutover folder, which is recognised by name only.
   */
  when: number | null;
  /** v1 folder name, which a v1 tracking row stores in `name`. */
  name?: string;
  statements: string[];
}

/**
 * Recorded as applied: a row carries its name, or (legacy history) a row's
 * created_at equals its exact-ms `when`. Never by a post-cutover folder's
 * second-precision timestamp: see migrate-plan.ts planMigrationsV1.
 */
function isRecorded(
  src: MigrationSource,
  appliedWhens: ReadonlySet<number>,
  appliedNames: ReadonlySet<string> | undefined
): boolean {
  return (src.when !== null && appliedWhens.has(src.when)) || (src.name !== undefined && !!appliedNames?.has(src.name));
}

const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

/** Read the journal and every referenced .sql file. */
/** A legacy-layout source: always keyed by its journal `when`. */
export type JournalMigrationSource = MigrationSource & { when: number };

export function loadMigrationSources(drizzleDir: string): JournalMigrationSource[] {
  const journal = JSON.parse(
    readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8')
  ) as { entries: Array<{ idx: number; when: number; tag: string }> };

  return [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map((entry) => ({
      tag: entry.tag,
      when: entry.when,
      statements: driftStatements(readFileSync(join(drizzleDir, `${entry.tag}.sql`), 'utf8').split(STATEMENT_BREAKPOINT)),
    }));
}

function driftStatements(chunks: readonly string[]): string[] {
  return (
    chunks
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      // A file of nothing but comments has no executable statement; keeping it
      // would make callers think SQL was read when none was.
      .filter((s) => s.split('\n').some((line) => line.trim() !== '' && !line.trim().startsWith('--')))
  );
}

/**
 * The v1 tree as drift sources: legacy folders first, in legacy-map order and
 * carrying their ms `when`; then post-cutover folders in name order, keyed by
 * name only. Order matters: `addedBy` lets the last creator of a target win.
 */
export function loadMigrationSourcesV1(drizzleDir: string, legacy: readonly LegacyMigration[]): MigrationSource[] {
  const tree = readMigrationTree(drizzleDir);
  const byName = new Map(tree.map((m) => [m.name, m]));
  const legacyNames = new Set(legacy.map((e) => e.name));
  const sources: MigrationSource[] = [];
  for (const e of legacy) {
    const m = byName.get(e.name);
    if (!m) throw new Error(`legacy migration ${e.name} (${e.tag}) has no folder in ${drizzleDir}`);
    sources.push({ tag: m.name, name: m.name, when: e.when, statements: driftStatements(m.sql) });
  }
  for (const m of tree) {
    if (!legacyNames.has(m.name)) sources.push({ tag: m.name, name: m.name, when: null, statements: driftStatements(m.sql) });
  }
  return sources;
}

export interface DriftClassificationInput {
  sources: readonly MigrationSource[];
  /** `created_at` values present in __drizzle_migrations. */
  appliedWhens: ReadonlySet<number>;
  /** `name` values present in __drizzle_migrations (v1 rows). */
  appliedNames?: ReadonlySet<string>;
  /** Snapshot expectation: table -> columns. */
  expected: ReadonlyMap<string, ReadonlySet<string>>;
  /** Live introspection: table -> columns. */
  actual: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface DriftClassification {
  /** Missing, and the migration that adds it is recorded as applied. Fatal. */
  drift: string[];
  /** Missing, and its migration has not been recorded yet. Expected pre-deploy. */
  pending: string[];
  /** Missing, and no migration in the journal adds it at all. */
  unexplained: string[];
  measured: {
    expectedObjects: number;
    missing: number;
    addedByMigrations: number;
    appliedMigrations: number;
    /**
     * Snapshot objects no migration in the journal creates. These are the ones
     * that would land in `unexplained` (fatal) if they ever went missing, so the
     * number is the gate's false-positive surface — keep it at 0.
     */
    expectedWithoutCreator: number;
  };
}

/**
 * Columns declared inside a `CREATE TABLE` body, as `table.column`.
 *
 * `deriveAssertions` deliberately does NOT do this: it powers the backfill
 * verifier, where asserting the full original column list of an old CREATE TABLE
 * would flag every column a later migration dropped as a contradiction. Here the
 * comparison is only ever against columns the LATEST snapshot still expects, so
 * dropped columns never reach it — and without this parse, ~70% of snapshot
 * columns have no traceable creator and would land in `unexplained`.
 */
/** Unquoted words that open a table-constraint line inside a CREATE TABLE body. */
const TABLE_BODY_KEYWORDS = new Set(['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN', 'EXCLUDE', 'LIKE']);

export function createTableColumns(statement: string): string[] {
  // A line state machine rather than an anchored regex: some hand-written
  // migrations contain multiple CREATE TABLEs
  // with no `--> statement-breakpoint` between them, so the whole file arrives
  // here as one "statement" that does not begin with CREATE TABLE. Anchoring
  // silently returned nothing for those.
  const columns: string[] = [];
  let table: string | null = null;

  for (const line of statement.split('\n')) {
    const open = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?"?([A-Za-z0-9_]+)"?\s*\(/i.exec(
      line
    );
    if (open) {
      table = open[1]!;
      continue;
    }
    if (table === null) continue;
    if (/^\s*\)\s*;?/.test(line)) {
      table = null;
      continue;
    }
    // drizzle-kit quotes every column; pg_dump (the squashed baseline) quotes
    // only reserved words, and lists table constraints in the same body.
    const column = /^\s*(?:"([A-Za-z0-9_]+)"|([A-Za-z_][A-Za-z0-9_]*))\s+\S/.exec(line);
    if (!column) continue;
    const name = column[1] ?? column[2]!;
    if (column[2] && TABLE_BODY_KEYWORDS.has(name.toUpperCase())) continue;
    columns.push(`${table}.${name}`);
  }

  return columns;
}

/**
 * Map every table/column the journal creates to the migrations that create it.
 * A target can be added by more than one migration (re-added after a drop, or
 * an idempotent reconciliation migration); the LAST one decides, since that is
 * the state the schema should be in now.
 */
function addedBy(sources: readonly MigrationSource[]): Map<string, MigrationSource> {
  const map = new Map<string, MigrationSource>();
  for (const src of sources) {
    const { assertions } = deriveAssertions(src.statements);
    for (const assertion of assertions) {
      if (assertion.kind === 'column_exists' || assertion.kind === 'table_exists') {
        map.set(assertion.target, src);
      }
    }
    for (const statement of src.statements) {
      for (const target of createTableColumns(statement)) map.set(target, src);
    }
    // Carry attribution across renames. `objectives` was renamed to `missions`,
    // so every missions.* column is really created by objectives' CREATE TABLE;
    // without this the whole table reads as "no migration creates it".
    for (const statement of src.statements) {
      const renamed = /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:"?public"?\.)?"?([A-Za-z0-9_]+)"?\s+RENAME\s+TO\s+"?([A-Za-z0-9_]+)"?/i.exec(
        statement
      );
      if (!renamed) continue;
      const [, from, to] = renamed as unknown as [string, string, string];
      for (const [target, creator] of [...map]) {
        if (target === from) map.set(to, creator);
        else if (target.startsWith(`${from}.`)) {
          map.set(`${to}.${target.slice(from.length + 1)}`, creator);
        }
      }
    }
  }
  return map;
}

/**
 * Split the snapshot-expected-but-absent objects into drift / pending /
 * unexplained, and report the counts behind that split.
 */
export function classifyMissingSchemaObjects(
  input: DriftClassificationInput
): DriftClassification {
  const { sources, appliedWhens, appliedNames, expected, actual } = input;

  const creators = addedBy(sources);
  const drift: string[] = [];
  const pending: string[] = [];
  const unexplained: string[] = [];

  let expectedObjects = 0;
  let missing = 0;
  let expectedWithoutCreator = 0;

  const missingTargets: string[] = [];
  for (const [table, columns] of expected) {
    expectedObjects += 1 + columns.size;
    if (!creators.has(table)) expectedWithoutCreator++;
    for (const column of columns) {
      if (!creators.has(`${table}.${column}`)) expectedWithoutCreator++;
    }
    const actualColumns = actual.get(table);
    if (!actualColumns) {
      missingTargets.push(table);
      // A missing table implies its columns are missing too; reporting the table
      // alone keeps the output readable.
      continue;
    }
    for (const column of columns) {
      if (!actualColumns.has(column)) missingTargets.push(`${table}.${column}`);
    }
  }

  for (const target of missingTargets) {
    missing++;
    const creator = creators.get(target);
    if (!creator) {
      unexplained.push(`${target} — no migration in the journal adds it`);
    } else if (isRecorded(creator, appliedWhens, appliedNames)) {
      drift.push(
        `${target} — added by ${creator.tag}, which __drizzle_migrations records as APPLIED`
      );
    } else {
      pending.push(`${target} — added by ${creator.tag} (not yet applied)`);
    }
  }

  return {
    drift,
    pending,
    unexplained,
    measured: {
      expectedObjects,
      missing,
      addedByMigrations: creators.size,
      appliedMigrations: appliedWhens.size,
      expectedWithoutCreator,
    },
  };
}

// ─── Snapshot chain resolution ───────────────────────────────────────────────
//
// Drizzle snapshots are a linked list, not a numbered pile: each carries its own
// `id` plus the `prevId` of the snapshot it was generated from. Selecting by
// filename alone is correct only while the chain is linear, and it is not always
// linear here. Two concurrent `bun db:generate` runs each diff against the same
// parent, each claim the next free index, and git conflicts on neither the .sql
// nor the .json — so the chain forks into siblings that each hold only part of
// the schema. Picking one sibling makes whatever the OTHER one added look like
// an object the snapshot has never heard of.
//
// The gate cannot produce a meaningful verdict in that state: it cannot tell
// "production was edited" from "I am reading the wrong branch", and only one of
// those is an emergency. So resolution reports the fork instead of guessing.

export interface SnapshotMeta {
  /** Snapshot file name, e.g. `0157_snapshot.json`. */
  file: string;
  id: string;
  prevId: string;
}

export type SnapshotSelection =
  | { kind: 'resolved'; file: string; siblings: readonly string[] }
  | { kind: 'forked'; file: string; siblings: readonly string[]; prevId: string }
  | { kind: 'empty' };

function snapshotIndex(file: string): number {
  const match = /^(\d+)_/.exec(file);
  return match ? Number(match[1]) : Number.NaN;
}

/** Read `id`/`prevId` out of every snapshot in a drizzle `meta` directory. */
export function loadSnapshotMetas(metaDir: string): SnapshotMeta[] {
  return readdirSync(metaDir)
    .filter((f) => /^\d+_snapshot\.json$/.test(f))
    .sort((a, b) => snapshotIndex(a) - snapshotIndex(b))
    .map((file) => {
      const parsed = JSON.parse(readFileSync(join(metaDir, file), 'utf8')) as {
        id?: string;
        prevId?: string;
      };
      return { file, id: parsed.id ?? '', prevId: parsed.prevId ?? '' };
    });
}

/**
 * Pick the snapshot that represents the current schema, or refuse to.
 *
 * The tip is the highest-numbered snapshot. It is trustworthy only if no other
 * snapshot was generated from the same parent — a sibling means the two of them
 * split the schema between themselves.
 *
 * Deliberately narrow: only a fork AT THE TIP is fatal. Older fragments dangle
 * in this repo as residue from past renumbering (a snapshot whose successor was
 * deleted leaves a tip behind), and those have been harmless for a long time.
 * Failing on them would block every release to re-litigate settled history.
 * A root snapshot's `prevId` is empty, so multiple roots are not a fork either.
 */
export function resolveSnapshotSelection(
  metas: readonly SnapshotMeta[]
): SnapshotSelection {
  if (metas.length === 0) return { kind: 'empty' };

  const ordered = [...metas].sort((a, b) => snapshotIndex(a.file) - snapshotIndex(b.file));
  const tip = ordered[ordered.length - 1]!;

  const siblings = tip.prevId
    ? ordered.filter((m) => m.file !== tip.file && m.prevId === tip.prevId).map((m) => m.file)
    : [];

  if (siblings.length > 0) {
    return { kind: 'forked', file: tip.file, siblings, prevId: tip.prevId };
  }
  return { kind: 'resolved', file: tip.file, siblings: [] };
}

// ─── drizzle v1 snapshots ────────────────────────────────────────────────────
//
// v1 keeps one snapshot per migration folder, format v8: `id`, `prevIds[]`
// (several parents after a commutative merge) and a flat `ddl[]` of entities.
// A root snapshot's only parent is the all-zero id.

// The nil UUID, built from its shape: a literal would read as a row id to the
// no-prod-data gate, and this is drizzle's fixed "no parent" marker.
export const ROOT_SNAPSHOT_ID = [8, 4, 4, 4, 12].map((n) => '0'.repeat(n)).join('-');

export interface SnapshotMetaV1 {
  /** `<folder>/snapshot.json`, relative to the drizzle dir. */
  file: string;
  id: string;
  prevIds: string[];
}

/** `id`/`prevIds` of every folder snapshot, in folder-name order. */
export function loadSnapshotMetasV1(drizzleDir: string): SnapshotMetaV1[] {
  return readMigrationTree(drizzleDir).map((m) => {
    const file = `${m.name}/snapshot.json`;
    const parsed = JSON.parse(readFileSync(join(drizzleDir, file), 'utf8')) as { id?: string; prevIds?: string[] };
    return { file, id: parsed.id ?? '', prevIds: Array.isArray(parsed.prevIds) ? parsed.prevIds : [] };
  });
}

/** prevIds that name no snapshot in the tree (other than the root marker). */
export function snapshotChainGaps(metas: readonly SnapshotMetaV1[]): string[] {
  const ids = new Set(metas.map((m) => m.id));
  return metas.flatMap((m) =>
    m.prevIds.filter((p) => p !== ROOT_SNAPSHOT_ID && !ids.has(p)).map((p) => `${m.file}: prevId ${p} is not in the tree`)
  );
}

/**
 * The v1 counterpart of resolveSnapshotSelection, with the same deliberately
 * narrow rule: the tip (newest folder) is untrustworthy only if another
 * snapshot was generated from one of its parents, i.e. two branches each added
 * a migration and nothing merged them. A merge snapshot names both leaves in
 * its prevIds and resolves normally. Roots are never siblings.
 */
export function resolveSnapshotSelectionV1(metas: readonly SnapshotMetaV1[]): SnapshotSelection {
  if (metas.length === 0) return { kind: 'empty' };
  const ordered = [...metas].sort((a, b) => a.file.localeCompare(b.file));
  const tip = ordered[ordered.length - 1]!;
  const parents = tip.prevIds.filter((p) => p !== ROOT_SNAPSHOT_ID);
  const siblings = ordered.filter((m) => m !== tip && m.prevIds.some((p) => parents.includes(p)));
  if (siblings.length > 0) {
    const shared = parents.find((p) => siblings.some((m) => m.prevIds.includes(p)))!;
    return { kind: 'forked', file: tip.file, siblings: siblings.map((m) => m.file), prevId: shared };
  }
  return { kind: 'resolved', file: tip.file, siblings: [] };
}

/**
 * table -> columns a snapshot expects, from either format: v7 and earlier
 * (`tables{}` with `columns{}`) or v8 (`ddl[]` of `tables` / `columns`
 * entities). Throws on anything else: expecting nothing would pass every DB.
 */
export function expectedColumnsFromSnapshot(snapshot: unknown): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const s = snapshot as {
    tables?: Record<string, { name: string; columns: Record<string, { name: string }> }>;
    ddl?: Array<{ entityType?: string; name?: string; table?: string }>;
  };
  if (Array.isArray(s?.ddl)) {
    for (const e of s.ddl) if (e.entityType === 'tables' && e.name) result.set(e.name, new Set());
    for (const e of s.ddl) {
      if (e.entityType !== 'columns' || !e.table || !e.name) continue;
      if (!result.has(e.table)) result.set(e.table, new Set());
      result.get(e.table)!.add(e.name);
    }
    return result;
  }
  if (s?.tables && typeof s.tables === 'object') {
    for (const table of Object.values(s.tables)) {
      result.set(table.name, new Set(Object.values(table.columns).map((c) => c.name)));
    }
    return result;
  }
  throw new Error('Unrecognised drizzle snapshot format: neither tables{} (v7) nor ddl[] (v8)');
}

// ─── Extra-object classification ─────────────────────────────────────────────

export interface ExtraClassificationInput {
  sources: readonly MigrationSource[];
  /** `created_at` values present in __drizzle_migrations. */
  appliedWhens: ReadonlySet<number>;
  /** `name` values present in __drizzle_migrations (v1 rows). */
  appliedNames?: ReadonlySet<string>;
  /** Snapshot expectation: table -> columns. */
  expected: ReadonlyMap<string, ReadonlySet<string>>;
  /** Live introspection: table -> columns. */
  actual: ReadonlyMap<string, ReadonlySet<string>>;
  /** Tables some migration drops (the drop may not have run yet). */
  droppedTables: ReadonlySet<string>;
  /** `table.column` entries some migration drops. */
  droppedColumns: ReadonlySet<string>;
  /** Tables the migrator owns, which are never in a snapshot. */
  ignoredTables: ReadonlySet<string>;
}

export interface ExtraClassification {
  /** Created by a journal migration the DB records as applied, but absent from
   *  the chosen snapshot. A snapshot-coverage problem, never manual DDL. */
  snapshotGap: string[];
  /** A migration drops it and has not run yet — migrations run after this gate. */
  pendingDrop: string[];
  /** No migration in the journal creates it. The only genuine drift. */
  manualDdl: string[];
  /** Created by a journal migration not yet recorded as applied. */
  notYetApplied: string[];
}

/**
 * Split objects the DB has but the snapshot does not into snapshot gap /
 * pending drop / manual DDL, and say which migration decided it.
 *
 * The missing-object path has always traced an object to its creating migration
 * before calling it drift (`classifyMissingSchemaObjects`). The extra-object
 * path did not: it excused a table only via a pending DROP, and otherwise
 * asserted `untracked manual DDL`. That asymmetry is what let a fully-migrated
 * table be reported as a hand-edited production database. The two paths now ask
 * the same question.
 */
export function classifyExtraSchemaObjects(
  input: ExtraClassificationInput
): ExtraClassification {
  const { sources, appliedWhens, appliedNames, expected, actual, droppedTables, droppedColumns, ignoredTables } =
    input;

  const creators = addedBy(sources);
  const result: ExtraClassification = {
    snapshotGap: [],
    pendingDrop: [],
    manualDdl: [],
    notYetApplied: [],
  };

  const classify = (target: string) => {
    const creator = creators.get(target);
    if (!creator) {
      result.manualDdl.push(`${target} — no migration in the journal creates it`);
    } else if (isRecorded(creator, appliedWhens, appliedNames)) {
      result.snapshotGap.push(
        `${target} — created by ${creator.tag}, which __drizzle_migrations records as APPLIED`
      );
    } else {
      result.notYetApplied.push(`${target} — created by ${creator.tag} (not yet applied)`);
    }
  };

  for (const [table, actualColumns] of actual) {
    if (ignoredTables.has(table)) continue;

    if (!expected.has(table)) {
      if (droppedTables.has(table)) result.pendingDrop.push(table);
      else classify(table);
      // A table the snapshot has never heard of has no per-column expectation to
      // compare against, so its columns are not separately classified.
      continue;
    }

    const expectedColumns = expected.get(table)!;
    for (const column of actualColumns) {
      if (expectedColumns.has(column)) continue;
      const target = `${table}.${column}`;
      if (droppedColumns.has(target)) result.pendingDrop.push(target);
      else classify(target);
    }
  }

  return result;
}

// ─── Applied-count reconciliation ────────────────────────────────────────────

export interface AppliedCountReconciliation {
  journalEntries: number;
  appliedTotal: number;
  /** Applied rows that correspond to a journal entry on this ref. */
  appliedFromJournal: number;
  /** Journal entries with no applied row — they run on deploy, after this gate. */
  pending: number;
  /**
   * Applied rows with no journal entry on this ref. Expected and harmless: the
   * tracking table is append-only apply history, while the journal is only what
   * this ref currently carries. A rebuilt/squashed journal and any renumbered
   * migration both leave rows behind permanently.
   */
  historicalOutsideRef: number;
  /** Whether the three numbers add up, i.e. the split explains the total. */
  reconciles: boolean;
}

/**
 * Explain a tracking-table total that exceeds the journal, rather than printing
 * the two numbers side by side and letting a reader infer that production has
 * migrations this ref does not know about.
 */
export function reconcileAppliedCount(input: {
  sources: readonly MigrationSource[];
  appliedWhens: ReadonlySet<number>;
  /** v1 rows' names. A source recorded both ways counts once. */
  appliedNames?: ReadonlySet<string>;
  /** Tracking rows in total, when it is not simply the number of distinct created_at values. */
  appliedTotal?: number;
}): AppliedCountReconciliation {
  const appliedTotal = input.appliedTotal ?? input.appliedWhens.size;
  const appliedFromJournal = input.sources.filter((s) => isRecorded(s, input.appliedWhens, input.appliedNames)).length;
  const historicalOutsideRef = appliedTotal - appliedFromJournal;
  const pending = input.sources.length - appliedFromJournal;

  return {
    journalEntries: input.sources.length,
    appliedTotal,
    appliedFromJournal,
    pending,
    historicalOutsideRef,
    reconciles: appliedFromJournal + historicalOutsideRef === appliedTotal,
  };
}
