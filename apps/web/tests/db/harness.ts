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
