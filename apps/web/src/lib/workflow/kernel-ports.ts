/**
 * buildd's adapters for the kernel's ports (docs/specs/workflow-kernel-library.md
 * §2), and `builddKernelPorts`, which composes them into the `KernelPorts` the
 * package's effect handlers run on. Composed once, at the composition root
 * (`workflowKernelHooks()` in apps/web/src/modules.ts fills it;
 * `workflowKernel()` below composes it).
 *
 * The core halves live here: the Postgres store, GitHub per workspace (its
 * installation's live reads plus `GithubWrites` over `@/lib/github`), the
 * ingest funnel (`ingestFact`), the trunk incident ledger (`builddTrunk`) and
 * the scheduler (`builddWork`: a task insert, `announceTaskCreated`,
 * `wakeTask`). The module halves are handed in as hooks, so this core file
 * imports no module (scripts/module-boundaries.test.ts): how a merge answer
 * reads as T16 and the activity render (reviews), the supersession and
 * post-merge work (reviews, missions), team notifications, per role the shape
 * of the task `Work` files (reviewer, review fix, CI fix, conflict fix, trunk
 * fix), the review loop's and conflict families' host halves, legacy's first
 * review, the CI job-log capture, each family's hand-off to a person, and the
 * decision layer (`Decide`).
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks, workspaces } from '@buildd/core/db/schema';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { TERMINAL_WORKER_STATUSES } from '@buildd/shared';
import type { EffectHandlers } from '@buildd/workflow-kernel/effects';
import { kernelEffectHandlers } from '@buildd/workflow-kernel/handlers/index';
import type {
  Conflicts, Decide, Escalate, Evidence, GithubFacts, GithubWrites, HandOff, Ingest, KernelPorts, Lifecycle, MergeAnswer, Notify, Policy, Rails, Reviews, Trunk,
  Work, WorkFiled, WorkRequest,
} from '@buildd/workflow-kernel/ports';
import { announceTaskCreated, wakeTask } from '@/lib/dispatch-authority';
import { queueSystemInstruction } from '@/lib/system-instruction-queue';
import { githubApi, mergePullRequest, postPrReview, type MergePullRequestResult } from '@/lib/github';
import { ingestFact, type FactInput } from './facts';
import { githubReader, workspaceRepo } from './github-facts';
import type { Exec } from './kernel';
import { postgresStore } from './postgres-store';
import { builddTrunk } from './trunk';
import { builddPolicy } from './kernel-policy';
import { builddLandingRails, type LandingRailsDeps } from './landing-rails';

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

type GithubApi = (installationId: number, path: string, options?: RequestInit) => Promise<unknown>;

/** How GitHub's answer to a pinned merge call reads as the T16 outcome. */
export type MergeAnswerOf = (res: MergePullRequestResult) => MergeAnswer;

export interface GithubWritesDeps {
  api?: GithubApi;
  merge?: typeof mergePullRequest;
  review?: typeof postPrReview;
}

const json = (body: unknown): RequestInit => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** `GithubWrites` over `@/lib/github`, for one installation. */
export function builddGithubWrites(installationId: number, mergeAnswerOf: MergeAnswerOf, deps: GithubWritesDeps = {}): GithubWrites {
  const api = deps.api ?? (githubApi as GithubApi);
  const merge = deps.merge ?? mergePullRequest;
  const review = deps.review ?? postPrReview;
  return {
    async mergeAtHead(p) {
      return mergeAnswerOf(await merge(installationId, p.repoFullName, p.prNumber, p.method ?? 'squash', p.headSha));
    },
    async postReview(p) {
      if (p.event === 'COMMENT') {
        const r = (await api(installationId, `/repos/${p.repoFullName}/pulls/${p.prNumber}/reviews`, {
          method: 'POST', ...json({ commit_id: p.commitId, event: 'COMMENT', body: p.body }),
        })) as { id?: number } | null;
        return { id: r?.id != null ? String(r.id) : null, posted: true };
      }
      const r = await review({ installationId, repoFullName: p.repoFullName, prNumber: p.prNumber, headSha: p.commitId, event: p.event, body: p.body });
      return {
        id: r.reviewId != null ? String(r.reviewId) : null, posted: r.posted,
        ...(r.reason ? { reason: r.reason } : {}), ...(r.commentedOwnPr ? { commentedOwnPr: true } : {}),
      };
    },
    async publishStatus(p) {
      await api(installationId, `/repos/${p.repoFullName}/statuses/${p.sha}`, {
        method: 'POST', ...json({ state: p.state, context: p.context, description: p.description.slice(0, 140), ...(p.targetUrl ? { target_url: p.targetUrl } : {}) }),
      });
    },
    async upsertComment(p) {
      // The oldest comment carrying the marker (up to 3 pages), else a new one.
      let found: { id: number } | null = null;
      for (let page = 1; page <= 3 && !found; page++) {
        const raw = (await api(installationId, `/repos/${p.repoFullName}/issues/${p.prNumber}/comments?per_page=100&page=${page}`)) as Array<{ id: number; body?: string | null }> | null;
        if (!Array.isArray(raw) || raw.length === 0) break;
        found = raw.filter((c) => typeof c.body === 'string' && c.body.includes(p.marker)).sort((a, b) => a.id - b.id)[0] ?? null;
        if (raw.length < 100) break;
      }
      if (found) {
        await api(installationId, `/repos/${p.repoFullName}/issues/comments/${found.id}`, { method: 'PATCH', ...json({ body: p.body }) });
        return { id: String(found.id) };
      }
      const created = (await api(installationId, `/repos/${p.repoFullName}/issues/${p.prNumber}/comments`, { method: 'POST', ...json({ body: p.body }) })) as { id?: number } | null;
      return { id: created?.id != null ? String(created.id) : null };
    },
    async deleteBranch(p) {
      await api(installationId, `/repos/${p.repoFullName}/git/refs/heads/${encodeURIComponent(p.ref)}`, { method: 'DELETE' });
    },
  };
}

export interface GithubForDeps {
  repoFor?: typeof workspaceRepo;
  reader?: typeof githubReader;
  writes?: (installationId: number) => GithubWrites;
}

/** GitHub per workspace: its installation's live reads and writes; null when the workspace has no installation. */
export function builddGithubFor(mergeAnswerOf: MergeAnswerOf, deps: GithubForDeps = {}): (workspaceId: string) => Promise<GithubFacts | null> {
  return async (workspaceId) => {
    const repo = await (deps.repoFor ?? workspaceRepo)(workspaceId);
    if (!repo) return null;
    const reader = (deps.reader ?? githubReader)(repo.installationId);
    return { ...reader, writes: (deps.writes ?? ((id: number) => builddGithubWrites(id, mergeAnswerOf)))(repo.installationId) };
  };
}

/** The ingest funnel (`ingestFact`), acting on the read the effect took. */
export function builddIngest(exec: Exec = dbExec): Ingest {
  return {
    async ingest(fact, github) {
      const r = await ingestFact(fact as FactInput, { exec, github });
      return { result: r.result };
    },
  };
}

// ── Work: the task insert, announced and woken ─────────────────────────────

/** A task row a role's builder made from a `WorkRequest`: what `builddWork` inserts under the kernel's id. */
export interface WorkBuilt {
  /** The `tasks` insert, without `id` (the request's `taskId`). */
  values: Record<string, unknown>;
  /** The workspace row, when the builder read it (else it is read for the announcement). */
  workspace?: unknown;
  /**
   * When nothing was inserted and no task exists under the id: another unique
   * index refused the row, and this is the error (the effect retries). Absent =
   * the refusal is a redelivery's answer, not a failure.
   */
  refused?: string;
  /** Which shape was filed, for the effect's outcome. */
  variant?: string;
  /** Evidence still owed for the new task (`WorkFiled.evidence`). */
  evidence?: Record<string, unknown>;
  /** The module's own record of the new task (an activity line), after it is announced. */
  afterFile?: (row: { id: string; title: string }) => Promise<void>;
}

/**
 * A role's half of `Work`: the task the kernel asked for, as buildd files it;
 * or why it cannot be filed now; or, for a role whose own creation path keeps
 * its own dedupe (the reviewer), what that path filed.
 */
export type WorkBuilder = (req: WorkRequest) => Promise<WorkBuilt | { skipped: string } | { filed: WorkFiled }>;
export type WorkBuilders = Record<string, WorkBuilder>;

/** Pending tasks of a delivery's role, cancelled as skipped (all but `keepTaskId`). */
async function cancelPendingTasks(p: { deliveryId: string; role: string; reason: string; summary: string; keepTaskId?: string | null }): Promise<number> {
  const rows = await db.update(tasks)
    .set({
      status: 'cancelled',
      result: sql`COALESCE(${tasks.result}, '{}'::jsonb) || jsonb_build_object('skipped', true, 'skipReason', ${p.reason}::text, 'summary', ${p.summary}::text)`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(tasks.deliveryId, p.deliveryId),
      eq(tasks.deliveryRole, p.role as never),
      eq(tasks.status, 'pending'),
      ...(p.keepTaskId ? [ne(tasks.id, p.keepTaskId)] : []),
    ))
    .returning({ id: tasks.id });
  return rows.length;
}

/** The note on a filed task's description (read at claim, if nobody has it yet) and on any live worker's instruction queue. */
async function steerTask(exec: Exec, taskId: string, p: { marker: string; note: string }): Promise<void> {
  await exec(sql`-- workflow:steer_task
UPDATE tasks SET description = COALESCE(description, '') || E'\n\n' || ${p.note}::text, updated_at = now()
WHERE id = ${taskId}::uuid AND strpos(COALESCE(description, ''), ${p.marker}::text) = 0`);
  const terminal = sql.join(TERMINAL_WORKER_STATUSES.map((st) => sql`${st}::text`), sql`, `);
  const live = ((await exec(sql`-- workflow:steer_task_workers
SELECT id FROM workers WHERE task_id = ${taskId}::uuid AND status NOT IN (${terminal})`)).rows ?? []) as Array<{ id: string }>;
  for (const w of live) await queueSystemInstruction(String(w.id), p.note, { marker: p.marker });
}

/** buildd's scheduler as the kernel's `Work` port: each role's builder words the row, this files it once under the kernel's id. */
export function builddWork(builders: WorkBuilders, exec: Exec = dbExec): Work {
  return {
    async file(req) {
      const build = builders[req.role];
      if (!build) throw new Error(`no task builder for role ${req.role}`);
      const b = await build(req);
      if ('skipped' in b) return { taskId: null, created: false, skipped: b.skipped };
      if ('filed' in b) return b.filed;
      const taskId = req.taskId;
      if (!taskId) throw new Error(`a ${req.role} task is filed under the kernel's id`);
      const [row] = await db.insert(tasks).values({ id: taskId, ...b.values } as never).onConflictDoNothing().returning();
      if (!row) {
        const existing = await db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, taskId)) });
        if (!existing && b.refused) throw new Error(b.refused);
        // Filed before (a run that crashed before the kernel bound it, maybe before it announced it):
        // still owed what the filing owes. The announcement only refreshes the dashboard, so a task
        // nobody has picked up yet is announced again rather than risk never being announced.
        if (existing?.status === 'pending') {
          await announceTaskCreated(existing as never, (b.workspace ?? await db.query.workspaces.findFirst({ where: sqlWhere(eq(workspaces.id, req.workspaceId)) })) as never);
        }
        return { taskId, created: false, ...(b.variant ? { variant: b.variant } : {}), ...(b.evidence ? { evidence: b.evidence } : {}) };
      }
      const workspace = b.workspace ?? await db.query.workspaces.findFirst({ where: sqlWhere(eq(workspaces.id, req.workspaceId)) });
      await announceTaskCreated(row as never, workspace as never);
      await b.afterFile?.(row as { id: string; title: string });
      return { taskId, created: true, ...(b.variant ? { variant: b.variant } : {}), ...(b.evidence ? { evidence: b.evidence } : {}) };
    },
    async wake(taskId, reason) {
      await wakeTask(taskId, reason as Parameters<typeof wakeTask>[1]);
    },
    async cancel(taskId, reason) {
      await db.update(tasks)
        .set({ status: 'cancelled', result: sql`COALESCE(${tasks.result}, '{}'::jsonb) || jsonb_build_object('skipped', true, 'skipReason', ${reason}::text)`, updatedAt: new Date() })
        .where(and(eq(tasks.id, taskId), eq(tasks.status, 'pending')));
    },
    cancelPending: cancelPendingTasks,
    steer: (taskId, p) => steerTask(exec, taskId, p),
  };
}

/** The module halves the composition root hands in. */
export interface BuilddKernelHooks {
  mergeAnswerOf: MergeAnswerOf;
  notify: Notify;
  lifecycle: Lifecycle;
  /** Per role, the task `Work` files (`review`, `fix`, `ci_fix`, `conflict_fix`, `trunk_fix`). */
  work: WorkBuilders;
  escalate: Escalate;
  evidence: Evidence;
  reviews: Reviews;
  conflicts: Conflicts;
  handOff: HandOff;
  /** buildd's decision layer at the kernel's decision points. */
  decide: Decide;
  /** The mission-PR hold (the missions module's), one of the merge rails the `merge_call` effect reads at merge time. */
  missionGate: LandingRailsDeps['missionGate'];
}

/** The ports the package's effect handlers run on in buildd. */
export function builddKernelPorts(hooks: BuilddKernelHooks, opts: {
  exec?: Exec; githubFor?: (workspaceId: string) => Promise<GithubFacts | null>; trunk?: Trunk; policy?: Policy; rails?: Rails;
} = {}): KernelPorts {
  const exec = opts.exec ?? dbExec;
  return {
    store: postgresStore(exec),
    githubFor: opts.githubFor ?? builddGithubFor(hooks.mergeAnswerOf),
    clock: { now: () => new Date().toISOString() },
    policy: opts.policy ?? builddPolicy(exec),
    ingest: builddIngest(exec),
    notify: hooks.notify,
    lifecycle: hooks.lifecycle,
    work: builddWork(hooks.work, exec),
    trunk: opts.trunk ?? builddTrunk(exec),
    escalate: hooks.escalate,
    evidence: hooks.evidence,
    reviews: hooks.reviews,
    conflicts: hooks.conflicts,
    handOff: hooks.handOff,
    decide: hooks.decide,
    rails: opts.rails ?? builddLandingRails({ missionGate: hooks.missionGate }),
  };
}

// ── The composition, once ───────────────────────────────────────────────────

export interface WorkflowKernel {
  ports: KernelPorts;
  /** Every effect kind's handler: the package's, over `ports`. */
  handlers: EffectHandlers;
}

let composed: WorkflowKernel | null = null;

/**
 * The kernel as buildd runs it, composed on first use from the composition
 * root's `workflowKernelHooks` slot (apps/web/src/modules.ts). Lazy, so
 * loading a kernel module does not load every module.
 */
export async function workflowKernel(): Promise<WorkflowKernel> {
  if (composed) return composed;
  const m = await import('@/modules');
  const ports = builddKernelPorts(m.workflowKernelHooks());
  return (composed = { ports, handlers: kernelEffectHandlers(ports) });
}
