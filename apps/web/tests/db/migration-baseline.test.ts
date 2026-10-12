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
import { assertDbConfigured, fingerprint, withDb } from './harness';

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
