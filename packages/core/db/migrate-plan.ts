// Pure planning logic for db/migrate.ts, split out so it's unit-testable without
// a live database connection.

import { assertLegacyMapMatchesTree, type LegacyMigration } from './legacy-migrations';
import { isCommentOnly, type TreeMigration } from './migrate-tree';

export interface MigrationFile {
  hash: string;
  folderMillis: number;
  sql: string[];
}

export interface AppliedRow {
  created_at: string | number;
}

// ─── Squashed baseline ───────────────────────────────────────────────────────
//
// Every migration released up to the squash was condensed into one migration:
// a schema dump of a fresh database migrated through that whole history. The
// legacy map flags it `baseline: true` with the `when` of the last migration it
// absorbed, so a database that already ran that migration holds the tracking
// row and skips it, exactly like any applied migration.
//
// It is only safe to execute on an EMPTY tracking table. A database that
// stopped partway through the absorbed history already holds some of what the
// dump creates: running it would fail on the first existing object, after
// having created everything before it. Such a database has to finish the old
// history first, with a release that still ships it.

/**
 * The newest release whose migration tree still carries the individual
 * migrations the baseline absorbed (its last migration is the cut point). A
 * database must reach it before it can upgrade past the squash.
 */
export const LAST_RELEASE_BEFORE_SQUASH = 'v0.284.0';

export class PreBaselineDatabaseError extends Error {
  constructor(highWaterMark: number, baselineMillis: number) {
    super(
      `This database stopped partway through the migration history that was squashed into ` +
        `the baseline migration: its newest applied migration (created_at ${highWaterMark}) is older ` +
        `than the baseline's cut point (${baselineMillis}). Running the baseline here would collide with ` +
        `the objects it already has. Upgrade it first with release ${LAST_RELEASE_BEFORE_SQUASH} ` +
        `(\`git checkout ${LAST_RELEASE_BEFORE_SQUASH} && cd packages/core && bun db:migrate\`), ` +
        `then run this release's migrations. Do NOT hand-insert tracking rows.`
    );
    this.name = 'PreBaselineDatabaseError';
  }
}

// ─── drizzle v1 folder layout ────────────────────────────────────────────────
//
// After the cutover a migration is applied iff
//   (1) a tracking row carries its folder `name`; or
//   (2) it is in the legacy map and a row's created_at equals its exact-ms
//       journal `when` (rows the old migrator wrote, before names existed).
//
// The legacy high-water mark and the evidence-gated backfill govern legacy
// migrations only, exactly as planMigrations does today. Post-cutover
// migrations have no mark: each runs atomically with its tracking insert
// (migrate-apply.ts), and one with no row whose DDL is already present is
// recorded rather than replayed (decided at apply time, against the live
// schema). Comment-only post-cutover migrations (the snapshot rebase) are
// recorded without execution.

export interface TrackingRow {
  name: string | null;
  hash?: string | null;
  created_at: string | number | null;
}

export interface MigrationPlanV1 {
  /**
   * To execute, in order: legacy migrations (legacy-map order, folderMillis =
   * the legacy ms `when`, so the old migrator still recognises the row) then
   * post-cutover migrations (name order, folderMillis = Date.UTC(prefix)).
   * Post-cutover entries are evidence-checked before executing.
   */
  toRun: TreeMigration[];
  /** Legacy only: no row, at or below the legacy mark. Prove the DDL or refuse. */
  toBackfill: TreeMigration[];
  /** Post-cutover, comment-only, no row: record without executing. */
  toRecordOnly: TreeMigration[];
  /** Legacy rows to name: matched by exact-ms created_at, `name` still NULL. */
  nameUpdates: Array<{ when: number; name: string }>;
  /** Legacy names whose matched row has a different hash. Logged, not fatal. */
  hashMismatches: string[];
  /** Legacy names with no tracking row at all (before this run). */
  unrecordedLegacy: string[];
  /** Names that are legacy, for callers that treat the two kinds differently. */
  legacyNames: ReadonlySet<string>;
}

/**
 * Plan a v1 tree against the tracking table. Throws PreBaselineDatabaseError
 * for a database partway through the squashed history (before the caller has
 * touched anything, including the tracking-table upgrade), and refuses a row
 * whose name disagrees with the legacy map.
 */
export function planMigrationsV1(
  tree: readonly TreeMigration[],
  rows: readonly TrackingRow[],
  legacy: readonly LegacyMigration[]
): MigrationPlanV1 {
  assertLegacyMapMatchesTree(legacy, tree);
  const legacyNames = new Set(legacy.map((e) => e.name));
  const byName = new Map(tree.map((m) => [m.name, m]));

  const namedRows = new Map<string, TrackingRow>();
  const rowsByWhen = new Map<number, TrackingRow[]>();
  for (const row of rows) {
    if (row.name) namedRows.set(row.name, row);
    const when = Number(row.created_at);
    if (Number.isFinite(when)) rowsByWhen.set(when, [...(rowsByWhen.get(when) ?? []), row]);
  }

  // Match each legacy entry to its row: by name, else by exact-ms created_at on
  // a row that has no name yet. A named row at a legacy `when` that names
  // something else means the table and the map disagree about history.
  const matched = new Map<string, TrackingRow>();
  const nameUpdates: MigrationPlanV1['nameUpdates'] = [];
  for (const e of legacy) {
    const atWhen = rowsByWhen.get(e.when) ?? [];
    for (const row of atWhen) {
      if (row.name && row.name !== e.name) {
        throw new Error(
          `Tracking row at created_at ${e.when} is named ${row.name}, but the legacy migration map says ` +
            `${e.name} (${e.tag}). The tracking table and the map disagree about history; refusing to guess.`
        );
      }
    }
    const named = namedRows.get(e.name);
    if (named && Number(named.created_at) !== e.when) {
      throw new Error(
        `Tracking row named ${e.name} has created_at ${String(named.created_at)}, but the legacy migration map ` +
          `says ${e.when}. The tracking table and the map disagree about history; refusing to guess.`
      );
    }
    const row = named ?? atWhen.find((r) => !r.name);
    if (!row) continue;
    matched.set(e.name, row);
    if (!row.name) nameUpdates.push({ when: e.when, name: e.name });
  }

  const legacyMark = Math.max(0, ...legacy.filter((e) => matched.has(e.name)).map((e) => e.when));
  // Every legacy migration ran before the cutover release wrote its first
  // post-cutover row, so once one exists a missing legacy row cannot mean
  // "never ran", whatever its `when`.
  const postCutoverRecorded = rows.some((r) => r.name && !legacyNames.has(r.name));

  const asLegacy = (e: LegacyMigration): TreeMigration => ({ ...byName.get(e.name)!, folderMillis: e.when });
  const toRun: TreeMigration[] = [];
  const toBackfill: TreeMigration[] = [];
  let pending = legacy;

  const baseline = legacy[0]?.baseline ? legacy[0] : undefined;
  if (baseline) {
    pending = legacy.slice(1);
    if (rows.length === 0) {
      toRun.push(asLegacy(baseline));
    } else if (legacyMark < baseline.when) {
      throw new PreBaselineDatabaseError(legacyMark, baseline.when);
    }
    // Otherwise the database is at or past the cut point: skip the baseline,
    // whether or not its own row survived (as planMigrations does).
  }

  for (const e of pending) {
    if (matched.has(e.name)) continue;
    if (postCutoverRecorded || e.when <= legacyMark) toBackfill.push(asLegacy(e));
    else toRun.push(asLegacy(e));
  }

  const toRecordOnly: TreeMigration[] = [];
  for (const m of tree) {
    if (legacyNames.has(m.name) || namedRows.has(m.name)) continue;
    if (isCommentOnly(m.sql)) toRecordOnly.push(m);
    else toRun.push(m);
  }

  return {
    toRun,
    toBackfill,
    toRecordOnly,
    nameUpdates,
    hashMismatches: legacy.filter((e) => {
      const hash = matched.get(e.name)?.hash;
      return hash != null && hash !== e.hash;
    }).map((e) => e.name),
    unrecordedLegacy: legacy.filter((e) => !matched.has(e.name)).map((e) => e.name),
    legacyNames,
  };
}

/**
 * The migrations to execute, in journal order: `toRun` plus any below-the-mark
 * migrations the CI clone flag hands back for execution (see
 * CI_CLONE_APPLY_ABSENT_ENV in migrate-backfill.ts). Journal order matters
 * because a branch's own migration can sit after dev's newest one in the
 * journal while carrying an older timestamp.
 */
export function executionOrder(
  migrations: readonly MigrationFile[],
  toRun: readonly MigrationFile[],
  toApply: readonly MigrationFile[]
): MigrationFile[] {
  const selected = new Set<MigrationFile>([...toRun, ...toApply]);
  return migrations.filter((m) => selected.has(m));
}
