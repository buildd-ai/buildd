/**
 * buildd's adapters for the kernel's ports (docs/specs/workflow-kernel-library.md
 * §2), and `builddKernelPorts`, which composes them into the `KernelPorts` the
 * package's effect handlers run on. Composed once, at the composition root
 * (`workflowKernelHooks()` and `workflowHostEffectHandlers()` in
 * apps/web/src/modules.ts fill it; `workflowKernel()` below composes it).
 *
 * The core halves live here: the Postgres store, GitHub per workspace (its
 * installation's live reads plus `GithubWrites` over `@/lib/github`), and the
 * ingest funnel (`ingestFact`). The module halves are handed in as hooks, so
 * this core file imports no module (scripts/module-boundaries.test.ts): how a
 * merge answer reads as T16 and the activity render (reviews), the
 * supersession and post-merge work (reviews, missions), team notifications.
 */
import { db } from '@buildd/core/db';
import type { EffectHandlers } from '@buildd/workflow-kernel/effects';
import { kernelEffectHandlers } from '@buildd/workflow-kernel/handlers/index';
import type {
  GithubFacts, GithubWrites, Ingest, KernelPorts, Lifecycle, MergeAnswer, Notify,
} from '@buildd/workflow-kernel/ports';
import { githubApi, mergePullRequest, postPrReview, type MergePullRequestResult } from '@/lib/github';
import { ingestFact, type FactInput } from './facts';
import { githubReader, workspaceRepo } from './github-facts';
import type { Exec } from './kernel';
import { postgresStore } from './postgres-store';

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
        return { id: r?.id != null ? String(r.id) : null };
      }
      const r = await review({ installationId, repoFullName: p.repoFullName, prNumber: p.prNumber, headSha: p.commitId, event: p.event, body: p.body });
      return { id: r.reviewId != null ? String(r.reviewId) : null };
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

/** The module halves the composition root hands in. */
export interface BuilddKernelHooks {
  mergeAnswerOf: MergeAnswerOf;
  notify: Notify;
  lifecycle: Lifecycle;
}

/** The ports the package's effect handlers run on in buildd. */
export function builddKernelPorts(hooks: BuilddKernelHooks, opts: { exec?: Exec; githubFor?: (workspaceId: string) => Promise<GithubFacts | null> } = {}): KernelPorts {
  const exec = opts.exec ?? dbExec;
  return {
    store: postgresStore(exec),
    githubFor: opts.githubFor ?? builddGithubFor(hooks.mergeAnswerOf),
    clock: { now: () => new Date().toISOString() },
    ingest: builddIngest(exec),
    notify: hooks.notify,
    lifecycle: hooks.lifecycle,
  };
}

// ── The composition, once ───────────────────────────────────────────────────

export interface WorkflowKernel {
  ports: KernelPorts;
  /** Every effect kind's handler: the package's over `ports`, then the families still in apps/web. */
  handlers: EffectHandlers;
}

let composed: WorkflowKernel | null = null;

/**
 * The kernel as buildd runs it, composed on first use from the composition
 * root's slots (`workflowKernelHooks`, `workflowHostEffectHandlers` in
 * apps/web/src/modules.ts). Lazy, so loading a kernel module does not load
 * every module.
 */
export async function workflowKernel(): Promise<WorkflowKernel> {
  if (composed) return composed;
  const m = await import('@/modules');
  const ports = builddKernelPorts(m.workflowKernelHooks());
  return (composed = { ports, handlers: { ...m.workflowHostEffectHandlers(), ...kernelEffectHandlers(ports) } });
}
