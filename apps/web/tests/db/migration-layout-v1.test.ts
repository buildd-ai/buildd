/**
 * The drizzle v1 folder layout, migrated through the app's own migrator on real
 * Postgres. Design: knowledge-base buildd/design/drizzle-v1-migration-layout.md.
 *
 * The tree under test is the repo's real one: `drizzle-kit up` output, the
 * committed legacy map and the cutover's snapshot rebase, copied per case with
 * any extra probe folders a case needs. The history databases are built the way
 * production's were, by the PREVIOUS release's migrator (with the drizzle it was
 * written against) on the legacy form of the same migrations, rebuilt from the
 * tree by `synthesizeLegacyTree`.
 *
 * Each case runs on its own database on the DATABASE_URL server:
 *   (A) fresh                (F) DB several releases behind
 *   (B) full history          (G) rollback: previous release's migrator applies 0
 *   (C) partial below baseline (H) two migrators at once
 *   (D) lost legacy row        (I) a failing file leaves nothing behind
 *   (E) lost post-cutover row
 *
 * CI's db-architecture job fetches the two tags this reads from git.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { LAST_RELEASE_BEFORE_SQUASH } from '@buildd/core/db/migrate-plan';
import { LEGACY_MIGRATIONS_PATH, loadLegacyMap, type LegacyMigration } from '@buildd/core/db/legacy-migrations';
import { folderMillis, formatFolderPrefix, readMigrationTree } from '@buildd/core/db/migrate-tree';
import { emptyDbShape, evaluateBackfill, type DbShape } from '@buildd/core/db/migrate-backfill';
import { assertDbConfigured, fingerprint, prepareRollbackMigrator, synthesizeLegacyTree, withDb } from './harness';

/**
 * The release whose migrator stands in for "the previous release" in the
 * rollback case (G): the last one before the v1 port. The cutover moves it to
 * the release cut immediately before the cutover merges.
 */
const ROLLBACK_MIGRATOR_REF = 'v0.327.1';

const ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CORE = join(ROOT, 'packages', 'core');
const REAL_TREE = join(CORE, 'drizzle');
// The legacy form of the same history: what the previous release's migrator reads.
const LEGACY_TREE = synthesizeLegacyTree('mv1-legacy');

type JournalEntry = { idx: number; when: number; tag: string; baseline?: boolean };
type Journal = { version: string; dialect: string; entries: JournalEntry[] };
const readJournal = (dir: string): Journal => JSON.parse(readFileSync(join(dir, 'meta', '_journal.json'), 'utf8'));

assertDbConfigured();
const BASE_URL = new URL(process.env.DATABASE_URL!);
const RUN = `mv1_${Date.now().toString(36)}`;
const dbUrl = (name: string) => {
  const u = new URL(BASE_URL.toString());
  u.pathname = `/${name}`;
  return u.toString();
};

let work = '';
const created: string[] = [];

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: BASE_URL.toString() });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function freshDb(label: string): Promise<string> {
  const name = `${RUN}_${label}`;
  await admin((c) => c.query(`CREATE DATABASE ${name}`));
  created.push(name);
  return dbUrl(name);
}

interface V1Tree {
  dir: string;
  legacyPath: string;
  legacy: LegacyMigration[];
}

/** A copy of a legacy tree holding only the journal entries `keep` selects. */
function legacySubset(src: string, label: string, keep: (e: JournalEntry, i: number) => boolean, extra?: { dir: string; entries: JournalEntry[] }): string {
  const dir = join(work, label);
  mkdirSync(join(dir, 'meta'), { recursive: true });
  const journal = readJournal(src);
  const entries = journal.entries.filter(keep);
  for (const e of entries) copyFileSync(join(src, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  if (extra) {
    for (const e of extra.entries) copyFileSync(join(extra.dir, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
    entries.push(...extra.entries);
  }
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }, null, 2));
  return dir;
}

/**
 * A per-case copy of the real tree as the cutover left it (the legacy folders
 * and the rebase; migrations written after the cutover are not part of what
 * this file proves) plus any probe folders `post` adds on top. The migrator
 * reads only `migration.sql`; the probe folders get a minimal v8 snapshot
 * chained to the rebase so the layout check and drift gate can still read the tree.
 */
function convertToV1(label: string, post: Array<{ name: string; sql: string }>): V1Tree {
  const dir = join(work, label);
  cpSync(REAL_TREE, dir, { recursive: true });
  const legacy = loadLegacyMap(LEGACY_MIGRATIONS_PATH);
  const cutover = new Set([...legacy.map((e) => e.name), REBASE]);
  for (const m of readMigrationTree(dir)) if (!cutover.has(m.name)) rmSync(join(dir, m.name), { recursive: true, force: true });
  const tip = REBASE;
  const tipSnapshot = JSON.parse(readFileSync(join(REAL_TREE, tip, 'snapshot.json'), 'utf8')) as { id: string; ddl: unknown[] };
  let prev = tipSnapshot.id;
  for (const p of post) {
    if (readdirSync(dir).includes(p.name)) {
      // The case names the real rebase: keep the real folder as it is.
      continue;
    }
    mkdirSync(join(dir, p.name));
    writeFileSync(join(dir, p.name, 'migration.sql'), p.sql);
    const id = `00000000-0000-4000-8000-${String(prev.length).padStart(12, '0')}`;
    writeFileSync(join(dir, p.name, 'snapshot.json'), JSON.stringify({ version: '8', dialect: 'postgres', id, prevIds: [prev], ddl: tipSnapshot.ddl }));
    prev = id;
  }
  return { dir, legacyPath: LEGACY_MIGRATIONS_PATH, legacy };
}

type Run = { status: number; out: string };

function migrate(url: string, tree: string | V1Tree, env: Record<string, string> = {}): Run {
  const r = spawnSync('bun', ['db/migrate.ts'], {
    cwd: CORE,
    encoding: 'utf8',
    env: migrateEnv(url, tree, env),
    timeout: 15 * 60_000,
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

function migrateEnv(url: string, tree: string | V1Tree, env: Record<string, string>) {
  const out: Record<string, string | undefined> = { ...process.env, DATABASE_URL: url, ...env };
  delete out.MIGRATE_EXPECT_NOOP;
  Object.assign(out, env);
  if (typeof tree === 'string') {
    out.BUILDD_MIGRATIONS_DIR = tree;
  } else {
    out.BUILDD_MIGRATIONS_DIR = tree.dir;
    out.BUILDD_LEGACY_MIGRATIONS = tree.legacyPath;
  }
  return out;
}

/**
 * The previous release's migrator (ROLLBACK_MIGRATOR_REF, out of git) on a
 * legacy tree. Every "history" database here is built with it, not with this
 * checkout's legacy path, so its tracking table has exactly the shape prod's
 * has today (`id, hash, created_at`).
 */
function migrateOld(url: string, tree: string): Run {
  const r = spawnSync('bun', ['db/migrate.ts'], {
    cwd: rollbackCore,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: url, BUILDD_MIGRATIONS_DIR: tree },
    timeout: 15 * 60_000,
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

function migrateAsync(url: string, tree: V1Tree): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn('bun', ['db/migrate.ts'], { cwd: CORE, env: migrateEnv(url, tree, {}) });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ status: code ?? -1, out }));
  });
}

/** scripts/check-schema-drift.ts, the release gate, over a v1 tree. */
function driftGate(url: string, tree: V1Tree): Run {
  const r = spawnSync('bun', ['run', 'scripts/check-schema-drift.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: migrateEnv(url, tree, {}),
    timeout: 5 * 60_000,
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

function ok(r: Run): string {
  if (r.status !== 0) throw new Error(`migrate failed (${r.status}):\n${r.out.slice(-3000)}`);
  return r.out;
}

type Row = { id: number; name: string | null; hash: string; created_at: number };
const rows = (url: string) =>
  withDb(url, async (c) => {
    const hasName = (
      await c.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations' AND column_name = 'name'`)
    ).rowCount;
    const r = await c.query<{ id: number; name: string | null; hash: string; created_at: string }>(
      `SELECT id, ${hasName ? 'name' : 'NULL::text AS name'}, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`
    );
    return r.rows.map((x) => ({ ...x, created_at: Number(x.created_at) })) as Row[];
  });

const trackingColumns = (url: string) =>
  withDb(url, async (c) =>
    (
      await c.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations' ORDER BY ordinal_position`
      )
    ).rows.map((r) => r.column_name)
  );

/** The same introspection the migrator's readDbShape does, over pg. */
const shapeOf = (url: string) =>
  withDb(url, async (c) => {
    const shape: DbShape = emptyDbShape();
    for (const r of (await c.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`)).rows) shape.tables.add(r.table_name);
    for (const r of (await c.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`)).rows) shape.columns.add(`${r.table_name}.${r.column_name}`);
    for (const r of (await c.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`)).rows) shape.indexes.add(r.indexname);
    for (const r of (await c.query(`SELECT table_name, constraint_name FROM information_schema.table_constraints WHERE table_schema = 'public'`)).rows) shape.constraints.add(`${r.table_name}.${r.constraint_name}`);
    return shape;
  });

// ─── Trees ───────────────────────────────────────────────────────────────────

const legacyJournal = readJournal(LEGACY_TREE);
const legacyNames = new Set(loadLegacyMap(LEGACY_MIGRATIONS_PATH).map((e) => e.name));
// The cutover's snapshot rebase: the first real folder after the legacy history.
// Migrations written after the cutover come later and are not part of the
// conversion this file proves, so they are left out of its trees.
const REBASE = readMigrationTree(REAL_TREE).map((m) => m.name).find((n) => !legacyNames.has(n))!;
const REBASE_SQL = readFileSync(join(REAL_TREE, REBASE, 'migration.sql'), 'utf8');
const maxWhen = Math.max(...legacyJournal.entries.map((e) => e.when), folderMillis(REBASE));
const DAY = 86_400_000;
const PROBE_E = `${formatFolderPrefix(maxWhen + 2 * DAY)}_probe_e`;
const ATOMIC = `${formatFolderPrefix(maxWhen + 3 * DAY)}_atomic_probe`;

let v1: V1Tree;
let treeE: V1Tree;
let treeI: V1Tree;
let preSquashTree = '';
let rollbackCore = '';

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'migration-layout-v1-'));
  v1 = convertToV1('v1', [{ name: REBASE, sql: REBASE_SQL }]);
  treeE = convertToV1('v1e', [
    { name: REBASE, sql: REBASE_SQL },
    {
      name: PROBE_E,
      sql: 'ALTER TABLE "tasks" ADD COLUMN "probe_e" text;\n--> statement-breakpoint\nCREATE TABLE "probe_e_t" ("id" integer);',
    },
  ]);
  treeI = convertToV1('v1i', [
    { name: REBASE, sql: REBASE_SQL },
    { name: ATOMIC, sql: 'CREATE TABLE "atomic_probe" ("id" integer);\n--> statement-breakpoint\nINSERT INTO "atomic_probe_missing" VALUES (1);' },
  ]);

  // The pre-squash history (as migration-baseline.test.ts builds it): the
  // tag's tree, ending at the baseline's cut point, plus the post-cut entries.
  const extract = join(work, 'archive');
  mkdirSync(extract);
  const archive = spawnSync(
    'sh',
    ['-c', `git -C "$ROOT" archive --format=tar "$TAG" -- 'packages/core/drizzle/*.sql' packages/core/drizzle/meta/_journal.json | tar -x -C "$OUT"`],
    { env: { ...process.env, ROOT, TAG: LAST_RELEASE_BEFORE_SQUASH, OUT: extract }, encoding: 'utf8' }
  );
  if (archive.status !== 0) {
    throw new Error(
      `cannot read ${LEGACY_TREE} at ${LAST_RELEASE_BEFORE_SQUASH} (fetch it: git fetch --no-tags --depth=1 origin ` +
        `+refs/tags/${LAST_RELEASE_BEFORE_SQUASH}:refs/tags/${LAST_RELEASE_BEFORE_SQUASH}):\n${archive.stderr}`
    );
  }
  const postCut = legacyJournal.entries.slice(1);
  preSquashTree = legacySubset(join(extract, 'packages', 'core', 'drizzle'), 'presquash', () => true, { dir: LEGACY_TREE, entries: postCut });

  // The previous release's migrator, out of git, with the drizzle it was written against.
  rollbackCore = prepareRollbackMigrator(work, ROLLBACK_MIGRATOR_REF, ROOT);
}, 300_000);

afterAll(async () => {
  for (const name of created) {
    await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)).catch(() => {});
  }
  if (work) rmSync(work, { recursive: true, force: true });
  rmSync(LEGACY_TREE, { recursive: true, force: true });
}, 120_000);

const summary = (applied: number, backfilled: number, recorded: number) =>
  `(${applied} applied, ${backfilled} backfilled, ${recorded} recorded without executing)`;

describe('drizzle v1 layout through the app migrator (real Postgres)', () => {
  let freshV1 = '';
  let fullHistory = '';
  let fullHistoryShape: string[] = [];
  let fullHistoryRows: Row[] = [];

  it('the converted tree is what the migrator reads: every legacy folder, then the rebase', () => {
    const tree = readMigrationTree(v1.dir);
    expect(tree.map((m) => m.name)).toEqual([...v1.legacy.map((e) => e.name), REBASE].sort((a, b) => a.localeCompare(b)));
    expect(v1.legacy[0]!.baseline).toBe(true);
  });

  it('(A) fresh DB: same schema as the legacy tree builds, every legacy row keeps its ms when, rerun is a no-op', async () => {
    const [legacyUrl, v1Url] = await Promise.all([freshDb('a_legacy'), freshDb('a_v1')]);
    ok(migrateOld(legacyUrl, LEGACY_TREE));
    const out = ok(migrate(v1Url, v1));
    expect(out).toContain('Migration layout: v1');
    expect(out).toContain(summary(v1.legacy.length, 0, 1));
    freshV1 = v1Url;

    const [a, b] = await Promise.all([fingerprint(legacyUrl), fingerprint(v1Url)]);
    expect(a.length).toBeGreaterThan(1000);
    expect(b).toEqual(a);

    const tracked = await rows(v1Url);
    // created_at = exact ms `when` for legacy migrations, so the old migrator
    // (which reads only created_at) recognises every one of them (case G).
    expect(tracked.filter((r) => r.name !== REBASE).map((r) => [r.name, r.created_at])).toEqual(
      v1.legacy.map((e) => [e.name, e.when])
    );
    // rc property (j): a post-cutover row's created_at is Date.UTC(prefix), what stock v1 writes.
    expect(tracked.find((r) => r.name === REBASE)!.created_at).toBe(folderMillis(REBASE));

    expect(ok(migrate(v1Url, v1))).toContain(summary(0, 0, 0));
  }, 20 * 60_000);

  it('(B) full history: names every legacy row, leaves out-of-journal rows alone, runs no DDL, records only the rebase', async () => {
    const url = await freshDb('b_history');
    ok(migrateOld(url, preSquashTree));
    // Rows for migrations outside any journal on this ref: pre-squash
    // renumbers, deleted migrations. The append-only table keeps them forever.
    await withDb(url, (c) =>
      c.query(`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('out-of-journal-a', 1600000000000), ('out-of-journal-b', $1)`, [
        v1.legacy[3]!.when + 7,
      ])
    );
    const before = await rows(url);
    const shape = await fingerprint(url);
    expect(await trackingColumns(url)).toEqual(['id', 'hash', 'created_at']);

    // The release gate runs BEFORE the deploy migrates, i.e. against a tracking
    // table with no names yet: legacy rows must still read as applied.
    const gateBefore = ok(driftGate(url, v1));
    expect(gateBefore).toContain('Schema drift check passed');
    expect(gateBefore).toContain(`v1 tree has ${v1.legacy.length + 1} migrations`);

    // Exactly what the prod-clone dry run asserts: MIGRATE_EXPECT_NOOP passes.
    const out = ok(migrate(url, v1, { MIGRATE_EXPECT_NOOP: '1' }));
    expect(out).toContain(summary(0, 0, 1));
    expect(out).toContain(`recording only ${REBASE}`);

    const after = await rows(url);
    expect(await fingerprint(url)).toEqual(shape);
    expect(after.length).toBe(before.length + 1);
    const byWhen = new Map(after.filter((r) => r.name !== REBASE).map((r) => [r.created_at, r]));
    for (const e of v1.legacy) expect(byWhen.get(e.when)?.name).toBe(e.name);
    const legacyWhens = new Set(v1.legacy.map((e) => e.when));
    const unmatched = after.filter((r) => r.name !== REBASE && !legacyWhens.has(r.created_at));
    expect(unmatched.length).toBeGreaterThan(0);
    for (const r of unmatched) expect(r.name).toBeNull();
    // Nothing that existed was changed but `name`.
    expect(after.slice(0, before.length).map((r) => [r.id, r.hash, r.created_at])).toEqual(
      before.map((r) => [r.id, r.hash, r.created_at])
    );
    expect(after.at(-1)!.name).toBe(REBASE);
    expect(after.at(-1)!.created_at).toBe(folderMillis(REBASE)); // rc property (j)
    expect(await trackingColumns(url)).toEqual(['id', 'hash', 'created_at', 'name', 'applied_at']);

    // rc property (i): stock v1 planning (drizzle-orm migrator.utils
    // getMigrationsToRun, re-implemented read-only) sees zero pending on the
    // upgraded table, so drizzle's own tools would not replay anything either.
    const dbNames = new Set(after.map((r) => r.name).filter((n): n is string => n !== null));
    const stockPending = readMigrationTree(v1.dir).filter((lm) => !lm.name || !dbNames.has(lm.name));
    expect(stockPending).toEqual([]);

    expect(ok(migrate(url, v1, { MIGRATE_EXPECT_NOOP: '1' }))).toContain(summary(0, 0, 0));
    expect(ok(driftGate(url, v1))).toContain('Schema drift check passed');
    fullHistory = url;
    fullHistoryShape = shape;
    fullHistoryRows = await rows(url);
  }, 20 * 60_000);

  it('(G) rollback: the previous release migrator, on its own legacy tree, applies 0 against the upgraded table', async () => {
    expect(fullHistory).not.toBe('');
    const out = ok(migrateOld(fullHistory, LEGACY_TREE));
    expect(out).toContain('(0 applied, 0 backfilled)');
    expect(await fingerprint(fullHistory)).toEqual(fullHistoryShape);
    expect(await rows(fullHistory)).toEqual(fullHistoryRows);
  }, 20 * 60_000);

  it('(C) partial DB below the baseline: refused before any DDL, tracking table untouched', async () => {
    const url = await freshDb('c_partial');
    const old = readJournal(preSquashTree).entries;
    const stopAt = old[Math.floor(old.length / 3)]!.idx;
    ok(migrateOld(url, legacySubset(preSquashTree, 'partial', (e) => e.idx <= stopAt)));
    const [before, shape, columns] = [await rows(url), await fingerprint(url), await trackingColumns(url)];

    const r = migrate(url, v1);
    expect(r.status).toBe(1);
    expect(r.out).toContain('stopped partway through the migration history');
    expect(r.out).toContain(LAST_RELEASE_BEFORE_SQUASH);
    expect(await trackingColumns(url)).toEqual(columns);
    expect(await rows(url)).toEqual(before);
    expect(await fingerprint(url)).toEqual(shape);
  }, 20 * 60_000);

  it('(D) lost legacy row below the mark: backfilled with verified evidence, never replayed', async () => {
    const url = await freshDb('d_lost_legacy');
    ok(migrateOld(url, LEGACY_TREE));
    const shape = await shapeOf(url);
    // A migration below the mark whose replay would crash (plain ADD COLUMN /
    // CREATE TABLE) and whose DDL the final schema still proves.
    const below = v1.legacy.slice(1, -1);
    const victim = below.find((e) => {
      const statements = readFileSync(join(LEGACY_TREE, `${e.tag}.sql`), 'utf8').split('--> statement-breakpoint');
      return evaluateBackfill(statements, shape).verdict === 'verified' && statements.some((s) => /ADD COLUMN "|CREATE TABLE "/.test(s));
    });
    expect(victim).toBeDefined();
    await withDb(url, (c) => c.query(`DELETE FROM drizzle.__drizzle_migrations WHERE created_at = $1`, [victim!.when]));
    const before = await fingerprint(url);

    const out = ok(migrate(url, v1));
    expect(out).toContain(`[backfill] ${victim!.when} verdict=verified`);
    expect(out).toContain(summary(0, 1, 1));
    expect(await fingerprint(url)).toEqual(before);
    const restored = (await rows(url)).filter((r) => r.created_at === victim!.when);
    expect(restored.map((r) => r.name)).toEqual([victim!.name]);
  }, 20 * 60_000);

  it('(E) lost post-cutover row: DDL present -> recorded, not executed; DDL partly present -> refused', async () => {
    const url = await freshDb('e_lost_post');
    ok(migrate(url, treeE));
    const del = () => withDb(url, (c) => c.query(`DELETE FROM drizzle.__drizzle_migrations WHERE name = $1`, [PROBE_E]));

    await del();
    // A replay would fail outright: plain ADD COLUMN / CREATE TABLE.
    const out = ok(migrate(url, treeE));
    expect(out).toContain(`Recorded without executing: ${PROBE_E}`);
    expect(out).toContain(summary(0, 0, 1));
    expect((await rows(url)).filter((r) => r.name === PROBE_E)).toHaveLength(1);

    await del();
    await withDb(url, (c) => c.query(`DROP TABLE "probe_e_t"`));
    const before = await fingerprint(url);
    const r = migrate(url, treeE);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`Refusing ${PROBE_E}`);
    expect(r.out).toContain('PARTLY present');
    expect((await rows(url)).filter((x) => x.name === PROBE_E)).toHaveLength(0);
    expect(await fingerprint(url)).toEqual(before);
  }, 20 * 60_000);

  it('(F) DB several releases behind: missing legacy migrations run in legacy order, then post-cutover', async () => {
    expect(freshV1).not.toBe('');
    const url = await freshDb('f_behind');
    const keep = Math.floor(legacyJournal.entries.length / 2);
    ok(migrateOld(url, legacySubset(LEGACY_TREE, 'behind', (_e, i) => i < keep)));
    const columns = await trackingColumns(url);

    // The strict dry-run mode refuses a DB that is behind, before touching it.
    const dry = migrate(url, v1, { MIGRATE_EXPECT_NOOP: '1' });
    expect(dry.status).toBe(1);
    expect(dry.out).toContain('is not a no-op');
    expect(await trackingColumns(url)).toEqual(columns);

    const out = ok(migrate(url, v1));
    const missing = v1.legacy.slice(keep).map((e) => e.name);
    expect(out).toContain(summary(missing.length, 0, 1));
    const appliedOrder = [...out.matchAll(/^Applied: (\S+)/gm)].map((m) => m[1]);
    expect(appliedOrder).toEqual(missing);
    expect(await fingerprint(url)).toEqual(await fingerprint(freshV1));
    expect((await rows(url)).map((r) => r.created_at).filter((w) => w !== folderMillis(REBASE))).toEqual(v1.legacy.map((e) => e.when));
  }, 20 * 60_000);

  it('drift gate on a v1 tree: a column whose migration is recorded as applied but is missing is DRIFT', async () => {
    const url = await freshDb('drift');
    ok(migrate(url, v1));
    expect(ok(driftGate(url, v1))).toContain('Schema drift check passed');
    await withDb(url, (c) => c.query(`ALTER TABLE "tasks" DROP COLUMN "title" CASCADE`));
    const r = driftGate(url, v1);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/MISSING in DB {2}: tasks\.title — added by \S+, which __drizzle_migrations records as APPLIED/);
  }, 20 * 60_000);

  it('(H) two migrators at once: one applies, the other finds nothing to do', async () => {
    const url = await freshDb('h_concurrent');
    const [a, b] = await Promise.all([migrateAsync(url, v1), migrateAsync(url, v1)]);
    ok(a);
    ok(b);
    const outs = [a.out, b.out];
    expect(outs.filter((o) => o.includes(summary(v1.legacy.length, 0, 1)))).toHaveLength(1);
    expect(outs.filter((o) => o.includes(summary(0, 0, 0)))).toHaveLength(1);
    const tracked = await rows(url);
    expect(new Set(tracked.map((r) => r.name)).size).toBe(tracked.length);
    expect(tracked).toHaveLength(v1.legacy.length + 1);
  }, 20 * 60_000);

  it('(I) atomicity: a file whose 2nd statement fails leaves neither its 1st statement nor a tracking row', async () => {
    const url = await freshDb('i_atomic');
    ok(migrate(url, v1));
    const r = migrate(url, treeI);
    expect(r.status).toBe(1);
    expect(r.out).toContain('atomic_probe_missing');
    const exists = await withDb(url, async (c) => (await c.query(`SELECT to_regclass('public.atomic_probe') AS t`)).rows[0]!.t);
    expect(exists).toBeNull();
    expect((await rows(url)).filter((x) => x.name === ATOMIC)).toHaveLength(0);
  }, 20 * 60_000);
});
