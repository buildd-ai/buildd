/**
 * Harness for tests that run real SQL: the dispatch architecture suite
 * (docs/specs/task-dispatch-authority.md). These exist because a mocked `db`
 * makes every WHERE clause, trigger and CTE unobservable, and the dispatch
 * invariants live exactly there.
 *
 * Needs a migrated, loopback Postgres behind the local neon-http proxy —
 * `bun run test:db` (scripts/run-db-tests.ts) checks that before any file
 * runs, and CI's `db-architecture` job provides one. It never skips: a suite
 * that silently passes with no database is the failure this exists to stop.
 */
import { db } from '@buildd/core/db';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LEGACY_MIGRATIONS_PATH, loadLegacyMap } from '@buildd/core/db/legacy-migrations';
import { readMigrationTree } from '@buildd/core/db/migrate-tree';

export function assertDbConfigured(): void {
  const url = process.env.DATABASE_URL;
  const endpoint = process.env.NEON_LOCAL_FETCH_ENDPOINT;
  if (!url || !endpoint) {
    throw new Error('DB tests need DATABASE_URL and NEON_LOCAL_FETCH_ENDPOINT (loopback). Run via `bun run test:db`.');
  }
  const host = new URL(url).hostname;
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    throw new Error(`DB tests refuse non-loopback DATABASE_URL host ${host}`);
  }
}

type Row = Record<string, unknown>;
export async function q<T extends Row = Row>(query: ReturnType<typeof sql>): Promise<T[]> {
  const r = await db.execute(query);
  return ((r as { rows?: T[] }).rows ?? []) as T[];
}

let seq = 0;
const uniq = () => `${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export async function seedWorkspace(opts: {
  webhookConfig?: Record<string, unknown> | null;
  dispatchTransport?: 'in_app' | 'shadow' | 'dispatch';
} = {}): Promise<{ teamId: string; workspaceId: string }> {
  const slug = `t-${uniq()}`;
  const [team] = await q<{ id: string }>(sql`INSERT INTO teams (name, slug) VALUES (${slug}, ${slug}) RETURNING id`);
  const [ws] = await q<{ id: string }>(sql`
    INSERT INTO workspaces (name, team_id, webhook_config, dispatch_transport)
    VALUES (${`w-${uniq()}`}, ${team.id}::uuid, ${opts.webhookConfig ? JSON.stringify(opts.webhookConfig) : null}::jsonb,
      ${opts.dispatchTransport ?? 'in_app'})
    RETURNING id`);
  return { teamId: team.id, workspaceId: ws.id };
}

export async function seedTask(workspaceId: string, opts: {
  status?: string;
  startAt?: Date | null;
  title?: string;
  pathManifest?: string[] | null;
  dependsOn?: string[];
  missionId?: string | null;
} = {}): Promise<string> {
  const [t] = await q<{ id: string }>(sql`
    INSERT INTO tasks (workspace_id, title, status, start_at, path_manifest, depends_on, mission_id)
    VALUES (
      ${workspaceId}::uuid, ${opts.title ?? `task-${uniq()}`}, ${opts.status ?? 'pending'},
      ${opts.startAt?.toISOString() ?? null}::timestamptz,
      ${opts.pathManifest ? JSON.stringify(opts.pathManifest) : null}::jsonb,
      ${JSON.stringify(opts.dependsOn ?? [])}::jsonb,
      ${opts.missionId ?? null}::uuid
    ) RETURNING id`);
  return t.id;
}

export async function seedMission(teamId: string, workspaceId: string): Promise<string> {
  const [m] = await q<{ id: string }>(sql`
    INSERT INTO missions (team_id, workspace_id, title) VALUES (${teamId}::uuid, ${workspaceId}::uuid, ${`m-${uniq()}`})
    RETURNING id`);
  return m.id;
}

export async function outboxFor(taskId: string) {
  return q<{ id: string; cause: string; causes: string[]; status: string; dedupe_key: string; not_before: string; attempt_count: number; delivered_via: string | null }>(
    sql`SELECT id, cause, causes, status, dedupe_key, not_before, attempt_count, delivered_via
        FROM task_dispatch_outbox WHERE task_id = ${taskId}::uuid ORDER BY created_at, id`,
  );
}

/** Mark every outbox row delivered, so a test starts from "nothing pending". */
export async function settleOutbox(): Promise<void> {
  await db.execute(sql`UPDATE task_dispatch_outbox SET status = 'delivered', delivered_via = 'test:settled' WHERE status IN ('pending', 'delivering')`);
}

// ─── Migration-tree tests (migration-baseline, migration-layout-v1) ──────────
//
// These run the migrator against their own databases (pg, not the app's `db`)
// and compare what it built.

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

export async function withDb<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** The schema fingerprint of the database at `url` (sorted lines). */
export const fingerprint = (url: string) =>
  withDb(url, async (c) => (await c.query<{ k: string; v: string }>(FINGERPRINT)).rows.map((r) => `${r.k} ${r.v}`));


const DRIZZLE_DIR = join(import.meta.dir, '../../../../packages/core/drizzle');

/**
 * The SQL of a migration that predates the drizzle v1 cutover, by its old
 * journal tag (`0282_legacy_repair_overlap_edges`). The tree now holds
 * `<YYYYMMDDHHMMSS>_<slug>/migration.sql`; the committed legacy map says which
 * folder each tag became.
 */
export function legacyMigrationSql(tag: string): string {
  const entry = loadLegacyMap(LEGACY_MIGRATIONS_PATH).find((e) => e.tag === tag);
  if (!entry) throw new Error(`no legacy migration ${tag} in the legacy map`);
  return readFileSync(join(DRIZZLE_DIR, entry.name, 'migration.sql'), 'utf8');
}

/** Every migration's SQL, oldest first (legacy history, then post-cutover folders). */
export function allMigrationSql(): Array<{ name: string; sql: string }> {
  return readMigrationTree(DRIZZLE_DIR).map((m) => ({ name: m.name, sql: m.sql.join('\n--> statement-breakpoint\n') }));
}

/**
 * The legacy (journal) form of this checkout's pre-cutover history, rebuilt from
 * the committed tree: each legacy-map entry's `<tag>.sql` is its folder's
 * `migration.sql` (`drizzle-kit up` is lossless), and the journal is the map's
 * tag, exact-ms `when` and baseline flag. Post-cutover folders have no legacy
 * form and are not included. This is what the previous release's migrator, and
 * this migrator's retained legacy path, read; the suites that prove the squash
 * and the rollback build their history databases from it.
 */
export function synthesizeLegacyTree(label = 'legacy'): string {
  const dir = mkdtempSync(join(tmpdir(), `${label}-`));
  mkdirSync(join(dir, 'meta'), { recursive: true });
  const entries = loadLegacyMap(LEGACY_MIGRATIONS_PATH).map((e) => {
    writeFileSync(join(dir, `${e.tag}.sql`), readFileSync(join(DRIZZLE_DIR, e.name, 'migration.sql'), 'utf8'));
    return { idx: Number(e.tag.slice(0, 4)), version: '7', when: e.when, tag: e.tag, breakpoints: true, ...(e.baseline ? { baseline: true } : {}) };
  });
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ version: '7', dialect: 'postgresql', entries }, null, 2));
  return dir;
}

/** The newest folder's v8 snapshot `ddl[]`: the real tree's own, for fixtures that need one. */
export function realTipSnapshotDdl(): unknown[] {
  const tip = readMigrationTree(DRIZZLE_DIR).at(-1)!.name;
  return (JSON.parse(readFileSync(join(DRIZZLE_DIR, tip, 'snapshot.json'), 'utf8')) as { ddl: unknown[] }).ddl;
}

/**
 * The previous release's migrator, out of git, with the drizzle it was written
 * against. It reads a legacy journal tree through drizzle-orm 0.45's
 * `readMigrationFiles`, which the installed rc refuses ("old drizzle-kit
 * migration folders"), so it gets its own node_modules with 0.45 in a scratch
 * directory. Returns the `packages/core` dir to run `bun db/migrate.ts` in.
 * Every "history" database is built with it, so its tracking table has exactly
 * the shape production's has today (`id, hash, created_at`).
 */
export function prepareRollbackMigrator(work: string, ref: string, repoRoot: string): string {
  const rb = join(work, 'rollback');
  mkdirSync(rb, { recursive: true });
  const archive = spawnSync(
    'sh',
    ['-c', `git -C "$ROOT" archive --format=tar "$REF" -- packages/core/db packages/core/config.ts | tar -x -C "$OUT"`],
    { env: { ...process.env, ROOT: repoRoot, REF: ref, OUT: rb }, encoding: 'utf8' }
  );
  if (archive.status !== 0) {
    throw new Error(
      `cannot read the migrator at ${ref} (fetch it: git fetch --no-tags --depth=1 origin ` +
        `+refs/tags/${ref}:refs/tags/${ref}):\n${archive.stderr}`
    );
  }
  writeFileSync(
    join(rb, 'package.json'),
    JSON.stringify({
      name: 'rollback-migrator',
      private: true,
      dependencies: { 'drizzle-orm': '0.45.4', '@neondatabase/serverless': '^1.0.0', dotenv: "^18.0.0", ws: '^8.19.0' },
    })
  );
  const install = spawnSync('bun', ['install'], { cwd: rb, encoding: 'utf8', timeout: 5 * 60_000 });
  if (install.status !== 0) throw new Error(`bun install for the rollback migrator failed:\n${install.stdout}${install.stderr}`);
  return join(rb, 'packages', 'core');
}
