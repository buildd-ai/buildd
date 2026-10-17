/**
 * Mission deliveries and epochs, the host half (docs/specs/workflow-kernel-library.md
 * §6, AC-20–AC-23; tasks f3bda4e1 and a11abc4b).
 *
 * The one writer of `workflow_mission_epochs`. Every transition is the
 * package's reducer (`@buildd/workflow-kernel/delivery-epochs`) applied in ONE
 * statement here: a version-guarded UPDATE of the epoch row, any successor
 * INSERT and the projection of the writable branch onto `missions.workingBranch`,
 * chained as data-modifying CTEs so all of it commits or none does. A unique
 * index (one epoch per number, one successor per predecessor, one open epoch
 * per mission) or a lost compare-and-set aborts the statement; the caller
 * re-reads and reduces again, which is how a replayed merge ends as a noop.
 *
 * The work a transition leaves owed (cut the successor branch, settle the PRs
 * left on a merged branch, retire it) is derived from the rows by
 * `pendingEpochSteps`, performed here against GitHub, and recorded back
 * through the reducer, so a crash between a step and its record is redone by
 * the next caller or the hourly reconcile, never lost and never doubled.
 *
 * Reached from outside the kernel only through the seam (commands) and
 * `delivery-ship` (the read mission completion and refresh use).
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import {
  pendingEpochSteps, reduceMissionEpochs, classifySettlement, writableEpoch, latestEpoch, deliveryBranchFinished, finishedBranchWhy,
  type BranchFinishFacts,
  type EpochOp, type EpochPatch, type EpochResult, type EpochSettlement, type EpochSnapshot, type LegacyMissionPr,
  type MissionEpochCommand, type MissionEpochView, type SettlementCandidate, type SettledPr,
} from '@buildd/workflow-kernel/delivery-epochs';
import type { Exec } from './kernel';

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

/** The GitHub client shape (`@/lib/github` githubApi): throws `GitHub API error: <status> <body>` on non-2xx. */
export type GithubApi = (installationId: number, path: string, init?: RequestInit) => Promise<any>;

export class EpochWriteConflict extends Error {
  constructor(readonly why: string) { super(`mission epoch write conflict: ${why}`); this.name = 'EpochWriteConflict'; }
}

// ── Reads ───────────────────────────────────────────────────────────────────

const EPOCH_COLUMNS = sql`id, mission_id, epoch, branch, state, version, origin, cut_from_sha, branch_ready_at, predecessor_id,
  scope_version, repo_full_name, pr_number, owner_task_id, merged_at, merge_commit_sha, merged_head_sha,
  settlement, settled_at, retired_at, moved_prs`;

export function missionEpochsSql(missionIds: string[]): SQL {
  return sql`-- workflow:mission_epochs
SELECT ${EPOCH_COLUMNS} FROM workflow_mission_epochs
WHERE mission_id IN (SELECT (jsonb_array_elements_text(${JSON.stringify(missionIds)}::jsonb))::uuid)
ORDER BY mission_id, epoch`;
}

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const str = (v: unknown): string | null => (v == null ? null : String(v));
const num = (v: unknown): number | null => (v == null ? null : Number(v));

export function toEpochSnapshot(r: Record<string, unknown>): EpochSnapshot {
  return {
    id: String(r.id), missionId: String(r.mission_id), epoch: Number(r.epoch), branch: String(r.branch),
    state: r.state === 'merged' ? 'merged' : 'open', version: Number(r.version ?? 0),
    origin: (r.origin === 'adopted' || r.origin === 'adopted_recut') ? r.origin : 'cut',
    cutFromSha: str(r.cut_from_sha), branchReadyAt: iso(r.branch_ready_at), predecessorId: str(r.predecessor_id),
    scopeVersion: Number(r.scope_version ?? 1), repoFullName: str(r.repo_full_name), prNumber: num(r.pr_number),
    ownerTaskId: str(r.owner_task_id), mergedAt: iso(r.merged_at), mergeCommitSha: str(r.merge_commit_sha),
    mergedHeadSha: str(r.merged_head_sha),
    settlement: (r.settlement ?? null) as EpochSettlement | null,
    settledAt: iso(r.settled_at), retiredAt: iso(r.retired_at),
    movedPrs: Array.isArray(r.moved_prs) ? (r.moved_prs as unknown[]).map(Number) : [],
  };
}

/** missionId → its epochs, ordered. Missions with none are absent. */
export async function epochsForMissions(missionIds: string[], exec: Exec = dbExec): Promise<Map<string, EpochSnapshot[]>> {
  const out = new Map<string, EpochSnapshot[]>();
  if (missionIds.length === 0) return out;
  for (const r of ((await exec(missionEpochsSql(missionIds))).rows ?? []) as Array<Record<string, unknown>>) {
    const e = toEpochSnapshot(r);
    out.set(e.missionId, [...(out.get(e.missionId) ?? []), e]);
  }
  return out;
}

export interface MissionRow {
  id: string;
  workspaceId: string | null;
  status: string;
  workingBranch: string | null;
  integrationBranchEnabled: boolean;
  scopeVersion: number;
}

function missionRowSql(missionId: string): SQL {
  return sql`-- workflow:mission_epoch_mission
SELECT id, workspace_id, status, working_branch, integration_branch_enabled, scope_version FROM missions WHERE id = ${missionId}::uuid`;
}

/** Everything the reducer reads for one mission. The host's work counts come from `evaluateMissionWorkState`. */
export async function loadMissionEpochView(missionId: string, deps: EpochDeps = {}): Promise<{ view: MissionEpochView; mission: MissionRow } | null> {
  const exec = deps.exec ?? dbExec;
  const m = ((await exec(missionRowSql(missionId))).rows ?? [])[0] as Record<string, unknown> | undefined;
  if (!m) return null;
  const mission: MissionRow = {
    id: String(m.id), workspaceId: str(m.workspace_id), status: String(m.status),
    workingBranch: str(m.working_branch), integrationBranchEnabled: m.integration_branch_enabled === true,
    scopeVersion: Number(m.scope_version ?? 1),
  };
  const epochs = (await epochsForMissions([missionId], exec)).get(missionId) ?? [];
  const work = await (deps.workOf ?? defaultWorkOf)(missionId);
  const legacyPr = epochs.length === 0 ? await (deps.legacyPrOf ?? defaultLegacyPrOf)(missionId) : null;
  const branch = mission.integrationBranchEnabled ? mission.workingBranch?.trim() || null : null;
  return {
    mission,
    view: {
      missionId, integrationBranch: branch, terminal: mission.status === 'completed' || mission.status === 'archived',
      scopeVersion: mission.scopeVersion, epochs, work, legacyPr,
    },
  };
}

/**
 * What the missions module answers for the kernel (the composition root's
 * `MISSION_EPOCH_HOOKS` slot, apps/web/src/modules.ts): core reaches a module
 * through a slot, never an import (scripts/module-boundaries.test.ts).
 */
export interface MissionEpochHooks {
  /** Deliverable work not yet on trunk (`evaluateMissionWorkState`). */
  workOf(missionId: string): Promise<MissionEpochView['work']>;
  /** The mission PR buildd recorded before epochs (`findMissionPrOwner`). */
  legacyPrOf(missionId: string): Promise<LegacyMissionPr | null>;
  /** The workspace whose repo holds the mission's branches (`resolveMissionRepoWorkspaceId`). */
  repoWorkspaceOf(missionId: string, missionWorkspaceId: string | null): Promise<string | null>;
}

async function hooks(): Promise<MissionEpochHooks> {
  return (await import('@/modules')).MISSION_EPOCH_HOOKS;
}

async function defaultWorkOf(missionId: string): Promise<MissionEpochView['work']> {
  return (await hooks()).workOf(missionId);
}

async function defaultLegacyPrOf(missionId: string): Promise<LegacyMissionPr | null> {
  return (await hooks()).legacyPrOf(missionId);
}

// ── The one write statement ─────────────────────────────────────────────────

const PATCH_COLUMNS: Record<keyof EpochPatch, [string, 'text' | 'int' | 'uuid' | 'timestamptz' | 'jsonb' | 'int[]']> = {
  state: ['state', 'text'],
  repoFullName: ['repo_full_name', 'text'],
  prNumber: ['pr_number', 'int'],
  ownerTaskId: ['owner_task_id', 'uuid'],
  mergedAt: ['merged_at', 'timestamptz'],
  mergeCommitSha: ['merge_commit_sha', 'text'],
  mergedHeadSha: ['merged_head_sha', 'text'],
  branchReadyAt: ['branch_ready_at', 'timestamptz'],
  settlement: ['settlement', 'jsonb'],
  settledAt: ['settled_at', 'timestamptz'],
  retiredAt: ['retired_at', 'timestamptz'],
  movedPrs: ['moved_prs', 'int[]'],
};

function value(v: unknown, cast: string): SQL {
  if (v == null) return sql`NULL`;
  switch (cast) {
    case 'int': return sql`${Number(v)}::int`;
    case 'uuid': return sql`${String(v)}::uuid`;
    case 'timestamptz': return sql`${String(v)}::timestamptz`;
    case 'jsonb': return sql`${JSON.stringify(v)}::jsonb`;
    case 'int[]': return sql`ARRAY(SELECT (jsonb_array_elements_text(${JSON.stringify(v)}::jsonb))::int)::int[]`;
    default: return sql`${String(v)}::text`;
  }
}

/**
 * One transition's ops as one statement. At most one update (a transition
 * names one epoch); every insert and the branch projection run only when it
 * matched, and an adopted epoch 2 names the epoch 1 inserted beside it.
 * Returns `applied = false` when the compare-and-set matched nothing.
 */
export function applyEpochOpsSql(ops: EpochOp[]): SQL {
  const updates = ops.filter((o): o is Extract<EpochOp, { op: 'update' }> => o.op === 'update');
  const inserts = ops.filter((o): o is Extract<EpochOp, { op: 'insert' }> => o.op === 'insert');
  const projects = ops.filter((o): o is Extract<EpochOp, { op: 'project_branch' }> => o.op === 'project_branch');
  if (updates.length > 1) throw new Error('a mission epoch transition updates at most one epoch');
  const ctes: SQL[] = [];
  const u = updates[0];
  // A branch projection that would match nothing (the mission's branch moved
  // since the read) writes nothing at all: the caller re-reads, never a
  // transition that reports success with the mission still on the old branch.
  const branchOk = projects.length > 0
    ? sql.join(projects.map((p) => sql`EXISTS (SELECT 1 FROM missions WHERE id = ${p.missionId}::uuid AND working_branch IS NOT DISTINCT FROM ${value(p.fromBranch, 'text')})`), sql` AND `)
    : null;
  if (u) {
    const sets = Object.entries(u.set).map(([k, v]) => {
      const [col, cast] = PATCH_COLUMNS[k as keyof EpochPatch];
      return sql`${sql.identifier(col)} = ${value(v, cast)}`;
    });
    ctes.push(sql`u AS (
  UPDATE workflow_mission_epochs SET ${sql.join([...sets, sql`version = version + 1`, sql`updated_at = now()`], sql`, `)}
  WHERE id = ${u.epochId}::uuid AND version = ${u.expectVersion}${branchOk ? sql` AND ${branchOk}` : sql``}
  RETURNING id)`);
  }
  const gate = u ? sql`EXISTS (SELECT 1 FROM u)` : (branchOk ?? sql`true`);
  inserts.forEach((ins, i) => {
    const e = ins.epoch;
    const prior = e.predecessorEpoch != null ? inserts.findIndex((x) => x.epoch.epoch === e.predecessorEpoch) : -1;
    const predecessor = prior >= 0 ? sql`(SELECT id FROM ${sql.identifier(`i${prior}`)})` : value(e.predecessorId, 'uuid');
    ctes.push(sql`${sql.identifier(`i${i}`)} AS (
  INSERT INTO workflow_mission_epochs (mission_id, epoch, branch, state, origin, cut_from_sha, branch_ready_at, predecessor_id,
    scope_version, repo_full_name, pr_number, owner_task_id, merged_at, merge_commit_sha, merged_head_sha, settled_at, retired_at)
  SELECT ${e.missionId}::uuid, ${e.epoch}::int, ${e.branch}::text, ${e.state}::text, ${e.origin}::text, ${value(e.cutFromSha, 'text')},
    ${value(e.branchReadyAt, 'timestamptz')}, ${predecessor}, ${e.scopeVersion}::int, ${value(e.repoFullName, 'text')},
    ${value(e.prNumber, 'int')}, ${value(e.ownerTaskId, 'uuid')}, ${value(e.mergedAt, 'timestamptz')},
    ${value(e.mergeCommitSha, 'text')}, ${value(e.mergedHeadSha, 'text')}, ${value(e.settledAt, 'timestamptz')}, ${value(e.retiredAt, 'timestamptz')}
  WHERE ${gate}
  RETURNING id)`);
  });
  projects.forEach((p, i) => {
    // The refresh pointers name the old epoch's branch; the successor starts with none.
    ctes.push(sql`${sql.identifier(`p${i}`)} AS (
  UPDATE missions SET working_branch = ${p.branch}::text, branch_refresh_head_sha = NULL, branch_refresh_conflict_task_id = NULL, updated_at = now()
  WHERE id = ${p.missionId}::uuid AND working_branch IS NOT DISTINCT FROM ${value(p.fromBranch, 'text')} AND ${gate}
  RETURNING id)`);
  });
  const applied = u ? sql`EXISTS (SELECT 1 FROM u)` : inserts.length > 0 ? sql`EXISTS (SELECT 1 FROM i0)` : sql`true`;
  // S4b review: an applied transition touches its mission's row in the same statement (a branch
  // projection already does), so the completion write, compare-and-set on the mission row, waits
  // for it and then sees the row it wrote (mission-completion-write.ts).
  if (projects.length === 0 && (u || inserts.length > 0)) {
    const mission = u ? sql`(SELECT mission_id FROM workflow_mission_epochs WHERE id = ${u.epochId}::uuid)` : sql`${inserts[0]!.epoch.missionId}::uuid`;
    ctes.push(sql`m_touch AS (
  UPDATE missions SET updated_at = now()
  WHERE id = ${mission} AND ${applied}
  RETURNING id)`);
  }
  return sql`-- workflow:mission_epoch_transition
WITH ${sql.join(ctes, sql`,\n`)}
SELECT ${applied} AS applied`;
}

function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 4; e = (e as { cause?: unknown }).cause, i++) {
    if ((e as { code?: unknown }).code === '23505') return true;
    if (/duplicate key value violates unique constraint/i.test(String((e as { message?: unknown }).message ?? ''))) return true;
  }
  return false;
}

// ── The command runner ──────────────────────────────────────────────────────

export interface EpochDeps {
  exec?: Exec;
  api?: GithubApi;
  now?: () => Date;
  workOf?: (missionId: string) => Promise<MissionEpochView['work']>;
  legacyPrOf?: (missionId: string) => Promise<LegacyMissionPr | null>;
  /** Where the mission's branches live. Default: its repo workspace's installation. */
  repoOf?: (mission: MissionRow) => Promise<MissionRepo | null>;
  /** A redundant PR's resolution recorded on its kernel delivery (the seam's T20). Default: the seam. */
  recordSupersession?: (p: { workspaceId: string; repoFullName: string; prNumber: number; installationId: number; satisfiedBy: { prNumber: number; url: string | null }; reason: string }) => Promise<void>;
  /** A person decides about the held PRs (a mission note). */
  noteHeld?: (missionId: string, title: string, body: string) => Promise<void>;
  /** Refresh-task PRs of the mission in this repo, for settlement classification. */
  refreshPrsOf?: (missionId: string, repoFullName: string) => Promise<Set<number>>;
  /** Mission PRs in this repo whose recorded base is still `branch` (the lost-webhook fallback). */
  recordedOnBranchOf?: (missionId: string, repoFullName: string, branch: string) => Promise<number[]>;
  /** Scratch-ref suffixes (tests); default a random UUID. */
  newId?: () => string;
  /** Refresh tasks filed for `branch` that never started (no worker yet): their premise is gone. */
  obsoleteRefreshTasksOf?: (missionId: string, branch: string) => Promise<string[]>;
  /** Cancel a task that never started (the kernel's Work port). */
  cancelTask?: (taskId: string, reason: string) => Promise<void>;
  /** A reconcile recorded a settlement or retirement. Default: the `mission.delivery_settled` core event. */
  settled?: (missionId: string, steps: ReconcileOutcome['steps']) => Promise<void>;
  /** The merged PR recorded as carrying a closed PR's work (its supersession edge), if any. */
  supersessionOf?: (repoFullName: string, prNumber: number) => Promise<{ prNumber: number; url: string | null } | null>;
  /** Closed refresh PRs of the mission on `branch` whose resolution is not recorded yet (the retry list). */
  unsettledClosedRefreshesOf?: (missionId: string, repoFullName: string, branch: string) => Promise<number[]>;
  /** A mission note posted at most once per title. */
  noteOnce?: (missionId: string, title: string, body: string) => Promise<void>;
}

export interface MissionRepo {
  workspaceId: string;
  installationId: number;
  repoFullName: string;
  trunk: string;
}

/**
 * Reduce and apply one command, retrying on a lost race against a fresh read.
 * Adoption runs first for a mission that predates epochs, so every command
 * sees rows.
 */
export async function applyMissionEpochCommand(missionId: string, cmd: MissionEpochCommand, deps: EpochDeps = {}): Promise<EpochResult & { view: MissionEpochView | null }> {
  const exec = deps.exec ?? dbExec;
  for (let attempt = 0; attempt < 4; attempt++) {
    const loaded = await loadMissionEpochView(missionId, deps);
    if (!loaded) return { result: 'rejected', ops: [], reason: 'mission_not_found', view: null };
    let { view } = loaded;
    // Every adoption reads the branch the same way (`adoptionFacts`): whichever
    // command triggers it, a branch that moved on past a merged mission PR is
    // the live delivery, never folded into the merged record.
    if (view.epochs.length === 0 && view.integrationBranch && (cmd.type !== 'Adopt' || cmd.liveBranchAhead === undefined)) {
      const facts = cmd.type === 'Adopt' && cmd.mergingPr != null
        ? { mergingPr: cmd.mergingPr, liveBranchAhead: false }
        : await adoptionFactsFor(loaded, deps);
      const mergingPr = cmd.type === 'Merged' ? cmd.prNumber : facts.mergingPr;
      const adopt = reduceMissionEpochs(view, { type: 'Adopt', actor: cmd.actor, at: cmd.at, mergingPr, liveBranchAhead: mergingPr != null ? false : facts.liveBranchAhead });
      if (cmd.type === 'Adopt') {
        if (adopt.result !== 'applied') return { ...adopt, view };
        try { await run(exec, adopt.ops); } catch (err) { if (!(err instanceof EpochWriteConflict)) throw err; continue; }
        return { ...adopt, view: (await loadMissionEpochView(missionId, deps))?.view ?? view };
      }
      if (adopt.result === 'applied') {
        try { await run(exec, adopt.ops); } catch (err) { if (!(err instanceof EpochWriteConflict)) throw err; }
        continue;
      }
    }
    const r = reduceMissionEpochs(view, cmd);
    if (r.result !== 'applied') return { ...r, view };
    try {
      await run(exec, r.ops);
      const after = await loadMissionEpochView(missionId, deps);
      view = after?.view ?? view;
      return { ...r, view };
    } catch (err) {
      if (!(err instanceof EpochWriteConflict)) throw err;
    }
  }
  throw new EpochWriteConflict('did not converge after four reads');
}

async function run(exec: Exec, ops: EpochOp[]): Promise<void> {
  let rows: unknown[] | undefined;
  try {
    rows = (await exec(applyEpochOpsSql(ops))).rows;
  } catch (err) {
    if (isUniqueViolation(err)) throw new EpochWriteConflict('unique');
    throw err;
  }
  const applied = (rows?.[0] as { applied?: unknown } | undefined)?.applied;
  if (applied !== true && applied !== 't') throw new EpochWriteConflict('cas_lost');
}

// ── Steps: what a transition leaves owed ────────────────────────────────────

function githubStatus(err: unknown): number | null {
  const m = /GitHub API error: (\d{3})/.exec(err instanceof Error ? err.message : String(err));
  return m ? Number(m[1]) : null;
}

const encodeRef = (ref: string): string => ref.split('/').map(encodeURIComponent).join('/');

async function defaultRepoOf(mission: MissionRow): Promise<MissionRepo | null> {
  const workspaceId = await (await hooks()).repoWorkspaceOf(mission.id, mission.workspaceId);
  if (!workspaceId) return null;
  const r = ((await dbExec(sql`-- workflow:mission_epoch_repo
SELECT w.id AS workspace_id, w.git_config, g.full_name, g.default_branch, i.installation_id
FROM workspaces w JOIN github_repos g ON g.id = w.github_repo_id JOIN github_installations i ON i.id = g.installation_id
WHERE w.id = ${workspaceId}::uuid`)).rows ?? [])[0] as Record<string, unknown> | undefined;
  if (!r?.full_name || r.installation_id == null) return null;
  const git = (r.git_config ?? {}) as { targetBranch?: string; defaultBranch?: string };
  return {
    workspaceId: String(r.workspace_id), installationId: Number(r.installation_id), repoFullName: String(r.full_name),
    trunk: git.targetBranch || git.defaultBranch || str(r.default_branch) || 'main',
  };
}

/** Is `sha` reachable from `head`? null when unreadable. */
async function isAncestor(api: GithubApi, repo: MissionRepo, sha: string, head: string): Promise<boolean | null> {
  try {
    const cmp = await api(repo.installationId, `/repos/${repo.repoFullName}/compare/${sha}...${head}`);
    return cmp?.status === 'ahead' || cmp?.status === 'identical' ? true : typeof cmp?.status === 'string' ? false : null;
  } catch { return null; }
}

/**
 * Is everything `headSha` carries already in `intoSha`'s tree? Ancestry first
 * (the common, cheap and exact answer). Then a test merge on a scratch ref of
 * this check's own (a squash-merged delivery leaves no ancestry, so only the
 * tree can prove it), read back only when GitHub's answer is the merge of
 * exactly `intoSha` and `headSha`:
 *  - a merge commit with those two parents whose tree equals `intoSha`'s: contained;
 *  - a different tree, or 409 (conflicts): not contained;
 *  - anything else is unknown (null), and an unknown never closes a PR. That
 *    includes GitHub's "nothing to merge" (204): ancestry already said no, so
 *    a 204 can only mean the scratch ref is not the ref this check cut.
 * The scratch ref is never shared: its name carries a random suffix, a name
 * already taken is unknown rather than reused, and it is deleted in the same step.
 */
export async function contentContained(api: GithubApi, repo: MissionRepo, headSha: string, intoSha: string, scratchPrefix: string, newId: () => string = () => crypto.randomUUID()): Promise<boolean | null> {
  const anc = await isAncestor(api, repo, headSha, intoSha);
  if (anc === true) return true;
  if (anc === null) return null;
  const scratch = `${scratchPrefix}-${newId().replace(/-/g, '').slice(0, 12)}`;
  const refPath = `/repos/${repo.repoFullName}/git/refs/heads/${encodeRef(scratch)}`;
  try {
    await api(repo.installationId, `/repos/${repo.repoFullName}/git/refs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: `refs/heads/${scratch}`, sha: intoSha }),
    });
  } catch {
    // Taken (or refused): never write onto a ref this check did not cut.
    return null;
  }
  try {
    let merged: any;
    try {
      merged = await api(repo.installationId, `/repos/${repo.repoFullName}/merges`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base: scratch, head: headSha, commit_message: 'buildd settlement probe (never pushed anywhere else)' }),
      });
    } catch (err) {
      return githubStatus(err) === 409 ? false : null;
    }
    if (!merged) return null;
    const parents = Array.isArray(merged?.parents) ? merged.parents.map((p: { sha?: string }) => p?.sha) : null;
    if (!parents || parents.length !== 2 || parents[0] !== intoSha || parents[1] !== headSha) return null;
    const probeTree = merged?.commit?.tree?.sha;
    const into = await api(repo.installationId, `/repos/${repo.repoFullName}/git/commits/${intoSha}`).catch(() => null);
    const intoTree = into?.tree?.sha;
    if (typeof probeTree !== 'string' || typeof intoTree !== 'string') return null;
    return probeTree === intoTree;
  } finally {
    await api(repo.installationId, refPath, { method: 'DELETE' }).catch(() => {});
  }
}

/**
 * S4b (workflow-kernel-library.md §1 "mission completion"): whether a reconcile pass recorded a
 * settlement or a retirement, the epoch transitions that can release a held completion
 * (`epochCompletionHold`). The kernel's own epoch path then asks the one completion writer to
 * decide, instead of waiting for the next task event or schedule tick to.
 */
export function epochStepsMayComplete(steps: ReconcileOutcome['steps']): boolean {
  return steps.some((s) => (s.step === 'settle' || s.step === 'retire') && /(^|:)applied(:|$)/.test(s.outcome));
}

export interface ReconcileOutcome {
  missionId: string;
  steps: Array<{ step: string; epoch: number; outcome: string }>;
}

/**
 * Perform every step the mission's epochs still owe, in order, recording each
 * through the reducer. Idempotent: a step already done reads as done.
 * Stops at the first step that cannot finish (it is retried by the next
 * caller); never throws for a GitHub outcome.
 */
export async function reconcileMissionEpochs(missionId: string, deps: EpochDeps = {}): Promise<ReconcileOutcome> {
  const out = await reconcileMissionEpochSteps(missionId, deps);
  // Task fbc93ebd: refresh PRs onto a finished open delivery (its PR closed and
  // superseded, or the mission closed). Never throws: the next pass retries.
  try {
    const finish = await settleFinishedDelivery(missionId, deps);
    if (finish) out.steps.push(finish);
  } catch (err) {
    console.error(`[mission-epochs] finished-branch settlement failed for ${missionId}:`, err);
  }
  // S4b: a settlement or retirement can release a held completion. Every reconcile says so (the
  // merge door's, ensureWritableEpoch's, the hourly one), and the missions module decides.
  if (epochStepsMayComplete(out.steps)) {
    await (deps.settled ?? emitDeliverySettled)(missionId, out.steps)
      .catch((err) => console.error(`[mission-epochs] delivery-settled signal failed for ${missionId}:`, err));
  }
  return out;
}

/** The default `settled` signal: the core event the missions module's completion writer hears. */
async function emitDeliverySettled(missionId: string, steps: ReconcileOutcome['steps']): Promise<void> {
  const { emit } = await import('@/lib/core-emit');
  await emit({ type: 'mission.delivery_settled', missionId, steps: steps.map((s) => `${s.step}#${s.epoch}`) });
}

async function reconcileMissionEpochSteps(missionId: string, deps: EpochDeps): Promise<ReconcileOutcome> {
  const api: GithubApi = deps.api ?? (await import('@/lib/github')).githubApi;
  const nowDate = () => (deps.now ?? (() => new Date()))();
  const now = () => nowDate().toISOString();
  const out: ReconcileOutcome = { missionId, steps: [] };
  let loaded = await loadMissionEpochView(missionId, deps);
  if (!loaded || !loaded.view.integrationBranch && loaded.view.epochs.length === 0) return out;
  const repo = await (deps.repoOf ?? defaultRepoOf)(loaded.mission);
  if (!repo) return out;

  // A mission with no delivery rows yet (a merge whose record failed, or one
  // that predates delivery records): adopt it here, so the backstop retries
  // what the door could not. A mission PR that merged within the catch-up
  // window is the merge being recorded now, not a past delivery.
  if (loaded.view.epochs.length === 0) {
    const facts = await adoptionFacts(api, repo, loaded.view, nowDate());
    const r = await applyMissionEpochCommand(missionId, {
      type: 'Adopt', actor: 'kernel:mission_epochs_reconcile', at: now(), mergingPr: facts.mergingPr, liveBranchAhead: facts.liveBranchAhead,
    }, deps);
    out.steps.push({ step: 'adopt', epoch: 0, outcome: `${r.result}:${r.reason}${facts.mergingPr != null ? ':merging' : ''}${facts.liveBranchAhead ? ':branch_ahead' : ''}` });
    loaded = await loadMissionEpochView(missionId, deps);
    if (!loaded || loaded.view.epochs.length === 0) return out;
  }

  // A merge no door recorded (a lost webhook): the open delivery's PR, read live.
  const open = writableEpoch(loaded.view);
  if (open?.prNumber != null) {
    const pr = await api(repo.installationId, `/repos/${repo.repoFullName}/pulls/${open.prNumber}`).catch(() => null);
    if (pr?.merged === true) {
      const r = await applyMissionEpochCommand(missionId, {
        type: 'Merged', actor: 'kernel:mission_epochs_reconcile', at: now(), prNumber: open.prNumber, repoFullName: repo.repoFullName,
        headRef: str(pr?.head?.ref), mergeCommitSha: str(pr?.merge_commit_sha), mergedHeadSha: str(pr?.head?.sha),
        mergedAt: str(pr?.merged_at) ?? now(),
      }, deps);
      out.steps.push({ step: 'catch_up_merge', epoch: open.epoch, outcome: `${r.result}:${r.reason}` });
    }
  }

  // Each epoch's steps are independent: one that cannot finish (held, unreadable,
  // in flight elsewhere) blocks only its own later steps, never another epoch's.
  const blocked = new Set<string>();
  for (let guard = 0; guard < 16; guard++) {
    const current = await loadMissionEpochView(missionId, deps);
    if (!current) return out;
    const step = pendingEpochSteps(current.view).find((s) => !blocked.has(s.epochId));
    if (!step) return out;
    const epoch = current.view.epochs.find((e) => e.id === step.epochId)!;
    const stop = (outcome: string) => { out.steps.push({ step: step.step, epoch: epoch.epoch, outcome }); blocked.add(epoch.id); };
    const record = async (cmd: MissionEpochCommand, label: string) => {
      const r = await applyMissionEpochCommand(missionId, cmd, deps);
      out.steps.push({ step: step.step, epoch: epoch.epoch, outcome: `${label}:${r.result}:${r.reason}` });
      return r;
    };

    if (step.step === 'cut_branch') {
      const ready = await cutBranch(api, repo, step.branch, step.fromSha);
      if (!ready) { stop('failed'); continue; }
      await record({ type: 'BranchReady', actor: 'kernel:mission_epochs', at: now(), epochId: step.epochId }, ready);
      continue;
    }

    if (step.step === 'settle') {
      // One settlement of a branch at a time: two callers reading and acting on
      // the same PRs is how a probe and a close interleave.
      const token = crypto.randomUUID();
      const lease = ((await (deps.exec ?? dbExec)(settleLeaseSql(epoch.id, token, SETTLE_LEASE_MS))).rows ?? [])[0];
      if (!lease) { stop('in_flight'); continue; }
      try {
        const fresh = (await loadMissionEpochView(missionId, deps))?.view.epochs.find((e) => e.id === epoch.id) ?? epoch;
        const settlement = await settle(api, repo, current.view, fresh, step.successorBranch, deps);
        if (!settlement) { stop('unreadable'); continue; }
        // A branch kept for unshipped commits stays kept until a fresh read says otherwise.
        if (fresh.settlement?.unshippedHead) {
          const u = await unshippedHeadOf(api, repo, fresh.branch, fresh.mergedHeadSha);
          if (u === undefined) { stop('unreadable'); continue; }
          if (u) settlement.unshippedHead = u;
        }
        const r = await record({ type: 'Settled', actor: 'kernel:mission_epochs', at: now(), epochId: epoch.id, settlement }, 'settled');
        if (settlement.held.length > 0 && r.result === 'applied') await noteHeld(missionId, fresh, settlement, deps);
        if (settlement.held.length > 0 || settlement.unshippedHead) blocked.add(epoch.id);
      } finally {
        await (deps.exec ?? dbExec)(settleReleaseSql(epoch.id, token)).catch(() => {});
      }
      continue;
    }

    // retire: only once nothing open is still based on the branch, read fresh.
    const stillOpen = await openPrsOn(api, repo, step.branch);
    if (stillOpen === null) { stop('unreadable'); continue; }
    if (stillOpen.length > 0) {
      // Something reached the branch after settlement: it is settled again on its own read.
      await record({ type: 'Settled', actor: 'kernel:mission_epochs', at: now(), epochId: epoch.id, settlement: {
        settled: epoch.settlement?.settled ?? [], held: stillOpen.map((n) => ({ prNumber: n, kind: 'task' as const, disposition: 'hold' as const, reason: 'opened on this branch after it merged', proof: { headSha: null, mergeCommitSha: epoch.mergeCommitSha, contained: null } })),
        satisfiedByPr: epoch.prNumber,
      } }, 'reheld');
      continue;
    }
    // The last check before a delete: the branch must sit at the head that
    // merged, or be wholly in trunk. Anything else is work that never shipped;
    // the branch is kept and a person is asked, whatever settlement concluded.
    const unshipped = await unshippedHeadOf(api, repo, step.branch, epoch.mergedHeadSha);
    if (unshipped === undefined) { stop('unreadable'); continue; }
    if (unshipped) {
      const settlement = { ...(epoch.settlement ?? { settled: [], held: [], satisfiedByPr: epoch.prNumber }), unshippedHead: unshipped };
      const r = await record({ type: 'Settled', actor: 'kernel:mission_epochs', at: now(), epochId: epoch.id, settlement }, 'branch_kept');
      if (r.result === 'applied') await noteUnshipped(missionId, epoch, unshipped, deps);
      blocked.add(epoch.id);
      continue;
    }
    try {
      await api(repo.installationId, `/repos/${repo.repoFullName}/git/refs/heads/${encodeRef(step.branch)}`, { method: 'DELETE' });
    } catch (err) {
      const s = githubStatus(err);
      // 404 / 422: GitHub already deleted it (delete-branch-on-merge). The post-condition holds.
      if (s !== 404 && s !== 422) { stop(`failed:${s ?? 'error'}`); continue; }
    }
    await record({ type: 'Retired', actor: 'kernel:mission_epochs', at: now(), epochId: epoch.id }, 'retired');
  }
  return out;
}

/**
 * What adoption may assume about a mission with no delivery rows. A recorded
 * mission PR that merged within `MERGE_CATCH_UP_MS` is the merge whose record
 * failed ("merging now": rotate and settle it) only when the branch is gone or
 * still sits exactly at the head that merged. A branch that moved on carries
 * work after that merge: it is the live delivery (an adopted re-cut), and it
 * is never settled or deleted as the merged one.
 */
export async function adoptionFacts(api: GithubApi, repo: MissionRepo, view: MissionEpochView, now: Date): Promise<{ mergingPr: number | null; liveBranchAhead: boolean }> {
  const legacy = view.legacyPr ?? null;
  const branch = view.integrationBranch;
  if (!branch || legacy?.state !== 'merged' || legacy.prNumber == null) return { mergingPr: null, liveBranchAhead: false };
  const head = await api(repo.installationId, `/repos/${repo.repoFullName}/git/ref/heads/${encodeRef(branch)}`)
    .then((r) => ({ sha: str(r?.object?.sha), gone: false }), (err) => ({ sha: null, gone: githubStatus(err) === 404 }));
  const recent = legacy.mergedAt != null && now.getTime() - Date.parse(legacy.mergedAt) < MERGE_CATCH_UP_MS;
  if (head.gone) return { mergingPr: recent ? legacy.prNumber : null, liveBranchAhead: false };
  if (!head.sha) return { mergingPr: null, liveBranchAhead: true }; // unreadable: keep the branch live, never retire it
  const pr = await api(repo.installationId, `/repos/${repo.repoFullName}/pulls/${legacy.prNumber}`).catch(() => null);
  const mergedHead = str(pr?.head?.sha);
  if (mergedHead && mergedHead === head.sha) return { mergingPr: recent ? legacy.prNumber : null, liveBranchAhead: false };
  const trunkHead = await api(repo.installationId, `/repos/${repo.repoFullName}/git/ref/heads/${encodeRef(repo.trunk)}`).then((r) => str(r?.object?.sha)).catch(() => null);
  const inTrunk = trunkHead ? await isAncestor(api, repo, head.sha, trunkHead) : null;
  return { mergingPr: null, liveBranchAhead: inTrunk !== true };
}

/**
 * `adoptionFacts` for a loaded mission, resolving its repo and the GitHub
 * client. Unresolvable or unreadable reads keep the branch live (never fold it
 * into a merged record), the direction that can only hold, never lose work.
 */
async function adoptionFactsFor(loaded: { view: MissionEpochView; mission: MissionRow }, deps: EpochDeps): Promise<{ mergingPr: number | null; liveBranchAhead: boolean }> {
  if (loaded.view.legacyPr?.state !== 'merged') return { mergingPr: null, liveBranchAhead: false };
  try {
    const repo = await (deps.repoOf ?? defaultRepoOf)(loaded.mission);
    if (!repo) return { mergingPr: null, liveBranchAhead: true };
    const api: GithubApi = deps.api ?? (await import('@/lib/github')).githubApi;
    return await adoptionFacts(api, repo, loaded.view, (deps.now ?? (() => new Date()))());
  } catch {
    return { mergingPr: null, liveBranchAhead: true };
  }
}

/** A merged mission PR with no delivery record this recent is the merge whose record failed. */
export const MERGE_CATCH_UP_MS = 48 * 60 * 60 * 1000;
/** How long one caller may hold a branch's settlement. */
export const SETTLE_LEASE_MS = 5 * 60 * 1000;

export function settleLeaseSql(epochId: string, token: string, ms: number): SQL {
  return sql`-- workflow:mission_epoch_settle_lease
UPDATE workflow_mission_epochs SET settle_lease_token = ${token}::text, settle_lease_until = now() + (${ms}::int * interval '1 millisecond')
WHERE id = ${epochId}::uuid AND (settle_lease_until IS NULL OR settle_lease_until < now())
RETURNING id`;
}

export function settleReleaseSql(epochId: string, token: string): SQL {
  return sql`-- workflow:mission_epoch_settle_release
UPDATE workflow_mission_epochs SET settle_lease_token = NULL, settle_lease_until = NULL
WHERE id = ${epochId}::uuid AND settle_lease_token = ${token}::text`;
}

/**
 * Create the successor's branch at `fromSha`, or accept one already there only
 * if it starts from that commit (a stray branch under the name is not ours).
 */
/**
 * The branch's live head when it carries commits trunk lacks; null when it is
 * gone, at `mergedHead`, or contained in trunk; undefined when unreadable.
 */
async function unshippedHeadOf(api: GithubApi, repo: MissionRepo, branch: string, mergedHead: string | null): Promise<string | null | undefined> {
  let head: string | null;
  try {
    head = str((await api(repo.installationId, `/repos/${repo.repoFullName}/git/ref/heads/${encodeRef(branch)}`))?.object?.sha);
  } catch (err) {
    return githubStatus(err) === 404 ? null : undefined;
  }
  if (!head) return undefined;
  if (mergedHead && head === mergedHead) return null;
  let trunkHead: string | null;
  try {
    trunkHead = str((await api(repo.installationId, `/repos/${repo.repoFullName}/git/ref/heads/${encodeRef(repo.trunk)}`))?.object?.sha);
  } catch { return undefined; }
  if (!trunkHead) return undefined;
  const inTrunk = await isAncestor(api, repo, head, trunkHead);
  if (inTrunk === null) return undefined;
  return inTrunk ? null : head;
}

async function noteUnshipped(missionId: string, epoch: EpochSnapshot, head: string, deps: EpochDeps): Promise<void> {
  const title = `Delivery ${epoch.epoch}'s branch has commits that never reached trunk`;
  const body = [
    `Delivery ${epoch.epoch} merged${epoch.prNumber ? ` (#${epoch.prNumber})` : ''}, but its branch \`${epoch.branch}\` has moved on to ${head.slice(0, 7)}, which trunk does not contain.`,
    '',
    'buildd keeps the branch and will not delete it. Open a PR from it into the current delivery to ship that work, or delete the branch yourself if it does not matter.',
  ].join('\n');
  try {
    await (deps.noteHeld ?? defaultNoteHeld)(missionId, title, body);
  } catch (err) {
    console.warn('[delivery-epochs] unshipped-branch note not posted:', err instanceof Error ? err.message : err);
  }
}

async function cutBranch(api: GithubApi, repo: MissionRepo, branch: string, fromSha: string | null): Promise<string | null> {
  const found = async (): Promise<string | null> => {
    const ref = await api(repo.installationId, `/repos/${repo.repoFullName}/git/ref/heads/${encodeRef(branch)}`);
    const sha = str(ref?.object?.sha);
    if (!fromSha || !sha) return sha ? 'found' : null;
    return sha === fromSha || (await isAncestor(api, repo, fromSha, sha)) === true ? 'found' : null;
  };
  try {
    return await found();
  } catch (err) {
    if (githubStatus(err) !== 404) return null;
  }
  if (!fromSha) return null;
  try {
    await api(repo.installationId, `/repos/${repo.repoFullName}/git/refs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: fromSha }),
    });
    return 'created';
  } catch (err) {
    if (githubStatus(err) === 422 && /reference already exists/i.test(err instanceof Error ? err.message : String(err))) {
      return found().catch(() => null);
    }
    return null;
  }
}

async function openPrsOn(api: GithubApi, repo: MissionRepo, base: string): Promise<number[] | null> {
  try {
    const prs = await api(repo.installationId, `/repos/${repo.repoFullName}/pulls?state=open&base=${encodeURIComponent(base)}&per_page=100`);
    return Array.isArray(prs) ? prs.map((p: { number: number }) => p.number).filter((n: unknown) => typeof n === 'number') : null;
  } catch { return null; }
}

/**
 * Settle the PRs a merged epoch left behind: the ones still based on its
 * branch, and the mission's task PRs GitHub moved to trunk when it deleted
 * that branch. Each is classified by the package's rule against a fresh
 * read, then acted on: closed as redundant (with the epoch PR recorded on its
 * delivery), retargeted to the successor, or held. Null when the open-PR
 * list itself could not be read (nothing is decided on a partial read).
 */
async function settle(api: GithubApi, repo: MissionRepo, view: MissionEpochView, epoch: EpochSnapshot, successorBranch: string | null, deps: EpochDeps): Promise<EpochSettlement | null> {
  const onBranch = await (async () => {
    try {
      const prs = await api(repo.installationId, `/repos/${repo.repoFullName}/pulls?state=open&base=${encodeURIComponent(epoch.branch)}&per_page=100`);
      return Array.isArray(prs) ? prs as Array<{ number: number; head?: { sha?: string }; base?: { ref?: string } }> : null;
    } catch { return null; }
  })();
  if (onBranch === null) return null;
  const refreshPrs = await (deps.refreshPrsOf ?? defaultRefreshPrsOf)(view.missionId, repo.repoFullName);
  const candidates: Array<{ prNumber: number; headSha: string | null; baseRef: string; refresh: boolean }> = onBranch
    .filter((p) => p.number !== epoch.prNumber)
    .map((p) => ({ prNumber: p.number, headSha: p.head?.sha ?? null, baseRef: p.base?.ref ?? epoch.branch, refresh: refreshPrs.has(p.number) }));

  // GitHub retargets the open PRs of a branch it deletes on merge to that PR's
  // base (trunk). Only the ones recorded as moved off THIS branch (the retarget
  // webhook's `from`) are touched: a PR that was always on trunk never is.
  // Fallback for a lost retarget webhook: a mission PR buildd still records as
  // based on this branch, whose live base is now trunk, was moved off it too.
  const recordedOnBranch = await (deps.recordedOnBranchOf ?? defaultRecordedOnBranchOf)(view.missionId, repo.repoFullName, epoch.branch);
  for (const n of [...new Set([...(epoch.movedPrs ?? []), ...recordedOnBranch])]) {
    if (n === epoch.prNumber || candidates.some((c) => c.prNumber === n)) continue;
    let pr: any;
    try { pr = await api(repo.installationId, `/repos/${repo.repoFullName}/pulls/${n}`); } catch { return null; }
    if (pr?.state === 'open' && pr?.base?.ref === repo.trunk) {
      candidates.push({ prNumber: n, headSha: pr?.head?.sha ?? null, baseRef: repo.trunk, refresh: refreshPrs.has(n) });
    }
  }

  const into = epoch.mergeCommitSha;
  const classified: SettlementCandidate[] = [];
  for (const c of candidates) {
    const contained = c.headSha && into
      ? await contentContained(api, repo, c.headSha, into, `buildd-settle/${epoch.id.slice(0, 8)}-${c.prNumber}`, deps.newId)
      : null;
    classified.push({ prNumber: c.prNumber, kind: c.refresh ? 'refresh' : 'task', baseRef: c.baseRef, headSha: c.headSha, contained });
  }
  const decided = classifySettlement(classified, { mergeCommitSha: into, successorBranch });

  const settled: SettledPr[] = [];
  const held: SettledPr[] = [];
  const epochUrl = epoch.prNumber ? `https://github.com/${repo.repoFullName}/pull/${epoch.prNumber}` : null;
  for (const d of decided) {
    if (d.disposition === 'hold') { held.push(d); continue; }
    try {
      if (d.disposition === 'retarget') {
        await api(repo.installationId, `/repos/${repo.repoFullName}/pulls/${d.prNumber}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base: d.target }),
        });
      } else {
        // The content check read one head: a push since then is unchecked work, so it is not closed.
        const live = await api(repo.installationId, `/repos/${repo.repoFullName}/pulls/${d.prNumber}`).catch(() => null);
        if (live?.state !== 'open' || str(live?.head?.sha) !== d.proof.headSha) {
          held.push({ ...d, disposition: 'hold', reason: live?.state === 'open' ? 'it moved since it was checked; checked again on the next pass' : 'could not re-read it before closing' });
          continue;
        }
        await api(repo.installationId, `/repos/${repo.repoFullName}/issues/${d.prNumber}/comments`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: `Closing: every change on this PR already reached \`${repo.trunk}\` with delivery ${epoch.epoch} of this mission${epoch.prNumber ? ` (#${epoch.prNumber})` : ''}. Checked against \`${(into ?? '').slice(0, 7)}\`.` }),
        }).catch(() => {});
        await api(repo.installationId, `/repos/${repo.repoFullName}/pulls/${d.prNumber}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: 'closed' }),
        });
        if (epoch.prNumber) {
          await (deps.recordSupersession ?? defaultRecordSupersession)({
            workspaceId: repo.workspaceId, repoFullName: repo.repoFullName, prNumber: d.prNumber, installationId: repo.installationId,
            satisfiedBy: { prNumber: epoch.prNumber, url: epochUrl }, reason: d.reason,
          }).catch((err) => console.warn(`[delivery-epochs] supersession of #${d.prNumber} not recorded:`, err instanceof Error ? err.message : err));
        }
      }
      settled.push(d);
    } catch (err) {
      // A partial GitHub failure: keep the branch and try again on the next pass.
      held.push({ ...d, disposition: 'hold', reason: `GitHub refused (${githubStatus(err) ?? 'error'}); retried on the next pass` });
    }
  }
  // A refresh filed for this branch that never started has nothing left to do.
  for (const taskId of await (deps.obsoleteRefreshTasksOf ?? defaultObsoleteRefreshTasksOf)(view.missionId, epoch.branch)) {
    await (deps.cancelTask ?? defaultCancelTask)(taskId, `delivery ${epoch.epoch} merged; the branch this refresh was for is retired`)
      .catch((err) => console.warn(`[delivery-epochs] obsolete refresh ${taskId} not cancelled:`, err instanceof Error ? err.message : err));
  }

  // Previously settled entries stay on the record.
  const prior = (epoch.settlement?.settled ?? []).filter((p) => !settled.some((s) => s.prNumber === p.prNumber));
  return { settled: [...prior, ...settled], held, satisfiedByPr: epoch.prNumber };
}

async function defaultRefreshPrsOf(missionId: string, repoFullName: string): Promise<Set<number>> {
  const rows = ((await dbExec(sql`-- workflow:mission_refresh_prs
SELECT DISTINCT w.pr_number FROM tasks t JOIN workers w ON w.task_id = t.id
WHERE t.mission_id = ${missionId}::uuid AND w.pr_number IS NOT NULL AND (t.context->>'requireMergeCommit')::boolean IS TRUE
  AND lower(w.pr_url) LIKE ${`https://github.com/${repoFullName.toLowerCase()}/pull/%`}::text`)).rows ?? []) as Array<{ pr_number: unknown }>;
  return new Set(rows.map((r) => Number(r.pr_number)));
}

async function defaultRecordedOnBranchOf(missionId: string, repoFullName: string, branch: string): Promise<number[]> {
  const rows = ((await dbExec(sql`-- workflow:mission_prs_recorded_on_branch
SELECT DISTINCT w.pr_number FROM tasks t JOIN workers w ON w.task_id = t.id
WHERE t.mission_id = ${missionId}::uuid AND w.pr_number IS NOT NULL AND w.merged_at IS NULL
  AND COALESCE(w.pr_lifecycle_status, '') NOT IN ('closed', 'merged', 'unresolvable')
  AND w.pr_base_ref = ${branch}::text
  AND lower(w.pr_url) LIKE ${`https://github.com/${repoFullName.toLowerCase()}/pull/%`}::text`)).rows ?? []) as Array<{ pr_number: unknown }>;
  return rows.map((r) => Number(r.pr_number));
}

async function defaultObsoleteRefreshTasksOf(missionId: string, branch: string): Promise<string[]> {
  const rows = ((await dbExec(sql`-- workflow:mission_obsolete_refreshes
SELECT t.id FROM tasks t
WHERE t.mission_id = ${missionId}::uuid AND t.status = 'pending'
  AND (t.context->>'requireMergeCommit')::boolean IS TRUE AND t.context->>'baseBranch' = ${branch}::text
  AND NOT EXISTS (SELECT 1 FROM workers w WHERE w.task_id = t.id)`)).rows ?? []) as Array<{ id: unknown }>;
  return rows.map((r) => String(r.id));
}

/**
 * The writable delivery's finished-branch settlement (task fbc93ebd), the
 * step a reconcile adds after the epoch steps. Null when the mission has no
 * open delivery or no repo to read.
 */
async function settleFinishedDelivery(missionId: string, deps: EpochDeps): Promise<ReconcileOutcome['steps'][number] | null> {
  const loaded = await loadMissionEpochView(missionId, deps);
  const open = loaded ? writableEpoch(loaded.view) : null;
  if (!loaded || !open) return null;
  const repo = await (deps.repoOf ?? defaultRepoOf)(loaded.mission);
  if (!repo) return null;
  const api: GithubApi = deps.api ?? (await import('@/lib/github')).githubApi;
  const r = await settleFinishedBranch(api, repo, loaded.view, open, deps);
  return { step: 'finish', epoch: open.epoch, outcome: r.outcome };
}

/**
 * Close the refresh PRs left on a finished delivery branch
 * (`deliveryBranchFinished`), and settle their tasks: a closed refresh is
 * recorded as superseded by the merged PR that carries the branch's work when
 * one is known (otherwise one mission note asks a person where to record it),
 * and a refresh filed for the branch that never started is cancelled.
 *
 * Reads only as far as it needs: an open or merged delivery PR stops at one
 * read, and a finished-ness check (including a content probe) runs only when
 * there is something to settle. Task PRs on the branch are never touched here.
 * Idempotent: a closed refresh PR is no longer listed, so a replay does nothing.
 */
export async function settleFinishedBranch(
  api: GithubApi, repo: MissionRepo, view: MissionEpochView, epoch: EpochSnapshot, deps: EpochDeps = {},
): Promise<{ outcome: string; closed: number[] }> {
  const facts: Partial<BranchFinishFacts> = {};
  if (!view.terminal) {
    if (epoch.prNumber == null) return { outcome: 'skip:no_delivery_pr', closed: [] };
    const pr = await api(repo.installationId, `/repos/${repo.repoFullName}/pulls/${epoch.prNumber}`).catch(() => null);
    if (!pr) return { outcome: 'unreadable', closed: [] };
    if (pr.merged === true || pr.state !== 'closed') return { outcome: 'skip:delivery_pr_live', closed: [] };
    facts.prClosedUnmerged = true;
  }

  const onBranch = await (async () => {
    try {
      const prs = await api(repo.installationId, `/repos/${repo.repoFullName}/pulls?state=open&base=${encodeURIComponent(epoch.branch)}&per_page=100`);
      return Array.isArray(prs) ? prs as Array<{ number: number; head?: { sha?: string } }> : null;
    } catch { return null; }
  })();
  if (onBranch === null) return { outcome: 'unreadable', closed: [] };
  const refreshPrs = await (deps.refreshPrsOf ?? defaultRefreshPrsOf)(view.missionId, repo.repoFullName);
  const refreshes = onBranch.filter((p) => refreshPrs.has(p.number));
  const unstarted = await (deps.obsoleteRefreshTasksOf ?? defaultObsoleteRefreshTasksOf)(view.missionId, epoch.branch);
  // Refreshes already closed on this branch whose task is not settled yet (a close whose
  // record failed, or one closed by hand): rediscovered from the rows, so a lost record is redone.
  const closedUnsettled = (await (deps.unsettledClosedRefreshesOf ?? defaultUnsettledClosedRefreshesOf)(view.missionId, repo.repoFullName, epoch.branch))
    .filter((n) => !refreshes.some((p) => p.number === n));
  if (refreshes.length === 0 && unstarted.length === 0 && closedUnsettled.length === 0) return { outcome: 'skip:nothing_to_settle', closed: [] };

  if (!view.terminal && epoch.prNumber != null) {
    const owner = repo.repoFullName.split('/')[0];
    const successors = await api(repo.installationId,
      `/repos/${repo.repoFullName}/pulls?state=open&head=${encodeURIComponent(`${owner}:${epoch.branch}`)}&base=${encodeURIComponent(repo.trunk)}&per_page=100`)
      .catch(() => null);
    if (!Array.isArray(successors)) return { outcome: 'unreadable', closed: [] };
    facts.successorOpen = successors.some((p: { number?: number }) => p?.number !== epoch.prNumber);
    if (!facts.successorOpen) {
      const by = await (deps.supersessionOf ?? defaultSupersessionOf)(repo.repoFullName, epoch.prNumber);
      facts.supersededBy = by?.prNumber ?? null;
      if (facts.supersededBy == null) {
        const head = await api(repo.installationId, `/repos/${repo.repoFullName}/git/ref/heads/${encodeRef(epoch.branch)}`).then((r) => str(r?.object?.sha)).catch(() => null);
        const trunkHead = await api(repo.installationId, `/repos/${repo.repoFullName}/git/ref/heads/${encodeRef(repo.trunk)}`).then((r) => str(r?.object?.sha)).catch(() => null);
        facts.containedInTrunk = head && trunkHead
          ? await contentContained(api, repo, head, trunkHead, `buildd-settle/${epoch.id.slice(0, 8)}-finished`, deps.newId)
          : null;
      }
    }
  }

  const finished = deliveryBranchFinished(view, epoch, facts);
  if (!finished.finished) return { outcome: `not_finished:${finished.reason}`, closed: [] };
  const why = finishedBranchWhy(finished, { prNumber: epoch.prNumber, trunk: repo.trunk });

  const closed: number[] = [];
  let skipped = 0;
  for (const p of refreshes) {
    try {
      // A push since the list was read is unread work: left for the next pass.
      const live = await api(repo.installationId, `/repos/${repo.repoFullName}/pulls/${p.number}`).catch(() => null);
      if (live?.state !== 'open' || str(live?.head?.sha) !== str(p.head?.sha)) { skipped++; continue; }
      await api(repo.installationId, `/repos/${repo.repoFullName}/issues/${p.number}/comments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: `Closing: this PR refreshes \`${epoch.branch}\`, and that branch is finished: ${why}. Nothing from it will reach \`${repo.trunk}\` any more, so this refresh has nothing left to do.` }),
      }).catch(() => {});
      await api(repo.installationId, `/repos/${repo.repoFullName}/pulls/${p.number}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: 'closed' }),
      });
      closed.push(p.number);
    } catch (err) {
      skipped++;
      console.warn(`[delivery-epochs] refresh #${p.number} on finished ${epoch.branch} not closed:`, err instanceof Error ? err.message : err);
    }
  }
  for (const taskId of unstarted) {
    await (deps.cancelTask ?? defaultCancelTask)(taskId, `the branch this refresh was for is finished: ${why}`)
      .catch((err) => console.warn(`[delivery-epochs] refresh ${taskId} on a finished branch not cancelled:`, err instanceof Error ? err.message : err));
  }
  // Settle every closed refresh on the branch, the ones closed now and the ones a
  // previous pass closed but could not record. Each step is idempotent, so a retry is safe.
  const toSettle = [...closed, ...closedUnsettled];
  let recorded = 0;
  if (finished.satisfiedByPr != null) {
    for (const n of toSettle) {
      try {
        await (deps.recordSupersession ?? defaultRecordSupersession)({
          workspaceId: repo.workspaceId, repoFullName: repo.repoFullName, prNumber: n, installationId: repo.installationId,
          satisfiedBy: { prNumber: finished.satisfiedByPr, url: `https://github.com/${repo.repoFullName}/pull/${finished.satisfiedByPr}` },
          reason: `the branch it refreshed is finished: ${why}`,
        });
        recorded++;
      } catch (err) {
        console.warn(`[delivery-epochs] supersession of refresh #${n} not recorded; retried next pass:`, err instanceof Error ? err.message : err);
      }
    }
  } else if (toSettle.length > 0 && !view.terminal) {
    // No merged PR to record them against, on a mission still open: a person says
    // where their work went. One note per delivery, ever: a failed post is retried
    // on the next pass (the PRs stay unsettled), and a note a person closed is not reposted.
    const prs = toSettle.map((n) => `#${n}`).join(', ');
    const title = `Delivery ${epoch.epoch}'s branch is finished; its refresh PRs are closed`;
    const body = [
      `\`${epoch.branch}\` is finished: ${why}. Nothing from it will reach \`${repo.trunk}\` any more, so buildd closed the refresh PRs on it (${prs}).`,
      '',
      'No merged PR is recorded as carrying this work, so buildd cannot record where it landed. Record the PR that carried it, or mark the closed PRs dropped, so the mission stops counting them as unmerged.',
    ].join('\n');
    await (deps.noteOnce ?? defaultNoteOnce)(view.missionId, title, body)
      .catch((err) => console.warn('[delivery-epochs] finished-branch note not posted; retried next pass:', err instanceof Error ? err.message : err));
  }
  return {
    outcome: `finished:${finished.reason}:closed=${closed.length}:cancelled=${unstarted.length}`
      + `${closedUnsettled.length ? `:resettled=${closedUnsettled.length}` : ''}${finished.satisfiedByPr != null ? `:recorded=${recorded}` : ''}${skipped ? `:skipped=${skipped}` : ''}`,
    closed,
  };
}

/** Closed, unmerged refresh PRs of the mission on `branch` with no resolution recorded yet. */
async function defaultUnsettledClosedRefreshesOf(missionId: string, repoFullName: string, branch: string): Promise<number[]> {
  const rows = ((await dbExec(sql`-- workflow:mission_unsettled_closed_refreshes
SELECT DISTINCT w.pr_number FROM tasks t JOIN workers w ON w.task_id = t.id
WHERE t.mission_id = ${missionId}::uuid AND (t.context->>'requireMergeCommit')::boolean IS TRUE
  AND w.pr_number IS NOT NULL AND w.merged_at IS NULL AND w.pr_lifecycle_status = 'closed'
  AND w.superseded_by_pr_number IS NULL AND w.abandoned_at IS NULL
  AND w.pr_base_ref = ${branch}::text
  AND lower(w.pr_url) LIKE ${`https://github.com/${repoFullName.toLowerCase()}/pull/%`}::text`)).rows ?? []) as Array<{ pr_number: unknown }>;
  return rows.map((r) => Number(r.pr_number));
}

/** A mission note posted at most once per title, whatever became of an earlier one. */
async function defaultNoteOnce(missionId: string, title: string, body: string): Promise<void> {
  await dbExec(sql`-- workflow:mission_epoch_note_once
INSERT INTO mission_notes (mission_id, author_type, type, title, body, status)
SELECT ${missionId}::uuid, 'system', 'warning', ${title}::text, ${body}::text, 'open'
WHERE NOT EXISTS (SELECT 1 FROM mission_notes WHERE mission_id = ${missionId}::uuid AND title = ${title}::text)`);
}

async function defaultSupersessionOf(repoFullName: string, prNumber: number): Promise<{ prNumber: number; url: string | null } | null> {
  const r = ((await dbExec(sql`-- workflow:pr_supersession_edge
SELECT superseded_by_pr_number, superseded_by_pr_url FROM workers
WHERE pr_number = ${prNumber}::int AND superseded_by_pr_number IS NOT NULL
  AND lower(pr_url) LIKE ${`https://github.com/${repoFullName.toLowerCase()}/pull/%`}::text
ORDER BY superseded_at DESC NULLS LAST LIMIT 1`)).rows ?? [])[0] as Record<string, unknown> | undefined;
  return r ? { prNumber: Number(r.superseded_by_pr_number), url: str(r.superseded_by_pr_url) } : null;
}

async function defaultCancelTask(taskId: string, reason: string): Promise<void> {
  const { workflowKernel } = await import('./kernel-ports');
  const work = (await workflowKernel()).ports.work;
  if (!work) throw new Error('the kernel has no Work port');
  await work.cancel(taskId, reason);
}

async function defaultRecordSupersession(p: Parameters<NonNullable<EpochDeps['recordSupersession']>>[0]): Promise<void> {
  const { recordSupersession } = await import('./seam');
  await recordSupersession({
    workspaceId: p.workspaceId, repoFullName: p.repoFullName, prNumber: p.prNumber, installationId: p.installationId,
    actor: 'kernel:mission_epochs', reason: p.reason,
    target: { repoFullName: p.repoFullName, prNumber: p.satisfiedBy.prNumber, url: p.satisfiedBy.url },
  });
}

async function noteHeld(missionId: string, epoch: EpochSnapshot, s: EpochSettlement, deps: EpochDeps): Promise<void> {
  const prs = s.held.map((p) => `#${p.prNumber}`).join(', ');
  const title = `Delivery ${epoch.epoch} shipped; ${s.held.length === 1 ? `${prs} still needs a decision` : `${prs} still need a decision`}`;
  const body = [
    `Delivery ${epoch.epoch} of this mission merged${epoch.prNumber ? ` (#${epoch.prNumber})` : ''}. Its branch \`${epoch.branch}\` is kept until these are settled:`,
    '',
    ...s.held.map((p) => `- #${p.prNumber}: ${p.reason}.`),
    '',
    'Close a PR whose changes no longer matter, or move it onto the current delivery. buildd retires the branch once nothing is left on it, and never sends these to trunk on its own.',
  ].join('\n');
  try {
    await (deps.noteHeld ?? defaultNoteHeld)(missionId, title, body);
  } catch (err) {
    console.warn('[delivery-epochs] held note not posted:', err instanceof Error ? err.message : err);
  }
}

async function defaultNoteHeld(missionId: string, title: string, body: string): Promise<void> {
  await dbExec(sql`-- workflow:mission_epoch_note
INSERT INTO mission_notes (mission_id, author_type, type, title, body, status)
SELECT ${missionId}::uuid, 'system', 'warning', ${title}::text, ${body}::text, 'open'
WHERE NOT EXISTS (SELECT 1 FROM mission_notes WHERE mission_id = ${missionId}::uuid AND title = ${title}::text AND status = 'open')`);
}

// ── Door operations ─────────────────────────────────────────────────────────

export interface EpochMergedInput {
  missionId: string;
  prNumber: number;
  repoFullName: string;
  headRef: string | null;
  mergeCommitSha: string | null;
  mergedHeadSha: string | null;
  mergedAt: string;
  actor: string;
}

/** An epoch's PR merged: record it (rotating when work remains), then do what it leaves owed. */
export async function epochMerged(p: EpochMergedInput, deps: EpochDeps = {}): Promise<{ result: EpochResult['result']; reason: string; reconcile: ReconcileOutcome }> {
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const r = await applyMissionEpochCommand(p.missionId, {
    type: 'Merged', actor: p.actor, at, prNumber: p.prNumber, repoFullName: p.repoFullName, headRef: p.headRef,
    mergeCommitSha: p.mergeCommitSha, mergedHeadSha: p.mergedHeadSha, mergedAt: p.mergedAt,
  }, deps);
  const reconcile = r.result === 'rejected' && r.reason === 'not_opted_in'
    ? { missionId: p.missionId, steps: [] }
    : await reconcileMissionEpochs(p.missionId, deps);
  return { result: r.result, reason: r.reason, reconcile };
}

export interface WritableEpoch {
  /** The branch task PRs of this mission take now, or null when the mission has no integration branch. */
  branch: string | null;
  /** True when this call cut a new epoch. */
  rotated: boolean;
  /** The branch exists on the remote. */
  ready: boolean;
  reason: string;
}

/**
 * Work needs a writable branch (a task claimed, a task PR opening): return
 * the open epoch's branch, cutting a successor from trunk's head when the
 * newest epoch already merged. Never the branch of a merged epoch.
 */
export async function ensureWritableEpoch(p: { missionId: string; reason: string; actor: string }, deps: EpochDeps = {}): Promise<WritableEpoch> {
  let loaded = await loadMissionEpochView(p.missionId, deps);
  if (!loaded?.view.integrationBranch) return { branch: null, rotated: false, ready: false, reason: 'not_opted_in' };
  const at = (deps.now ?? (() => new Date()))().toISOString();
  if (loaded.view.epochs.length === 0) {
    await applyMissionEpochCommand(p.missionId, { type: 'Adopt', actor: p.actor, at }, deps);
    loaded = await loadMissionEpochView(p.missionId, deps);
    if (!loaded) return { branch: null, rotated: false, ready: false, reason: 'mission_not_found' };
  }
  let rotated = false;
  let reason = 'writable_exists';
  if (!writableEpoch(loaded.view)) {
    const repo = await (deps.repoOf ?? defaultRepoOf)(loaded.mission);
    const api: GithubApi = deps.api ?? (await import('@/lib/github')).githubApi;
    const trunkSha = repo
      ? await api(repo.installationId, `/repos/${repo.repoFullName}/git/ref/heads/${encodeRef(repo.trunk)}`).then((r) => str(r?.object?.sha)).catch(() => null)
      : null;
    const r = await applyMissionEpochCommand(p.missionId, { type: 'EnsureWritable', actor: p.actor, at, trunkSha, reason: p.reason }, deps);
    rotated = r.result === 'applied';
    reason = r.reason;
  }
  await reconcileMissionEpochs(p.missionId, deps);
  const after = await loadMissionEpochView(p.missionId, deps);
  const open = after ? writableEpoch(after.view) : null;
  return {
    branch: open?.branch ?? null,
    rotated,
    ready: !!open && (open.origin !== 'cut' || !!open.branchReadyAt),
    reason: open ? reason : (after && latestEpoch(after.view) ? 'no_writable_epoch' : reason),
  };
}

/** The mission PR for the open epoch was opened or adopted. */
export async function bindEpochPr(p: { missionId: string; prNumber: number; repoFullName: string; ownerTaskId: string | null; headRef: string | null; actor: string }, deps: EpochDeps = {}): Promise<{ result: EpochResult['result']; reason: string }> {
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const r = await applyMissionEpochCommand(p.missionId, {
    type: 'PrBound', actor: p.actor, at, prNumber: p.prNumber, repoFullName: p.repoFullName, ownerTaskId: p.ownerTaskId, headRef: p.headRef,
  }, deps);
  return { result: r.result, reason: r.reason };
}
