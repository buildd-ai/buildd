/**
 * The conflict and migration families' halves of the kernel's ports
 * (docs/specs/workflow-state-kernel.md §6.7, §10.2, §10.5), owned by the
 * reviews module and reached only through the composition root
 * (`workflowKernelHooks()` in apps/web/src/modules.ts). The handlers
 * (`refresh_branch`, `renumber_migration`, `dispatch_conflict_fix`, conflict
 * exhaustion, the landing notice) are the package's
 * (packages/workflow-kernel/src/handlers/conflict.ts): they revalidate, decide
 * agent or person, and apply the commands. What is buildd's is the git work:
 *
 *  - `conflictsHost` (`Conflicts`): T26's plain update-branch, a bound
 *    attempt's refresh through base-refresh.ts (so the semantic check, the
 *    single-flight lease and the operational bound still apply), the
 *    byte-identical renumber through the git data API, the migration
 *    inspector's "still owed", and the dependency-bot rule.
 *  - `conflictFixWork` (`Work`, role `conflict_fix`) and `conflictEscalate`
 *    (`Escalate`, families `conflict`, `migration`).
 */
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks, workers, workspaces } from '@buildd/core/db/schema';
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';
import type { BranchUpdate, Conflicts, Escalate, MechanicalRefresh, MigrationRenumber } from '@buildd/workflow-kernel/ports';
import { githubApi } from '@/lib/github';
import { inheritAttemptIdentity } from '@/lib/attempt-identity';
import { isDependencyBotPrContext } from '@/lib/dependency-bot-pr';
import type { MigrationCollision } from '@/lib/migration-safety';
import type { Exec } from './kernel';
import { workspaceRepo } from './github-facts';
import { prWorkerWhere } from './pr-worker-where';
import type { DeliverySnapshot, AttemptSnapshot } from './types';
import type { WorkBuilder } from './kernel-ports';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';

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
    where: sqlWhere(prWorkerWhere(workspaceId, repoFullName, prNumber)),
    columns: { id: true, branch: true, prNumber: true },
    orderBy: sqlOrderBy([desc(workers.createdAt)]),
  });
}

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

// ── Conflicts: the git work behind the package's handlers ──────────────────

/** The owner task's context and mission, for the dependency-bot rule and base-refresh's records. */
async function ownerOf(d: DeliverySnapshot) {
  return db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, d.ownerTaskId)), columns: { id: true, missionId: true, context: true } });
}

async function installation(d: DeliverySnapshot): Promise<{ installationId: number; gitConfig: unknown }> {
  const repo = await workspaceRepo(d.workspaceId);
  if (!repo) throw new Error('no GitHub installation for the workspace');
  return repo;
}

/** T26's plain update-branch, pinned to the head it judged stale. */
async function updateBranch(d: DeliverySnapshot, headSha: string): Promise<BranchUpdate> {
  const repo = await installation(d);
  const { updateBehindPrBranch } = await import('@/lib/pr-branch-update');
  const res = await updateBehindPrBranch({ installationId: repo.installationId, repoFullName: d.repoFullName!, prNumber: d.prNumber!, headSha, api: deps.api });
  if (res.updated) return { kind: 'updated' };
  // Operational: retried by the outbox with backoff. Anything else (conflict, up to date, head
  // changed, refused) is answered by the PR's own facts (T3, T12).
  if (res.failure === 'transient' || res.failure === 'rate_limit' || res.failure === 'unknown') return { kind: 'retry', reason: res.reason ?? 'update-branch failed' };
  return { kind: 'refused', reason: res.failure ?? 'refused' };
}

/** A bound attempt's refresh through base-refresh.ts: the semantic check, the single-flight lease and the operational bound still apply. */
async function refresh(d: DeliverySnapshot, attempt: AttemptSnapshot): Promise<MechanicalRefresh> {
  const repo = await installation(d);
  const [owner, prw] = await Promise.all([ownerOf(d), prWorker(d.workspaceId, d.repoFullName!, d.prNumber!)]);
  const run = deps.refresh ?? (await import('@/lib/base-refresh')).refreshBehindPr;
  const out = await run({
    installationId: repo.installationId, repoFullName: d.repoFullName!, prNumber: d.prNumber!, headSha: attempt.boundHeadSha!,
    workspaceId: d.workspaceId, taskId: d.ownerTaskId, workerId: prw?.id ?? null, missionId: owner?.missionId ?? null,
    gitConfig: repo.gitConfig as WorkspaceGitConfig | null,
  });
  switch (out.kind) {
    case 'updated': return { kind: 'updated' };
    case 'up_to_date': return { kind: 'up_to_date' };
    case 'head_changed': return { kind: 'head_changed' };
    case 'conflict': return { kind: 'refused', refusal: { reason: out.reason, mode: 'textual' } };
    case 'semantic_conflict': return { kind: 'refused', refusal: { reason: out.assessment.reason, mode: 'semantic', semanticConflict: out.assessment as unknown as Record<string, unknown> } };
    case 'in_flight':
    case 'deferred':
    case 'semantic_deferred':
      // Operational and bounded by base-refresh's own counters: the outbox retries with backoff.
      return { kind: 'retry', reason: `refresh ${out.kind}${'reason' in out ? `: ${out.reason}` : ''}` };
    case 'exhausted':
    case 'semantic_unverified':
      return { kind: 'failed', reason: out.reason };
  }
}

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

/** The byte-identical renumber of the collision this repair is about, verified against live trees now (§6.7). */
async function renumber(d: DeliverySnapshot, attempt: AttemptSnapshot, payload: Record<string, unknown>): Promise<MigrationRenumber> {
  const collision = await collisionOf(d.id, payload);
  if (!collision) return { kind: 'refused', refusal: { reason: 'collision_unknown' } };
  const repoFullName = d.repoFullName!;
  const prNumber = d.prNumber!;
  const headSha = attempt.boundHeadSha!;
  const { installationId } = await installation(d);
  const pr = await api()(installationId, `/repos/${repoFullName}/pulls/${prNumber}`) as {
    head?: { ref?: string; sha?: string }; base?: { ref?: string; repo?: { default_branch?: string } };
  } | null;
  const baseRef = pr?.base?.ref ?? d.baseRef ?? null;
  // §6.7: verified against live trees NOW. The inspector compares only PRs into the same base, so a
  // mission branch lagging trunk is never read as a collision on its own.
  const inspect = deps.inspect ?? (await import('@/lib/migration-inspector')).inspectPullRequestMigrations;
  const safety = await inspect({ installationId, repoFullName, prNumber, headSha, files: [], baseRef });
  if (safety.safe || !('collision' in safety) || !safety.collision) {
    if (!safety.safe && safety.kind === 'uninspectable') return { kind: 'retry', reason: `migration collision unverifiable: ${safety.reason}` };
    return { kind: 'not_needed', reason: 'collision_resolved' };
  }
  // A slot taken on the base also needs the branch refreshed and its journal
  // and snapshot regenerated; renaming the .sql alone would leave the journal
  // colliding with the base. That is agent work.
  if (safety.collision.against === 'base' || safety.collision.otherPrNumber == null) {
    return { kind: 'refused', refusal: { reason: 'base_collision', migrationCollision: safety.collision as unknown as Record<string, unknown> } };
  }
  const otherPrNumber = safety.collision.otherPrNumber;
  const headFile = await api()(installationId, `/repos/${repoFullName}/pulls/${prNumber}/files?per_page=100`)
    .then((x) => (Array.isArray(x) ? (x as Array<{ filename: string }>) : []))
    .catch(() => []);
  const path = headFile.map((f) => f.filename).find((f) => f.endsWith(`/${safety.collision!.file}`) || f === safety.collision!.file);
  const m = path ? MIGRATION_FILE.exec(path) : null;
  if (!path || !m) return { kind: 'refused', refusal: { reason: 'migration_path_unknown' } };
  const dir = (m[1] ?? '').replace(/\/$/, '');
  const other = await api()(installationId, `/repos/${repoFullName}/pulls/${otherPrNumber}`) as { head?: { sha?: string } } | null;
  const trunk = pr?.base?.repo?.default_branch ?? baseRef ?? 'main';
  const [head, base, trunkDir, otherDir] = await Promise.all([
    dirAt(installationId, repoFullName, dir, headSha),
    baseRef ? dirAt(installationId, repoFullName, dir, baseRef) : Promise.resolve([]),
    dirAt(installationId, repoFullName, dir, trunk),
    other?.head?.sha ? dirAt(installationId, repoFullName, dir, other.head.sha) : Promise.resolve([]),
  ]);
  const plan = planRenumber({ file: safety.collision.file, dirs: { head, base, trunk: trunkDir, other: otherDir } });
  if (!plan.ok) return { kind: 'refused', refusal: { reason: plan.reason, migrationCollision: safety.collision as unknown as Record<string, unknown> } };
  const branch = pr?.head?.ref;
  const blob = head.find((x) => x.name === plan.from)!;
  if (!branch) return { kind: 'retry', reason: 'PR head branch unknown' };
  // Byte-identical by construction: the renamed path points at the same blob.
  const commit = await api()(installationId, `/repos/${repoFullName}/git/commits/${headSha}`) as { tree?: { sha?: string } } | null;
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
    body: JSON.stringify({ message: `chore(migrations): renumber ${plan.from} to ${plan.to} (collides with #${otherPrNumber})`, tree: tree?.sha, parents: [headSha] }),
  }) as { sha?: string } | null;
  if (!created?.sha) return { kind: 'retry', reason: 'renumber commit not created' };
  // Fast-forward only: a push that raced us makes GitHub refuse, and the next head is handled by T3.
  try {
    await api()(installationId, `/repos/${repoFullName}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'PATCH', body: JSON.stringify({ sha: created.sha, force: false }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/422|not a fast forward/i.test(msg)) return { kind: 'head_moved' };
    throw err;
  }
  return { kind: 'renumbered', to: plan.to };
}

// ── Is a migration repair's agent attempt still owed? (§10.5) ───────────────

async function migrationOwed(d: DeliverySnapshot, attempt: AttemptSnapshot, p: { repairKind: 'migration' | 'migration_split'; baseRef: string | null }): Promise<{ owed: boolean; reason?: string }> {
  const { installationId } = await installation(d);
  const inspect = deps.inspect ?? (await import('@/lib/migration-inspector')).inspectPullRequestMigrations;
  const q = { installationId, repoFullName: d.repoFullName!, prNumber: d.prNumber!, headSha: attempt.boundHeadSha!, files: [], baseRef: p.baseRef };
  if (p.repairKind === 'migration_split') {
    // Owed while the head still mixes EXPAND and CONTRACT; unknown fails toward doing the work.
    const safety = await inspect(q);
    return safety.safe || !safety.mixedSplit ? { owed: false, reason: 'split_resolved' } : { owed: true };
  }
  // A predecessor this PR replaces does not hold its slot (§13.11 rule 5).
  const ignorePrNumbers = deps.inspect ? [] : await (await import('@/lib/pr-predecessors')).predecessorPrNumbers(d.workspaceId, d.prNumber!);
  const safety = await inspect({ ...q, ignorePrNumbers });
  if (safety.safe) return { owed: false, reason: 'collision_resolved' };
  return { owed: true };
}

export const conflictsHost: Conflicts = {
  // A dependency bot owns its branch: the platform never pushes to it (S27).
  botOwned: async (d) => isDependencyBotPrContext((await ownerOf(d))?.context),
  updateBranch,
  refresh,
  renumber,
  migrationOwed,
};

// ── Work, role `conflict_fix`: the agent attempt's task under its row's id ──

export const conflictFixWork: WorkBuilder = async (req) => {
  const { repoFullName } = req.target;
  const prNumber = req.target.prNumber;
  const headSha = req.target.headSha;
  const ownerTaskId = req.lineage.parentTaskId;
  const attemptId = req.lineage.attemptId;
  if (prNumber == null || !headSha || !ownerTaskId || !attemptId) return { skipped: 'no_pr' };
  const detail = req.detail ?? {};
  const [owner, workspace, prw] = await Promise.all([
    db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, ownerTaskId)) }),
    db.query.workspaces.findFirst({ where: sqlWhere(eq(workspaces.id, req.workspaceId)) }),
    prWorker(req.workspaceId, repoFullName, prNumber),
  ]);
  if (!owner || !workspace || !prw?.branch) return { skipped: 'missing_context' };
  const repairKind = String(detail.repairKind ?? 'conflict');
  const refusal = (detail.refusal ?? null) as { semanticConflict?: unknown } | null;
  const repairDetail = (detail.repairDetail ?? null) as Record<string, unknown> | null;
  const collision = detail.family === 'migration' && repairKind !== 'migration_split' ? await collisionOf(req.lineage.deliveryId, { detail: repairDetail }) : null;
  const attemptNo = Number(detail.attemptNo ?? 1);
  const maxAttempts = Number(detail.maxAttempts ?? attemptNo);
  const headRef = typeof detail.headRef === 'string' ? detail.headRef : null;
  const { buildConflictRetryTask } = await import('@/lib/conflict-retry');
  const built = buildConflictRetryTask({
    originalTask: {
      id: owner.id, title: owner.title, description: owner.description, workspaceId: owner.workspaceId,
      // Display only: "attempt N of M" from the ledger row (§5.7 rule 4), never the legacy counter.
      context: { ...((owner.context as Record<string, unknown> | null) ?? {}), conflictIteration: attemptNo - 1 },
      missionId: owner.missionId ?? null, pathManifest: owner.pathManifest as string[] | null,
    },
    worker: { id: prw.id, branch: prw.branch, prNumber },
    headSha,
    repoFullName,
    ...(headRef ? { targetRefs: { headRef, baseRef: req.target.baseRef ?? null } } : {}),
    maxConflictIterations: Math.max(maxAttempts, attemptNo),
    ...(collision ? { migrationCollision: collision } : {}),
    ...(repairKind === 'migration_split' ? { migrationSplit: { reason: String((repairDetail as { reason?: string } | null)?.reason ?? '') } } : {}),
    ...(refusal?.semanticConflict ? { semanticConflict: refusal.semanticConflict as never } : {}),
  });
  if (!built) return { skipped: 'not_buildable' };
  const identity = await inheritAttemptIdentity(owner.id);
  return {
    workspace,
    values: {
      workspaceId: built.workspaceId,
      title: built.title,
      description: built.description,
      parentTaskId: built.parentTaskId,
      missionId: built.missionId,
      ...identity,
      context: { ...built.context, workflowAttemptId: attemptId, prNumber, headSha },
      creationSource: 'conflict',
      taskClass: 'attempt',
      conflictRetryPrNumber: prNumber,
      // One row per (workspace, PR, head) in the legacy dedupe index; the ledger dedupes a second attempt.
      conflictRetryHeadSha: detail.firstAtHead ? headSha : null,
      status: 'pending',
      priority: 8,
      subjectKind: 'pull_request',
      subjectPrNumber: prNumber,
      subjectHeadSha: headSha,
      subjectBranch: prw.branch,
      subjectDedupeScope: 'active',
      pathManifest: built.pathManifest,
      deliveryId: req.lineage.deliveryId,
      deliveryRole: 'conflict_fix',
    },
    refused: 'conflict fix task not filed: another conflict retry still holds this PR head',
  };
};

// ── Escalate, families `conflict` and `migration` ──────────────────────────

export const conflictEscalate: Escalate = {
  async exhausted(d, n) {
    if (n.family !== 'conflict' && n.family !== 'migration') throw new Error(`no escalation for family ${n.family}`);
    if (!d.repoFullName || d.prNumber == null) return 'skipped:no_pr';
    const { escalateConflictExhaustion: escalate } = await import('@/lib/auto-merge');
    await escalate(d.ownerTaskId, d.repoFullName, d.prNumber, n.headSha);
    return 'ok';
  },
};
