/**
 * Effect handlers for the conflict and migration families of the workflow
 * kernel (docs/specs/workflow-state-kernel.md §6.7, §10.2, §10.5), owned by
 * the reviews module like ci-retry-effects.ts and reached only through the
 * composition root (`workflowEffectHandlers()` in apps/web/src/modules.ts).
 *
 * Mechanical first. `refresh_branch` merges the base in server-side (GitHub
 * update-branch pinned to the bound head, through base-refresh.ts so the
 * semantic check, the single-flight lease and the operational bound still
 * apply); `renumber_migration` re-verifies the collision against live trees
 * and renames a byte-identical migration through the git data API. Only a
 * refusal that an agent could fix (GitHub's own textual-conflict 422, a
 * same-symbol overlap, a migration that must be regenerated) creates an agent
 * attempt, through `ConflictObserved{mechanicalRefused}`; an operational
 * failure goes to a person (`MechanicalRepairFailed`), never to an agent.
 *
 * The mechanical refresh is also the recheck that a flagged conflict is real
 * against today's base tip: if GitHub's merge of the base succeeds, nothing
 * reaches an agent. A sharper pre-agent check (a merge-tree replay) plugs in
 * at `agentIsOwed` below without changing the kernel.
 *
 * The ledger row was allocated by the transition that queued the effect
 * (allocation is consumption, §5.7 rule 1). Handlers never count anything.
 */
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks, workers, workspaces } from '@buildd/core/db/schema';
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';
import { githubApi } from '@/lib/github';
import { notifyTeamOf } from '@/lib/notify';
import { announceTaskCreated, wakeTask } from '@/lib/dispatch-authority';
import { inheritAttemptIdentity } from '@/lib/attempt-identity';
import { policyValue } from '@/lib/policy-overrides';
import { isDependencyBotPrContext } from '@/lib/dependency-bot-pr';
import type { MigrationCollision } from '@/lib/migration-safety';
import type { EffectHandler, EffectHandlers } from './effects';
import { applyCommand, loadView, type Exec } from './kernel';
import { ingestFact } from './facts';
import { githubReader, workspaceRepo } from './github-facts';
import { prWorkerWhere } from './pr-worker-where';
import type { DeliverySnapshot, AttemptSnapshot } from './types';
import type { LivePr } from './commands';

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;
type Api = (installationId: number, path: string, init?: RequestInit) => Promise<unknown>;

/** Injectable for tests: the GitHub surface and the base-refresh primitive. */
export interface ConflictEffectDeps {
  api?: Api;
  refresh?: typeof import('@/lib/base-refresh').refreshBehindPr;
  inspect?: typeof import('@/lib/migration-inspector').inspectPullRequestMigrations;
}
let deps: ConflictEffectDeps = {};
/** Exported for tests. */
export function __setConflictEffectDeps(d: ConflictEffectDeps): void { deps = d; }
const api = (): Api => deps.api ?? (githubApi as Api);

async function prWorker(workspaceId: string, repoFullName: string, prNumber: number) {
  return db.query.workers.findFirst({
    where: prWorkerWhere(workspaceId, repoFullName, prNumber),
    columns: { id: true, branch: true, prNumber: true },
    orderBy: [desc(workers.createdAt)],
  });
}

const maxAgentOf = (payload: Record<string, unknown>): number =>
  typeof payload.maxAgent === 'number' ? payload.maxAgent : policyValue('maxConflictIterations');

/** The migration collision this delivery's repair is about, from the effect payload or the latest effect that carried it. */
async function collisionOf(deliveryId: string, payload: Record<string, unknown>): Promise<MigrationCollision | null> {
  const fromPayload = (payload.detail as { migrationCollision?: MigrationCollision } | null | undefined)?.migrationCollision;
  if (fromPayload) return fromPayload;
  const rows = ((await dbExec(sql`-- workflow:repair_detail
SELECT payload->'detail'->'migrationCollision' AS c FROM workflow_effects
WHERE delivery_id = ${deliveryId}::uuid AND payload->'detail'->'migrationCollision' IS NOT NULL
ORDER BY created_at DESC LIMIT 1`)).rows ?? []) as Array<{ c: MigrationCollision | null }>;
  return rows[0]?.c ?? null;
}

interface Bound {
  d: DeliverySnapshot;
  attempt: AttemptSnapshot;
  repo: { installationId: number; repoFullName: string; gitConfig: unknown };
  live: LivePr;
}

/**
 * Shared revalidation (§10.5): the attempt is the bound, queued one; the PR is
 * open; its head is still the bound head (a moved head goes through T3, which
 * skips the queued row). Returns an outcome string when nothing is owed.
 */
async function boundAttempt(e: { deliveryId: string; payload: Record<string, unknown> }, source: string): Promise<Bound | { outcome: string }> {
  const view = await loadView({ deliveryId: e.deliveryId }, dbExec);
  const d = view.delivery;
  const attempt = view.attempts.find((a) => a.id === e.payload.attemptId);
  if (!d || !attempt) return { outcome: 'skipped:no_attempt' };
  if (attempt.status !== 'queued') return { outcome: `skipped:attempt_${attempt.status}` };
  if (d.state !== 'REPAIRING' || d.boundAttemptId !== attempt.id) {
    const r = await applyCommand({ type: 'RepairNotNeeded', actor: source, attemptId: attempt.id, reason: 'state_moved' }, { ref: { deliveryId: d.id }, exec: dbExec });
    return { outcome: `skipped:${'reason' in r ? r.reason : 'state_moved'}` };
  }
  if (!d.repoFullName || d.prNumber == null || !attempt.boundHeadSha) return { outcome: 'skipped:no_pr' };
  const repo = await workspaceRepo(d.workspaceId);
  if (!repo) throw new Error('no GitHub installation for the workspace');
  const reader = githubReader(repo.installationId);
  const live = await reader.readPr(d.repoFullName, d.prNumber);
  if (!live) throw new Error('live PR read failed');
  // A closed or merged PR is answered by its own fact (T17/T18 cancel the row).
  if (live.state !== 'open' || live.merged) return { outcome: 'skipped:pr_not_open' };
  if (live.headSha !== attempt.boundHeadSha) {
    await ingestFact({ kind: 'head_observed', workspaceId: d.workspaceId, source, repoFullName: d.repoFullName, prNumber: d.prNumber },
      { exec: dbExec, github: { ...reader, readPr: async () => live } });
    return { outcome: 'skipped:head_moved' };
  }
  return { d, attempt, repo, live };
}

const notNeeded = async (b: Bound, source: string, reason: string) => {
  await applyCommand({ type: 'RepairNotNeeded', actor: source, attemptId: b.attempt.id, reason, live: b.live }, { ref: { deliveryId: b.d.id }, exec: dbExec });
  return { outcome: `skipped:${reason}` };
};

/** The mechanical attempt was refused for a reason an agent can fix: allocate the agent attempt (T12). */
const refusedToAgent = async (b: Bound, source: string, payload: Record<string, unknown>, refusal: Record<string, unknown>, mergeable: 'dirty' | 'behind' = 'dirty') => {
  const migration = b.attempt.family === 'migration';
  const r = await applyCommand({
    type: 'ConflictObserved', actor: source, headSha: b.attempt.boundHeadSha!, mergeable,
    migrationCollision: migration, mechanicalRefused: true, maxAgentAttempts: maxAgentOf(payload),
    refusal, detail: (payload.detail as Record<string, unknown> | null) ?? null,
  }, { ref: { deliveryId: b.d.id }, exec: dbExec });
  if (r.result === 'applied') return { outcome: `ok:refused:${String(refusal.reason ?? 'refused').slice(0, 60)}` };
  return { outcome: `skipped:${r.reason}` };
};

const mechanicalFailed = async (b: Bound, source: string, reason: string) => {
  await applyCommand({ type: 'MechanicalRepairFailed', actor: source, attemptId: b.attempt.id, reason }, { ref: { deliveryId: b.d.id }, exec: dbExec });
  return { outcome: `ok:escalated:${reason.slice(0, 60)}` };
};

// ── refresh_branch: GitHub merges the base in, pinned to the bound head ─────

const refreshBranch: EffectHandler = async (e) => {
  const source = 'effect:refresh_branch';
  if (!e.payload.attemptId) {
    // The trunk-recovery refresh (T26) carries no ledger row: a plain pinned update.
    const view = await loadView({ deliveryId: e.deliveryId }, dbExec);
    const d = view.delivery;
    if (!d?.repoFullName || d.prNumber == null) return { outcome: 'skipped:no_pr' };
    const owner = await db.query.tasks.findFirst({ where: eq(tasks.id, d.ownerTaskId), columns: { context: true } });
    if (isDependencyBotPrContext(owner?.context)) return { outcome: 'skipped:dependency_bot' };
    const repo = await workspaceRepo(d.workspaceId);
    if (!repo) throw new Error('no GitHub installation for the workspace');
    const { updateBehindPrBranch } = await import('@/lib/pr-branch-update');
    const res = await updateBehindPrBranch({ installationId: repo.installationId, repoFullName: d.repoFullName, prNumber: d.prNumber, headSha: String(e.payload.headSha ?? d.currentHeadSha), api: deps.api });
    return { outcome: res.updated ? 'ok:updated' : `skipped:${res.failure ?? 'refused'}` };
  }
  const b = await boundAttempt(e, source);
  if ('outcome' in b) return b;
  const owner = await db.query.tasks.findFirst({ where: eq(tasks.id, b.d.ownerTaskId), columns: { id: true, missionId: true, context: true } });
  // A dependency bot owns its branch: the platform never pushes to it (S27). A landing door reaches
  // here through T16 without the conflict doors' own check; no agent may push either, so a person lands it.
  if (isDependencyBotPrContext(owner?.context)) return mechanicalFailed(b, source, 'dependency_bot_pr: the platform does not push to a dependency bot\'s branch');
  const prw = await prWorker(b.d.workspaceId, b.d.repoFullName!, b.d.prNumber!);
  const refresh = deps.refresh ?? (await import('@/lib/base-refresh')).refreshBehindPr;
  const out = await refresh({
    installationId: b.repo.installationId, repoFullName: b.d.repoFullName!, prNumber: b.d.prNumber!, headSha: b.attempt.boundHeadSha!,
    workspaceId: b.d.workspaceId, taskId: b.d.ownerTaskId, workerId: prw?.id ?? null, missionId: owner?.missionId ?? null,
    gitConfig: b.repo.gitConfig as WorkspaceGitConfig | null,
  });
  switch (out.kind) {
    case 'updated': {
      // The new head arrives through T3; §6.9 attributes it to this mechanical row. Read it now
      // so the common path does not wait for the webhook.
      await ingestFact({ kind: 'head_observed', workspaceId: b.d.workspaceId, source, repoFullName: b.d.repoFullName!, prNumber: b.d.prNumber! },
        { exec: dbExec, github: githubReader(b.repo.installationId) });
      return { outcome: 'ok:updated' };
    }
    case 'up_to_date':
      // Nothing to merge in: the "behind"/"dirty" reading was stale.
      return notNeeded(b, source, 'up_to_date');
    case 'head_changed':
      await ingestFact({ kind: 'head_observed', workspaceId: b.d.workspaceId, source, repoFullName: b.d.repoFullName!, prNumber: b.d.prNumber! },
        { exec: dbExec, github: githubReader(b.repo.installationId) });
      return { outcome: 'skipped:head_moved' };
    case 'conflict':
      return refusedToAgent(b, source, e.payload, { reason: out.reason, mode: 'textual' });
    case 'semantic_conflict':
      return refusedToAgent(b, source, e.payload, { reason: out.assessment.reason, mode: 'semantic', semanticConflict: out.assessment as unknown as Record<string, unknown> });
    case 'in_flight':
    case 'deferred':
    case 'semantic_deferred':
      // Operational and bounded by base-refresh's own counters: the outbox retries with backoff.
      throw new Error(`refresh ${out.kind}${'reason' in out ? `: ${out.reason}` : ''}`);
    case 'exhausted':
    case 'semantic_unverified':
      return mechanicalFailed(b, source, out.reason);
  }
};

// ── renumber_migration: a byte-identical rename, or an agent ───────────────

const MIGRATION_FILE = /^(.*\/)?(\d{4})_([^/]+\.sql)$/;

interface ContentEntry { name: string; path: string; sha: string; type: string }

async function dirAt(installationId: number, repo: string, dir: string, ref: string): Promise<ContentEntry[]> {
  const out = await api()(installationId, `/repos/${repo}/contents/${dir.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`).catch(() => null);
  return Array.isArray(out) ? (out as ContentEntry[]) : [];
}

const numberOf = (name: string): number | null => {
  const m = /^(\d{4})_[^/]+\.sql$/.exec(name);
  return m ? Number(m[1]) : null;
};

/**
 * Plan the rename: the next free index past this PR's base, the current trunk
 * and the colliding PR's head, so the new slot collides with nothing a reader
 * of either branch can see. Refused (an agent regenerates) when the migration
 * directory has a journal or snapshots: those encode the chain and cannot be
 * renumbered byte-identically.
 */
export function planRenumber(p: {
  file: string;
  dirs: { head: ContentEntry[]; base: ContentEntry[]; trunk: ContentEntry[]; other: ContentEntry[] };
}): { ok: true; from: string; to: string } | { ok: false; reason: string } {
  if (p.dirs.head.some((x) => x.name === 'meta' && x.type === 'dir')) return { ok: false, reason: 'journal_regenerate_required' };
  const own = p.dirs.head.find((x) => x.name === p.file);
  if (!own) return { ok: false, reason: 'migration_not_on_head' };
  const width = /^(\d+)_/.exec(p.file)?.[1].length ?? 4;
  const used = [...p.dirs.head, ...p.dirs.base, ...p.dirs.trunk, ...p.dirs.other].map((x) => numberOf(x.name)).filter((n): n is number => n != null);
  const next = Math.max(0, ...used) + 1;
  const to = `${String(next).padStart(width, '0')}_${p.file.replace(/^\d+_/, '')}`;
  return { ok: true, from: p.file, to };
}

const renumberMigration: EffectHandler = async (e) => {
  const source = 'effect:renumber_migration';
  const b = await boundAttempt(e, source);
  if ('outcome' in b) return b;
  const collision = await collisionOf(b.d.id, e.payload);
  if (!collision) return refusedToAgent(b, source, e.payload, { reason: 'collision_unknown' });
  const repoFullName = b.d.repoFullName!;
  const prNumber = b.d.prNumber!;
  const installationId = b.repo.installationId;
  const pr = await api()(installationId, `/repos/${repoFullName}/pulls/${prNumber}`) as {
    head?: { ref?: string; sha?: string }; base?: { ref?: string; repo?: { default_branch?: string } };
  } | null;
  const baseRef = pr?.base?.ref ?? b.d.baseRef ?? null;
  // §6.7: verified against live trees NOW. The inspector compares only PRs into the same base, so a
  // mission branch lagging trunk is never read as a collision on its own.
  const inspect = deps.inspect ?? (await import('@/lib/migration-inspector')).inspectPullRequestMigrations;
  const safety = await inspect({ installationId, repoFullName, prNumber, headSha: b.attempt.boundHeadSha!, files: [], baseRef });
  if (safety.safe || !('collision' in safety) || !safety.collision) {
    if (!safety.safe && /could not/.test(safety.reason)) throw new Error(`migration collision unverifiable: ${safety.reason}`);
    return notNeeded(b, source, 'collision_resolved');
  }
  const headFile = await api()(installationId, `/repos/${repoFullName}/pulls/${prNumber}/files?per_page=100`)
    .then((x) => (Array.isArray(x) ? (x as Array<{ filename: string }>) : []))
    .catch(() => []);
  const path = headFile.map((f) => f.filename).find((f) => f.endsWith(`/${safety.collision!.file}`) || f === safety.collision!.file);
  const m = path ? MIGRATION_FILE.exec(path) : null;
  if (!path || !m) return refusedToAgent(b, source, e.payload, { reason: 'migration_path_unknown' });
  const dir = (m[1] ?? '').replace(/\/$/, '');
  const other = await api()(installationId, `/repos/${repoFullName}/pulls/${safety.collision.otherPrNumber}`) as { head?: { sha?: string } } | null;
  const trunk = pr?.base?.repo?.default_branch ?? baseRef ?? 'main';
  const [head, base, trunkDir, otherDir] = await Promise.all([
    dirAt(installationId, repoFullName, dir, b.attempt.boundHeadSha!),
    baseRef ? dirAt(installationId, repoFullName, dir, baseRef) : Promise.resolve([]),
    dirAt(installationId, repoFullName, dir, trunk),
    other?.head?.sha ? dirAt(installationId, repoFullName, dir, other.head.sha) : Promise.resolve([]),
  ]);
  const plan = planRenumber({ file: safety.collision.file, dirs: { head, base, trunk: trunkDir, other: otherDir } });
  if (!plan.ok) return refusedToAgent(b, source, e.payload, { reason: plan.reason, migrationCollision: safety.collision as unknown as Record<string, unknown> });
  const branch = pr?.head?.ref;
  const blob = head.find((x) => x.name === plan.from)!;
  if (!branch) throw new Error('PR head branch unknown');
  // Byte-identical by construction: the renamed path points at the same blob.
  const commit = await api()(installationId, `/repos/${repoFullName}/git/commits/${b.attempt.boundHeadSha}`) as { tree?: { sha?: string } } | null;
  const tree = await api()(installationId, `/repos/${repoFullName}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({
      base_tree: commit?.tree?.sha,
      tree: [
        { path: `${dir ? `${dir}/` : ''}${plan.to}`, mode: '100644', type: 'blob', sha: blob.sha },
        { path: `${dir ? `${dir}/` : ''}${plan.from}`, mode: '100644', type: 'blob', sha: null },
      ],
    }),
  }) as { sha?: string } | null;
  const created = await api()(installationId, `/repos/${repoFullName}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message: `chore(migrations): renumber ${plan.from} to ${plan.to} (collides with #${safety.collision.otherPrNumber})`, tree: tree?.sha, parents: [b.attempt.boundHeadSha] }),
  }) as { sha?: string } | null;
  if (!created?.sha) throw new Error('renumber commit not created');
  // Fast-forward only: a push that raced us makes GitHub refuse, and the next head is handled by T3.
  try {
    await api()(installationId, `/repos/${repoFullName}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'PATCH', body: JSON.stringify({ sha: created.sha, force: false }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/422|not a fast forward/i.test(msg)) {
      await ingestFact({ kind: 'head_observed', workspaceId: b.d.workspaceId, source, repoFullName, prNumber }, { exec: dbExec, github: githubReader(installationId) });
      return { outcome: 'skipped:head_moved' };
    }
    throw err;
  }
  await ingestFact({ kind: 'head_observed', workspaceId: b.d.workspaceId, source, repoFullName, prNumber }, { exec: dbExec, github: githubReader(installationId) });
  return { outcome: `ok:renumbered:${plan.to}` };
};

// ── dispatch_conflict_fix: revalidate, then file the attempt's task ─────────

/**
 * Is the agent attempt still owed now (§10.5)? The conflict kind needs GitHub
 * to still report a conflict; the migration kind needs the collision to still
 * be there. Unknown fails toward doing the work.
 */
async function agentIsOwed(b: Bound, repairKind: string): Promise<{ owed: boolean; reason?: string }> {
  if (repairKind === 'migration') {
    const inspect = deps.inspect ?? (await import('@/lib/migration-inspector')).inspectPullRequestMigrations;
    const safety = await inspect({ installationId: b.repo.installationId, repoFullName: b.d.repoFullName!, prNumber: b.d.prNumber!, headSha: b.attempt.boundHeadSha!, files: [], baseRef: b.live.baseRef });
    if (safety.safe) return { owed: false, reason: 'collision_resolved' };
    return { owed: true };
  }
  const st = b.live.mergeableState;
  if (st === 'clean' || st === 'unstable' || st === 'has_hooks' || st === 'blocked') return { owed: false, reason: 'conflict_resolved' };
  return { owed: true };
}

const dispatchConflictFix: EffectHandler = async (e) => {
  const source = 'effect:dispatch_conflict_fix';
  const view0 = await loadView({ deliveryId: e.deliveryId }, dbExec);
  const pre = view0.attempts.find((a) => a.id === e.payload.attemptId);
  // The task id IS the attempt id, so a re-run after a crash between insert and link files nothing twice.
  if (pre?.taskId) return { outcome: 'ok:task_exists' };
  const b = await boundAttempt(e, source);
  if ('outcome' in b) return b;
  const repairKind = String(e.payload.repairKind ?? b.attempt.triggerReason ?? (b.attempt.family === 'migration' ? 'migration' : 'conflict'));
  const owed = await agentIsOwed(b, repairKind);
  if (!owed.owed) return notNeeded(b, source, owed.reason ?? 'conflict_resolved');

  const [owner, workspace, prw] = await Promise.all([
    db.query.tasks.findFirst({ where: eq(tasks.id, b.d.ownerTaskId) }),
    db.query.workspaces.findFirst({ where: eq(workspaces.id, b.d.workspaceId) }),
    prWorker(b.d.workspaceId, b.d.repoFullName!, b.d.prNumber!),
  ]);
  if (!owner || !workspace || !prw?.branch) return { outcome: 'skipped:missing_context' };
  const headSha = b.attempt.boundHeadSha!;
  const refusal = (e.payload.refusal ?? null) as { semanticConflict?: unknown } | null;
  const collision = b.attempt.family === 'migration' ? await collisionOf(b.d.id, e.payload) : null;
  const { buildConflictRetryTask } = await import('@/lib/conflict-retry');
  const built = buildConflictRetryTask({
    originalTask: {
      id: owner.id, title: owner.title, description: owner.description, workspaceId: owner.workspaceId,
      // Display only: "attempt N of M" from the ledger row (§5.7 rule 4), never the legacy counter.
      context: { ...((owner.context as Record<string, unknown> | null) ?? {}), conflictIteration: b.attempt.attemptNo - 1 },
      missionId: owner.missionId ?? null, pathManifest: owner.pathManifest as string[] | null,
    },
    worker: { id: prw.id, branch: prw.branch, prNumber: b.d.prNumber! },
    headSha,
    repoFullName: b.d.repoFullName!,
    maxConflictIterations: Math.max(b.attempt.maxAttempts, b.attempt.attemptNo),
    ...(collision ? { migrationCollision: collision } : {}),
    ...(refusal?.semanticConflict ? { semanticConflict: refusal.semanticConflict as never } : {}),
  });
  if (!built) return { outcome: 'skipped:not_buildable' };
  const firstAtHead = view0.attempts.filter((a) => (a.family === 'conflict' || a.family === 'migration') && a.mode === 'agent' && a.boundHeadSha === headSha && a.status !== 'skipped').length <= 1;
  const identity = await inheritAttemptIdentity(owner.id);
  const taskId = b.attempt.id;
  const [row] = await db.insert(tasks).values({
    id: taskId,
    workspaceId: built.workspaceId,
    title: built.title,
    description: built.description,
    parentTaskId: built.parentTaskId,
    missionId: built.missionId,
    ...identity,
    context: { ...built.context, workflowAttemptId: b.attempt.id, prNumber: b.d.prNumber, headSha },
    creationSource: 'conflict',
    taskClass: 'attempt',
    conflictRetryPrNumber: b.d.prNumber,
    // One row per (workspace, PR, head) in the legacy dedupe index; the ledger dedupes a second attempt.
    conflictRetryHeadSha: firstAtHead ? headSha : null,
    status: 'pending',
    priority: 8,
    subjectKind: 'pull_request',
    subjectPrNumber: b.d.prNumber,
    subjectHeadSha: headSha,
    subjectBranch: prw.branch,
    subjectDedupeScope: 'active',
    pathManifest: built.pathManifest,
    deliveryId: b.d.id,
    deliveryRole: 'conflict_fix',
  } as never).onConflictDoNothing().returning();
  if (!row) {
    const existing = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId), columns: { id: true } });
    if (!existing) throw new Error('conflict fix task not filed: another conflict retry still holds this PR head');
  }
  await dbExec(sql`-- workflow:link_attempt_task
UPDATE workflow_attempts SET task_id = ${taskId}::uuid, updated_at = now()
WHERE id = ${b.attempt.id}::uuid AND task_id IS NULL`);
  if (!row) return { outcome: 'ok:task_exists' };
  await announceTaskCreated(row as never, workspace as never);
  await wakeTask(row.id, 'conflict.retry');
  return { outcome: 'ok' };
};

// ── Escalations: the conflict family's budget, a mechanical dead end ────────

const escalateConflictExhaustion: EffectHandler = async (e) => {
  const view = await loadView({ deliveryId: e.deliveryId }, dbExec);
  const d = view.delivery;
  if (!d?.repoFullName || d.prNumber == null || !d.currentHeadSha) return { outcome: 'skipped:no_pr' };
  const { escalateConflictExhaustion: escalate } = await import('@/lib/auto-merge');
  await escalate(d.ownerTaskId, d.repoFullName, d.prNumber, d.currentHeadSha);
  return { outcome: 'ok' };
};

const notifyLandingNeedsHuman: EffectHandler = async (e) => {
  const view = await loadView({ deliveryId: e.deliveryId }, dbExec);
  const d = view.delivery;
  if (!d?.repoFullName || d.prNumber == null) return { outcome: 'skipped:no_pr' };
  void notifyTeamOf({ workspaceId: d.workspaceId }, 'needsAttention', {
    title: `PR #${d.prNumber}: landing needs a person`,
    message: String(e.payload.detail ?? 'the platform could not bring the branch up to date'),
    url: `https://github.com/${d.repoFullName}/pull/${d.prNumber}`,
    urlTitle: 'View PR',
  });
  return { outcome: 'ok' };
};

/** The CI-composed handlers plus the conflict and migration families: what the composition root registers. */
export function withConflictEffects(base: EffectHandlers): EffectHandlers {
  return {
    ...base,
    refresh_branch: refreshBranch,
    renumber_migration: renumberMigration,
    dispatch_conflict_fix: dispatchConflictFix,
    escalate_exhaustion: async (e) => (e.payload.family === 'conflict' || e.payload.family === 'migration'
      ? escalateConflictExhaustion(e)
      : (base.escalate_exhaustion ? base.escalate_exhaustion(e) : { outcome: 'skipped:no_handler' })),
    notify: async (e) => (e.payload.event === 'landing_needs_human'
      ? notifyLandingNeedsHuman(e)
      : (base.notify ? base.notify(e) : { outcome: 'skipped:no_channel' })),
  };
}

// Exported for tests.
export const __conflictHandlers = { refreshBranch, renumberMigration, dispatchConflictFix, escalateConflictExhaustion, notifyLandingNeedsHuman };
