/**
 * buildd's activity render, the `Notify.activity` port of `render_activity`
 * (docs/specs/workflow-state-kernel.md §12.1; the handler is the package's,
 * packages/workflow-kernel/src/handlers/activity.ts): regenerate the PR
 * activity comment of a kernel-owned delivery from the delivery row, its full
 * `workflow_transitions` log and the legacy notes diverted into
 * `workflow_facts` (kind `activity_note`). Never appends, never reads the
 * comment as data: the only thing read back from GitHub is the render-version
 * marker, so a stale render can delay the right text but never leave a wrong
 * one (rule 3; the follow-up render owed when the version moved on is the
 * handler's).
 *
 * Also the diversion half: `divertActivityNote` is what `appendPrActivity`
 * calls for a kernel-owned PR, so the kernel's render stays the comment's
 * only writer.
 */
import { createHash } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { ACTIVITY_COMMENT_MARKER, type PrActivityEntry } from '@/lib/pr-activity-comment';
import { activityHandlers } from '@buildd/workflow-kernel/handlers/index';
import type { Notify } from '@buildd/workflow-kernel/ports';
import type { ClaimedEffect } from './effects';
import { loadView, type Exec } from './kernel';
import { postgresStore } from './postgres-store';
import { workspaceKernelOnSql } from './authority';
import { workspaceRepo, type WorkspaceRepo } from './github-facts';
import { parseRenderVersion, renderDeliveryActivity, type ActivityTransition, type DivertedNote } from './pr-activity-render';

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

type GithubApi = (installationId: number, path: string, options?: RequestInit) => Promise<unknown>;

export interface RenderDeps {
  exec?: Exec;
  github?: GithubApi;
  repoFor?: (workspaceId: string) => Promise<WorkspaceRepo | null>;
  timezone?: (workspaceId: string) => Promise<string>;
}

type J = Record<string, unknown>;
const iso = (v: unknown): string => (v == null ? new Date(0).toISOString() : new Date(String(v)).toISOString());

export function transitionsSql(deliveryId: string): SQL {
  return sql`-- workflow:activity_transitions
SELECT command, from_state, to_state, to_version, evidence, created_at
FROM workflow_transitions WHERE delivery_id = ${deliveryId}::uuid ORDER BY to_version`;
}

export function activityNotesSql(deliveryId: string): SQL {
  return sql`-- workflow:activity_notes
SELECT payload, observed_at FROM workflow_facts
WHERE delivery_id = ${deliveryId}::uuid AND kind = 'activity_note' ORDER BY observed_at, id`;
}

async function defaultGithub(): Promise<GithubApi> {
  const { githubApi } = await import('@/lib/github');
  return githubApi as GithubApi;
}

async function defaultTimezone(workspaceId: string): Promise<string> {
  try {
    const { getWorkspaceTimezone } = await import('@/lib/team-timezone');
    return await getWorkspaceTimezone(workspaceId);
  } catch {
    return 'UTC';
  }
}

/** Every buildd activity comment on the PR, oldest first (up to 3 pages). */
async function findActivityComments(api: GithubApi, installationId: number, repo: string, pr: number): Promise<Array<{ id: number; body: string }>> {
  const out: Array<{ id: number; body: string }> = [];
  for (let page = 1; page <= 3; page++) {
    const raw = (await api(installationId, `/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`)) as Array<{ id: number; body?: string | null }> | null;
    if (!Array.isArray(raw) || raw.length === 0) break;
    for (const c of raw) if (typeof c.body === 'string' && c.body.includes(ACTIVITY_COMMENT_MARKER)) out.push({ id: c.id, body: c.body });
    if (raw.length < 100) break;
  }
  return out.sort((a, b) => a.id - b.id);
}

/** The render, as the `Notify.activity` port: the comment at the delivery's version, and what it did. */
export function activityNotify(deps: RenderDeps = {}): Pick<Notify, 'activity'> {
  return {
    async activity(p) {
      const exec = deps.exec ?? dbExec;
      const view = p.view ?? (await loadView({ deliveryId: p.deliveryId }, exec));
      const d = view.delivery;
      if (!d) return { outcome: 'skipped:no_delivery' };
      if (!d.repoFullName || d.prNumber == null) return { outcome: 'skipped:no_pr' };
      const repo = await (deps.repoFor ?? workspaceRepo)(d.workspaceId);
      if (!repo) throw new Error('no GitHub installation for the workspace');
      const api = deps.github ?? (await defaultGithub());

      const tRows = ((await exec(transitionsSql(d.id))).rows ?? []) as J[];
      const transitions: ActivityTransition[] = tRows.map((r) => ({
        command: String(r.command), fromState: r.from_state == null ? null : String(r.from_state), toState: String(r.to_state),
        toVersion: Number(r.to_version), evidence: (r.evidence as Record<string, unknown> | null) ?? null, createdAt: iso(r.created_at),
      }));
      const nRows = ((await exec(activityNotesSql(d.id))).rows ?? []) as J[];
      const notes: DivertedNote[] = nRows
        .filter((r) => r.payload && typeof (r.payload as J).kind === 'string')
        .map((r) => ({ entry: r.payload as PrActivityEntry, observedAt: iso(r.observed_at) }));
      const timezone = await (deps.timezone ?? defaultTimezone)(d.workspaceId);
      const body = renderDeliveryActivity({ view, transitions, notes, timezone });

      const comments = await findActivityComments(api, repo.installationId, d.repoFullName, d.prNumber);
      const [keep, ...extra] = comments;
      // Rule 5: exactly one comment. Keep the oldest, remove the rest.
      for (const c of extra) {
        await api(repo.installationId, `/repos/${d.repoFullName}/issues/comments/${c.id}`, { method: 'DELETE' }).catch(() => undefined);
      }
      if (keep) {
        const onGithub = parseRenderVersion(keep.body);
        if (onGithub != null && onGithub > d.version) return { outcome: 'skipped:older_version' };
        if (keep.body === body) return { outcome: 'ok:unchanged' };
        await api(repo.installationId, `/repos/${d.repoFullName}/issues/comments/${keep.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }),
        });
        return { outcome: 'ok:updated' };
      }
      // Rule 6: always created, whoever opened the PR.
      await api(repo.installationId, `/repos/${d.repoFullName}/issues/${d.prNumber}/comments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }),
      });
      return { outcome: 'ok:created' };
    },
  };
}

/** One `render_activity` effect: the package's handler over the Postgres store and this render. */
export async function renderActivityEffect(e: ClaimedEffect, deps: RenderDeps = {}): Promise<{ outcome: string }> {
  const store = postgresStore(deps.exec ?? dbExec);
  const notify: Notify = { ...activityNotify(deps), team: async () => {} };
  const r = await activityHandlers({ store, notify, clock: { now: () => new Date().toISOString() } }).render_activity!(e);
  return { outcome: r?.outcome ?? 'ok' };
}

// ── Diversion of legacy writers ─────────────────────────────────────────────

/** Stable over redeliveries: the entry without its timestamp. */
export function activityNoteKey(deliveryId: string, entry: PrActivityEntry): string {
  const { at: _at, ...rest } = entry;
  const stable = JSON.stringify(Object.keys(rest).sort().map((k) => [k, (rest as J)[k]]));
  const h = createHash('sha256').update(stable).digest('hex').slice(0, 16);
  return `activity:${deliveryId}:${entry.kind}:${h}`;
}

export function kernelDeliveryForActivitySql(p: { workspaceId?: string | null; repoFullName: string; prNumber: number }): SQL {
  const ws = p.workspaceId ? sql`AND workspace_id = ${p.workspaceId}::uuid` : sql``;
  return sql`-- workflow:activity_delivery
SELECT id, workspace_id FROM workflow_deliveries
WHERE repo_full_name = ${p.repoFullName}::text AND pr_number = ${p.prNumber}::int AND authority = 'kernel' ${ws}
  AND ${workspaceKernelOnSql(sql`workflow_deliveries.workspace_id`)}
ORDER BY created_at DESC LIMIT 1`;
}

/** One statement: record the note as a fact and owe a render (only for a new note). */
export function divertNoteSql(p: { deliveryId: string; workspaceId: string; repoFullName: string; prNumber: number; entry: PrActivityEntry }): SQL {
  const key = activityNoteKey(p.deliveryId, p.entry);
  return sql`-- workflow:divert_activity_note
WITH f AS (
  INSERT INTO workflow_facts (delivery_id, workspace_id, repo_full_name, pr_number, kind, fact_key, source, payload)
  VALUES (${p.deliveryId}::uuid, ${p.workspaceId}::uuid, ${p.repoFullName}::text, ${p.prNumber}::int, 'activity_note', ${key}::text,
    'legacy:appendPrActivity', ${JSON.stringify(p.entry)}::jsonb)
  ON CONFLICT (workspace_id, fact_key) DO NOTHING
  RETURNING id
), e AS (
  INSERT INTO workflow_effects (delivery_id, transition_id, kind, dedupe_key, payload)
  SELECT ${p.deliveryId}::uuid, tr.id, 'render_activity', ${`render:${p.deliveryId}:note:${key}`}::text, jsonb_build_object('note', ${key}::text)
  FROM f, LATERAL (SELECT id FROM workflow_transitions WHERE delivery_id = ${p.deliveryId}::uuid ORDER BY to_version DESC LIMIT 1) tr
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id
)
SELECT (SELECT count(*) FROM f)::int AS facts, (SELECT count(*) FROM e)::int AS effects`;
}

/**
 * For a kernel-owned PR, record a legacy activity entry as a fact and owe a
 * render instead of editing the comment. Returns null when the PR is not
 * kernel-owned (the legacy writer proceeds), or the delivery id it diverted to.
 */
export async function divertActivityNote(
  p: { workspaceId?: string | null; repoFullName: string; prNumber: number; entry: PrActivityEntry },
  exec: Exec = dbExec,
): Promise<string | null> {
  const found = ((await exec(kernelDeliveryForActivitySql(p))).rows ?? []) as J[];
  if (!found[0]) return null;
  const deliveryId = String(found[0].id);
  const workspaceId = String(found[0].workspace_id);
  await exec(divertNoteSql({ deliveryId, workspaceId, repoFullName: p.repoFullName, prNumber: p.prNumber, entry: p.entry }));
  return deliveryId;
}
