import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { sql, type SQL } from 'drizzle-orm';
import { hostname } from 'os';
import { config } from '../config';
import { applyNeonLocalOverride } from './neon-local';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import {
  executionOrder,
  findBaselineMillis,
  planMigrations,
  planMigrationsV1,
  type JournalLike,
  type MigrationFile,
} from './migrate-plan';
import { backfillTrackingRows, ciCloneApplyAbsentEnabled, CI_CLONE_APPLY_ABSENT_ENV } from './migrate-backfill';
import { withMigrationLock } from './migrate-lock';
import {
  ensureTrackingTable,
  lockDriver,
  readAppliedRows,
  readDbShape,
  readTrackingRows,
  recordApplied,
  trackingInsert,
  upgradeTrackingTable,
  type MigrateSession,
} from './migrate-client';
import { detectLayout, readMigrationTree, type TreeMigration } from './migrate-tree';
import { LEGACY_MIGRATIONS_ENV, LEGACY_MIGRATIONS_PATH, loadLegacyMap } from './legacy-migrations';
import { applyV1 } from './migrate-apply';

const __dirname = dirname(fileURLToPath(import.meta.url));
// BUILDD_MIGRATIONS_DIR points the migrator at another migration tree. It exists
// for the squash-equivalence proof (scripts/ci/migration-squash-equivalence.ts and
// apps/web/tests/db/migration-baseline.test.ts), which replays the pre-squash tree
// from git history through this same migrator. Nothing in a deploy sets it.
const migrationsFolder = process.env.BUILDD_MIGRATIONS_DIR || join(__dirname, '..', 'drizzle');

/**
 * MIGRATE_EXPECT_NOOP=1: the prod-clone dry run. Fail, before executing or
 * recording anything, unless the run would execute no DDL and backfill
 * nothing: on a v1 tree every legacy migration must already have its row and
 * the only pending post-cutover migrations may be comment-only (the snapshot
 * rebase). Logs name repo migrations only, never row counts: CI logs here are
 * world-readable.
 */
const EXPECT_NOOP_ENV = 'MIGRATE_EXPECT_NOOP';
const expectNoop = process.env[EXPECT_NOOP_ENV] === '1';

class ExpectNoopError extends Error {
  constructor(problems: string[]) {
    super(`${EXPECT_NOOP_ENV}=1 and this run is not a no-op:\n  ${problems.join('\n  ')}`);
    this.name = 'ExpectNoopError';
  }
}

async function applyMigrations(session: MigrateSession): Promise<void> {
  // Fetch ALL applied migration timestamps (not just the last). This read now
  // happens INSIDE the migration lock — two concurrent deploys used to both read
  // before either wrote, compute the same `toRun`, and race each other through
  // it.
  const rows = await readAppliedRows(session);
  const migrations = readMigrationFiles({ migrationsFolder });

  // A missing tracking row does NOT mean a migration never ran — it can mean it
  // ran but the tracking insert was lost. Only migrations newer than the
  // high-water mark are safe to execute blind; anything older with a missing row
  // is a backfill CANDIDATE, and must prove its DDL is already present before a
  // tracking row is written. See migrate-plan.ts and migrate-backfill.ts.
  //
  // The squashed baseline (if this tree has one) runs only on an empty tracking
  // table; planMigrations throws PreBaselineDatabaseError for a database that
  // stopped partway through the history it absorbed.
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')
  ) as JournalLike;
  const baselineMillis = findBaselineMillis(journal);
  const { toRun, toBackfill } = planMigrations(migrations, rows, { baselineMillis });
  if (expectNoop && (toRun.length > 0 || toBackfill.length > 0)) {
    throw new ExpectNoopError([
      ...toRun.map((m) => `would execute ${m.folderMillis}`),
      ...toBackfill.map((m) => `would backfill-check ${m.folderMillis}`),
    ]);
  }

  let backfilled = 0;
  let toApply: MigrationFile[] = [];
  const applyAbsent = ciCloneApplyAbsentEnabled(process.env);
  if (applyAbsent) {
    console.log(
      `${CI_CLONE_APPLY_ABSENT_ENV}=1 (CI prod clone): an untracked migration below the high-water ` +
        `mark whose DDL is wholly absent will be executed instead of refused`
    );
  }
  if (toBackfill.length > 0) {
    console.log(
      `${toBackfill.length} untracked migration(s) predate the high-water mark — ` +
        `introspecting the live schema to check whether their DDL is already applied...`
    );
    const shape = await readDbShape(session);
    console.log(
      `  live schema: ${shape.tables.size} tables, ${shape.columns.size} columns, ` +
        `${shape.indexes.size} indexes, ${shape.constraints.size} constraints`
    );
    const result = await backfillTrackingRows({
      toBackfill,
      shape,
      allowUnverified: process.env.MIGRATION_BACKFILL_ALLOW_UNVERIFIED === '1',
      applyAbsent,
      log: (message) => console.log(message),
      record: (migration) => recordApplied(session, migration),
    });
    backfilled = result.recorded;
    toApply = result.toApply;
    if (result.unverified > 0) {
      console.log(
        `  ${result.unverified} migration(s) were recorded WITHOUT DDL evidence via ` +
          `MIGRATION_BACKFILL_ALLOW_UNVERIFIED=1`
      );
    }
  }

  const toExecute = executionOrder(migrations, toRun, toApply);
  for (const migration of toExecute) {
    for (const stmt of migration.sql) {
      await session.execute(sql.raw(stmt));
    }

    // Record only after every statement in the file succeeded. A failure above
    // leaves no row, so the next run retries rather than believing a
    // half-applied migration finished.
    await recordApplied(session, migration);

    console.log(`Applied: ${migration.folderMillis} (${migration.sql.length} statement(s))`);
  }

  console.log(
    `Migrations complete! (${toExecute.length} applied` +
      (toApply.length > 0 ? `, ${toApply.length} of them below the mark on a CI clone` : '') +
      `, ${backfilled} backfilled)`
  );
}

/**
 * The drizzle v1 folder layout. Order matters and is the whole point:
 *   1. read rows and plan: planMigrationsV1 throws PreBaselineDatabaseError for
 *      a database partway through the squashed history BEFORE anything below
 *      touches it, including the tracking-table upgrade;
 *   2. upgrade the tracking table (additive, idempotent) and name the legacy
 *      rows matched by exact-ms created_at;
 *   3. backfill-with-evidence for legacy rows lost below the legacy mark;
 *   4. record comment-only migrations; execute the rest, each file atomically
 *      with its tracking row.
 * See migrate-plan.ts, legacy-migrations.ts and migrate-apply.ts.
 */
async function applyMigrationsV1(session: MigrateSession, runBatch: (queries: SQL[]) => Promise<void>): Promise<void> {
  const tree = readMigrationTree(migrationsFolder);
  const legacyPath = process.env[LEGACY_MIGRATIONS_ENV] || LEGACY_MIGRATIONS_PATH;
  const legacy = loadLegacyMap(legacyPath);

  const rows = await readTrackingRows(session);
  const plan = planMigrationsV1(tree, rows, legacy);

  const pendingPostCutover = plan.toRun.filter((m) => !plan.legacyNames.has(m.name));
  if (expectNoop) {
    const problems = [
      ...plan.unrecordedLegacy.map((name) => `legacy migration ${name} has no tracking row`),
      ...plan.toRun.map((m) => `would execute ${m.name}`),
      ...plan.toBackfill.map((m) => `would backfill-check ${m.name}`),
    ];
    if (problems.length > 0) throw new ExpectNoopError(problems);
    console.log(
      `${EXPECT_NOOP_ENV}=1: no DDL to execute; recording only ` +
        (plan.toRecordOnly.map((m) => m.name).join(', ') || '(nothing)')
    );
  }

  for (const name of plan.hashMismatches) {
    // Not fatal: migrations were edited in place to make them idempotent after
    // they ran (PR #1288), so a historical row can legitimately carry an older hash.
    console.log(`  [note] ${name}: tracking row hash differs from the file (edited after it ran)`);
  }
  await upgradeTrackingTable(session, plan.nameUpdates);

  let backfilled = 0;
  let toApply: TreeMigration[] = [];
  if (plan.toBackfill.length > 0) {
    const applyAbsent = ciCloneApplyAbsentEnabled(process.env);
    console.log(
      `${plan.toBackfill.length} untracked legacy migration(s) predate the legacy high-water mark — ` +
        `introspecting the live schema to check whether their DDL is already applied...`
    );
    const result = await backfillTrackingRows({
      toBackfill: plan.toBackfill,
      shape: await readDbShape(session),
      allowUnverified: process.env.MIGRATION_BACKFILL_ALLOW_UNVERIFIED === '1',
      applyAbsent,
      log: (message) => console.log(message),
      record: (migration) => recordApplied(session, migration as TreeMigration),
    });
    backfilled = result.recorded;
    toApply = result.toApply as TreeMigration[];
  }

  const legacyOrder = new Map(legacy.map((e, i) => [e.name, i]));
  const legacyToRun = [...plan.toRun.filter((m) => plan.legacyNames.has(m.name)), ...toApply].sort(
    (a, b) => legacyOrder.get(a.name)! - legacyOrder.get(b.name)!
  );

  const result = await applyV1(
    { toExecute: [...legacyToRun, ...pendingPostCutover], toRecordOnly: plan.toRecordOnly, legacyNames: plan.legacyNames },
    {
      execute: async (statement) => {
        await session.execute(sql.raw(statement));
      },
      executeAtomic: (statements, migration) =>
        runBatch([...statements.map((s) => sql.raw(s)), trackingInsert(migration)]),
      record: (migration) => recordApplied(session, migration),
      readShape: () => readDbShape(session),
      log: (message) => console.log(message),
    }
  );

  console.log(
    `Migrations complete! (${result.executed.length} applied, ${backfilled} backfilled, ` +
      `${result.recordedOnly.length + result.recordedPresent.length} recorded without executing)`
  );
}

async function main() {
  console.log('Running migrations from:', migrationsFolder);
  if (applyNeonLocalOverride({ ...process.env, DATABASE_URL: config.databaseUrl })) {
    console.log('Using local Neon HTTP proxy:', process.env.NEON_LOCAL_FETCH_ENDPOINT);
  }

  // Retry loop for Neon preview branch cold starts. The CI now extracts
  // the connection URI directly from the Neon API, so "password authentication
  // failed" should be rare. Retries mainly cover ECONNREFUSED / endpoint-disabled.
  const maxAttempts = 24;
  const retryDelayMs = 5000;

  const holder = `${hostname()}/pid${process.pid}/${Math.random().toString(36).slice(2, 8)}`;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const neonSql = neon(config.databaseUrl);
      // Object form: drizzle v1 reads a positional client as a config object
      // and silently builds its own client instead of using this one.
      const db = drizzle({ client: neonSql });
      // The public `db.execute` is all the migrator needs (see MigrateSession).
      const session: MigrateSession = db;
      // One neon-http transaction per call: `db.batch` maps to the driver's
      // non-interactive `transaction([...])`, unlike `db.transaction()`, which
      // neon-http does not support. Pinned in migrate-driver-contract.test.ts.
      const runBatch = async (queries: SQL[]) => {
        const [first, ...rest] = queries.map((q) => db.execute(q));
        await db.batch([first!, ...rest]);
      };

      // Fail closed on a mixed or empty tree before connecting to anything.
      const layout = detectLayout(migrationsFolder);
      console.log(`Migration layout: ${layout}`);

      await ensureTrackingTable(session);

      // Serialise concurrent deploys. `pg_advisory_lock` is not available on
      // this driver (see migrate-lock.ts); this is a lock row taken by one
      // atomic statement. The loser waits and then finds nothing to do.
      await withMigrationLock(lockDriver(session), { holder, log: (m) => console.log(m) }, () =>
        layout === 'v1' ? applyMigrationsV1(session, runBatch) : applyMigrations(session)
      );

      process.exit(0);
    } catch (err: any) {
      const msg: string = err?.message || String(err);
      // neon-http query errors often carry the real Postgres detail on nested
      // properties rather than in `message` — surface everything we can so a
      // failure like this doesn't show a bare query with no cause again.
      const detail = [err?.cause?.message, err?.detail, err?.hint, err?.position]
        .filter(Boolean)
        .join(' | ');
      const isTransient =
        msg.includes('endpoint is disabled') ||
        msg.includes('connect ECONNREFUSED') ||
        msg.includes('ENOTFOUND') ||
        msg.includes('password authentication failed');

      if (isTransient && attempt < maxAttempts) {
        console.log(`Attempt ${attempt}/${maxAttempts} failed (${msg}), retrying in ${retryDelayMs / 1000}s...`);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      } else {
        console.error('Migration failed:', msg, detail ? `| ${detail}` : '');
        process.exit(1);
      }
    }
  }
}

main();
