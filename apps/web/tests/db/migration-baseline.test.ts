/**
 * The migration squash, proven on real Postgres.
 *
 * Every migration released up to the cut point was condensed into
 * packages/core/drizzle/0000_baseline.sql (a pg_dump). This file replays the
 * PRE-squash tree — read out of git at LAST_RELEASE_BEFORE_SQUASH, whose last
 * migration is the cut point, plus the untouched post-cut migrations from this
 * tree — through the app's own migrator, and checks:
 *
 *   (a) a fresh DB migrated through the new tree has the same schema as a
 *       fresh DB migrated through the old one (the equivalence proof);
 *   (b) a DB that ran the old tree up to the cut (where every released DB is)
 *       only runs the post-cut migrations, ends up identical, and a second run
 *       is a no-op;
 *   (c) a DB that stopped partway through the old history is refused loudly,
 *       untouched, naming the release to upgrade through.
 *
 * Each case gets its own database on the DATABASE_URL server. CI's
 * db-architecture job fetches the tag (a shallow checkout has no tags).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { LAST_RELEASE_BEFORE_SQUASH } from '@buildd/core/db/migrate-plan';
import { assertDbConfigured } from './harness';

const ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CORE = join(ROOT, 'packages', 'core');
const NEW_TREE = join(CORE, 'drizzle');

type JournalEntry = { idx: number; when: number; tag: string; baseline?: boolean };
type Journal = { version: string; dialect: string; entries: JournalEntry[] };

const readJournal = (dir: string): Journal => JSON.parse(readFileSync(join(dir, 'meta', '_journal.json'), 'utf8'));

assertDbConfigured();
const BASE_URL = new URL(process.env.DATABASE_URL!);
const RUN = `mb_${Date.now().toString(36)}`;
const dbUrl = (name: string) => {
  const u = new URL(BASE_URL.toString());
  u.pathname = `/${name}`;
  return u.toString();
};

let work = '';
let oldTree = '';
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

/** A copy of `src` holding only the journal entries `keep` selects (and their .sql). */
function treeFrom(src: string, label: string, keep: (e: JournalEntry) => boolean, extra: { dir: string; entries: JournalEntry[] }[] = []): string {
  const dir = join(work, label);
  mkdirSync(join(dir, 'meta'), { recursive: true });
  const journal = readJournal(src);
  const entries = journal.entries.filter(keep);
  for (const e of entries) copyFileSync(join(src, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  for (const x of extra) {
    for (const e of x.entries) copyFileSync(join(x.dir, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
    entries.push(...x.entries);
  }
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }, null, 2));
  return dir;
}

function migrate(url: string, tree: string): { status: number; out: string } {
  const r = spawnSync('bun', ['db/migrate.ts'], {
    cwd: CORE,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: url, BUILDD_MIGRATIONS_DIR: tree },
    timeout: 15 * 60_000,
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

function migrateOk(url: string, tree: string): string {
  const r = migrate(url, tree);
  if (r.status !== 0) throw new Error(`migrate failed (${r.status}):\n${r.out.slice(-3000)}`);
  return r.out;
}

/**
 * Everything a migration can create in `public`, rendered by Postgres itself.
 * Column order is by position among live columns, so a column dropped and the
 * gap it leaves do not count as a difference — the baseline cannot reproduce
 * attnum gaps and nothing observable depends on them.
 */
const FINGERPRINT = `
  SELECT 'ext' AS k, extname AS v FROM pg_extension WHERE extname <> 'plpgsql'
  UNION ALL
  SELECT 'type', t.typname || ':' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
    FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace
   WHERE n.nspname = 'public' GROUP BY t.typname
  UNION ALL
  SELECT 'rel', c.relname || ':' || c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','S','p','f')
  UNION ALL
  SELECT 'col', c.relname || '#' || row_number() OVER (PARTITION BY c.oid ORDER BY a.attnum) || ':' || a.attname || ' '
       || format_type(a.atttypid, a.atttypmod) || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
       || coalesce(' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid), '') || ' gen=' || a.attgenerated::text || ' id=' || a.attidentity::text
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','p') AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'con', conrelid::regclass::text || ':' || conname || ' ' || pg_get_constraintdef(oid)
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace
  UNION ALL
  SELECT 'idx', indexdef FROM pg_indexes WHERE schemaname = 'public'
  UNION ALL
  SELECT 'fn', pg_get_functiondef(p.oid) FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
     AND NOT EXISTS (SELECT 1 FROM pg_depend dep WHERE dep.objid = p.oid AND dep.deptype = 'e')
  UNION ALL
  SELECT 'trg', pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
  ORDER BY 1, 2`;

async function withDb<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const fingerprint = (url: string) =>
  withDb(url, async (c) => (await c.query<{ k: string; v: string }>(FINGERPRINT)).rows.map((r) => `${r.k} ${r.v}`));

const trackingRows = (url: string) =>
  withDb(url, async (c) =>
    (await c.query<{ created_at: string }>('SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows.map(
      (r) => Number(r.created_at)
    )
  );

/** Rows in any public table: a fresh DB must have none, whichever tree built it. */
const publicRowCount = (url: string) =>
  withDb(url, async (c) => {
    const tables = (await c.query<{ t: string }>(`SELECT quote_ident(tablename) AS t FROM pg_tables WHERE schemaname = 'public'`)).rows;
    let n = 0;
    for (const { t } of tables) n += Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM public.${t}`)).rows[0]!.n);
    return n;
  });

const newJournal = readJournal(NEW_TREE);
const baseline = newJournal.entries[0]!;
const postCut = newJournal.entries.slice(1);

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'migration-baseline-'));
  const extract = join(work, 'archive');
  mkdirSync(extract);
  const archive = spawnSync(
    'sh',
    [
      '-c',
      `git -C "$ROOT" archive --format=tar "$TAG" -- 'packages/core/drizzle/*.sql' packages/core/drizzle/meta/_journal.json | tar -x -C "$OUT"`,
    ],
    { env: { ...process.env, ROOT, TAG: LAST_RELEASE_BEFORE_SQUASH, OUT: extract }, encoding: 'utf8' }
  );
  if (archive.status !== 0) {
    throw new Error(
      `cannot read the pre-squash tree at ${LAST_RELEASE_BEFORE_SQUASH} (fetch it: ` +
        `git fetch --no-tags --depth=1 origin +refs/tags/${LAST_RELEASE_BEFORE_SQUASH}:refs/tags/${LAST_RELEASE_BEFORE_SQUASH}):\n${archive.stderr}`
    );
  }
  const atTag = join(extract, 'packages', 'core', 'drizzle');
  // Pre-squash tree = the tag's history (ending at the cut point) + this tree's
  // post-cut migrations, which the squash did not touch.
  oldTree = treeFrom(atTag, 'old', () => true, [{ dir: NEW_TREE, entries: postCut }]);
}, 120_000);

afterAll(async () => {
  for (const name of created) {
    await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)).catch(() => {});
  }
  if (work) rmSync(work, { recursive: true, force: true });
}, 120_000);

describe('squashed baseline', () => {
  it('the old tree ends exactly at the baseline cut point', () => {
    const old = readJournal(oldTree).entries;
    const cut = old[old.length - postCut.length - 1]!;
    expect(baseline.baseline).toBe(true);
    expect(cut.when).toBe(baseline.when);
    expect(Math.max(...old.slice(0, old.length - postCut.length).map((e) => e.when))).toBe(baseline.when);
  });

  let freshNew = '';

  it('(a) a fresh DB migrated through the new tree matches one migrated through the old tree', async () => {
    const [oldUrl, newUrl] = await Promise.all([freshDb('old'), freshDb('new')]);
    migrateOk(oldUrl, oldTree);
    const out = migrateOk(newUrl, NEW_TREE);
    expect(out).toContain(`(${newJournal.entries.length} applied, 0 backfilled)`);
    freshNew = newUrl;

    const [a, b] = await Promise.all([fingerprint(oldUrl), fingerprint(newUrl)]);
    expect(a.length).toBeGreaterThan(1000);
    expect(b).toEqual(a);
    expect(await publicRowCount(oldUrl)).toBe(0);
    expect(await publicRowCount(newUrl)).toBe(0);
  }, 20 * 60_000);

  it('(b) a DB at the cut point runs only the post-cut migrations, and a rerun is a no-op', async () => {
    const url = await freshDb('cut');
    const cutTree = treeFrom(oldTree, 'cut', (e) => e.when <= baseline.when);
    migrateOk(url, cutTree);
    const before = await trackingRows(url);

    const out = migrateOk(url, NEW_TREE);
    expect(out).toContain(`(${postCut.length} applied, 0 backfilled)`);
    expect(await trackingRows(url)).toEqual([...before, ...postCut.map((e) => e.when)].sort((x, y) => x - y));
    expect(await fingerprint(url)).toEqual(await fingerprint(freshNew));

    const again = migrateOk(url, NEW_TREE);
    expect(again).toContain('(0 applied, 0 backfilled)');
  }, 20 * 60_000);

  it('(c) a DB partway through the squashed history is refused, untouched, naming the release', async () => {
    const url = await freshDb('partial');
    const old = readJournal(oldTree).entries;
    const stopAt = old[Math.floor(old.length / 3)]!.idx;
    migrateOk(url, treeFrom(oldTree, 'partial', (e) => e.idx <= stopAt));
    const [rows, shape] = [await trackingRows(url), await fingerprint(url)];

    const r = migrate(url, NEW_TREE);
    expect(r.status).toBe(1);
    expect(r.out).toContain('stopped partway through the migration history');
    expect(r.out).toContain(LAST_RELEASE_BEFORE_SQUASH);
    expect(await trackingRows(url)).toEqual(rows);
    expect(await fingerprint(url)).toEqual(shape);
  }, 20 * 60_000);
});
