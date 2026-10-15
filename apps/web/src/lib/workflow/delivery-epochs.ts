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
  pendingEpochSteps, reduceMissionEpochs, classifySettlement, writableEpoch, latestEpoch,
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
  settlement, settled_at, retired_at`;

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
}

function missionRowSql(missionId: string): SQL {
  return sql`-- workflow:mission_epoch_mission
SELECT id, workspace_id, status, working_branch, integration_branch_enabled FROM missions WHERE id = ${missionId}::uuid`;
}

/** Everything the reducer reads for one mission. The host's work counts come from `evaluateMissionWorkState`. */
export async function loadMissionEpochView(missionId: string, deps: EpochDeps = {}): Promise<{ view: MissionEpochView; mission: MissionRow } | null> {
  const exec = deps.exec ?? dbExec;
  const m = ((await exec(missionRowSql(missionId))).rows ?? [])[0] as Record<string, unknown> | undefined;
  if (!m) return null;
  const mission: MissionRow = {
    id: String(m.id), workspaceId: str(m.workspace_id), status: String(m.status),
    workingBranch: str(m.working_branch), integrationBranchEnabled: m.integration_branch_enabled === true,
  };
  const epochs = (await epochsForMissions([missionId], exec)).get(missionId) ?? [];
  const work = await (deps.workOf ?? defaultWorkOf)(missionId);
  const legacyPr = epochs.length === 0 ? await (deps.legacyPrOf ?? defaultLegacyPrOf)(missionId) : null;
  const branch = mission.integrationBranchEnabled ? mission.workingBranch?.trim() || null : null;
  return {
    mission,
    view: {
      missionId, integrationBranch: branch, terminal: mission.status === 'completed' || mission.status === 'archived',
      scopeVersion: 1, epochs, work, legacyPr,
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

const PATCH_COLUMNS: Record<keyof EpochPatch, [string, 'text' | 'int' | 'uuid' | 'timestamptz' | 'jsonb']> = {
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
};

function value(v: unknown, cast: string): SQL {
  if (v == null) return sql`NULL`;
  switch (cast) {
    case 'int': return sql`${Number(v)}::int`;
    case 'uuid': return sql`${String(v)}::uuid`;
    case 'timestamptz': return sql`${String(v)}::timestamptz`;
    case 'jsonb': return sql`${JSON.stringify(v)}::jsonb`;
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
  if (u) {
    const sets = Object.entries(u.set).map(([k, v]) => {
      const [col, cast] = PATCH_COLUMNS[k as keyof EpochPatch];
      return sql`${sql.identifier(col)} = ${value(v, cast)}`;
    });
    ctes.push(sql`u AS (
  UPDATE workflow_mission_epochs SET ${sql.join([...sets, sql`version = version + 1`, sql`updated_at = now()`], sql`, `)}
  WHERE id = ${u.epochId}::uuid AND version = ${u.expectVersion}
  RETURNING id)`);
  }
  const gate = u ? sql`EXISTS (SELECT 1 FROM u)` : sql`true`;
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
  /** Refresh-task PRs of the mission, for settlement classification. */
  refreshPrsOf?: (missionId: string) => Promise<Set<number>>;
  /** Refresh tasks filed for `branch` that never started (no worker yet): their premise is gone. */
  obsoleteRefreshTasksOf?: (missionId: string, branch: string) => Promise<string[]>;
  /** Cancel a task that never started (the kernel's Work port). */
  cancelTask?: (taskId: string, reason: string) => Promise<void>;
  /** Mission task PRs (open, not the mission PR) with the base buildd recorded, for PRs GitHub moved to trunk. */
  missionTaskPrsOf?: (missionId: string) => Promise<Array<{ prNumber: number; recordedBase: string | null; refresh: boolean }>>;
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
    if (view.epochs.length === 0 && view.integrationBranch && cmd.type !== 'Adopt') {
      const adopt = reduceMissionEpochs(view, { type: 'Adopt', actor: cmd.actor, at: cmd.at, mergingPr: cmd.type === 'Merged' ? cmd.prNumber : null });
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
 * Is everything `headSha` carries already in `intoSha`'s tree? Ancestry first;
 * then a test merge on a scratch ref (a squash-merged delivery leaves no
 * ancestry, so only the tree can prove it): GitHub answers 204 (nothing to
 * merge), a merge commit whose tree equals `intoSha`'s (contained), a
 * different tree (not contained) or 409 (conflicts: not contained). The
 * scratch ref is always deleted. null when any read failed.
 */
export async function contentContained(api: GithubApi, repo: MissionRepo, headSha: string, intoSha: string, scratch: string): Promise<boolean | null> {
  const anc = await isAncestor(api, repo, headSha, intoSha);
  if (anc === true) return true;
  if (anc === null) return null;
  const refPath = `/repos/${repo.repoFullName}/git/refs/heads/${encodeRef(scratch)}`;
  try {
    await api(repo.installationId, `/repos/${repo.repoFullName}/git/refs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: `refs/heads/${scratch}`, sha: intoSha }),
    });
  } catch (err) {
    if (githubStatus(err) !== 422) return null;
    try {
      await api(repo.installationId, refPath, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sha: intoSha, force: true }) });
    } catch { return null; }
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
    if (!merged) return true;
    const probeTree = merged?.commit?.tree?.sha;
    const into = await api(repo.installationId, `/repos/${repo.repoFullName}/git/commits/${intoSha}`).catch(() => null);
    const intoTree = into?.tree?.sha;
    if (typeof probeTree !== 'string' || typeof intoTree !== 'string') return null;
    return probeTree === intoTree;
  } finally {
    await api(repo.installationId, refPath, { method: 'DELETE' }).catch(() => {});
  }
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
  const api: GithubApi = deps.api ?? (await import('@/lib/github')).githubApi;
  const now = () => (deps.now ?? (() => new Date()))().toISOString();
  const out: ReconcileOutcome = { missionId, steps: [] };
  const loaded = await loadMissionEpochView(missionId, deps);
  if (!loaded || loaded.view.epochs.length === 0) return out;
  const repo = await (deps.repoOf ?? defaultRepoOf)(loaded.mission);
  if (!repo) return out;

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

  for (let guard = 0; guard < 8; guard++) {
    const current = await loadMissionEpochView(missionId, deps);
    if (!current) return out;
    const step = pendingEpochSteps(current.view)[0];
    if (!step) return out;
    const epoch = current.view.epochs.find((e) => e.id === step.epochId)!;
    const record = async (cmd: MissionEpochCommand, label: string) => {
      const r = await applyMissionEpochCommand(missionId, cmd, deps);
      out.steps.push({ step: step.step, epoch: epoch.epoch, outcome: `${label}:${r.result}:${r.reason}` });
      return r;
    };

    if (step.step === 'cut_branch') {
      const ready = await cutBranch(api, repo, step.branch, step.fromSha);
      if (!ready) { out.steps.push({ step: step.step, epoch: epoch.epoch, outcome: 'failed' }); return out; }
      await record({ type: 'BranchReady', actor: 'kernel:mission_epochs', at: now(), epochId: step.epochId }, ready);
      continue;
    }

    if (step.step === 'settle') {
      const settlement = await settle(api, repo, current.view, epoch, step.successorBranch, deps);
      if (!settlement) { out.steps.push({ step: step.step, epoch: epoch.epoch, outcome: 'unreadable' }); return out; }
      const r = await record({ type: 'Settled', actor: 'kernel:mission_epochs', at: now(), epochId: epoch.id, settlement }, 'settled');
      if (settlement.held.length > 0) {
        if (r.result === 'applied') await noteHeld(missionId, epoch, settlement, deps);
        return out;
      }
      continue;
    }

    // retire: only once nothing open is still based on the branch, read fresh.
    const stillOpen = await openPrsOn(api, repo, step.branch);
    if (stillOpen === null || stillOpen.length > 0) {
      out.steps.push({ step: step.step, epoch: epoch.epoch, outcome: stillOpen === null ? 'unreadable' : `held_by_${stillOpen.length}` });
      if (stillOpen && stillOpen.length > 0) {
        // Something new landed on the branch after settlement: settle again.
        await record({ type: 'Settled', actor: 'kernel:mission_epochs', at: now(), epochId: epoch.id, settlement: {
          settled: epoch.settlement?.settled ?? [], held: stillOpen.map((n) => ({ prNumber: n, kind: 'task' as const, disposition: 'hold' as const, reason: 'opened on this branch after it merged', proof: { headSha: null, mergeCommitSha: epoch.mergeCommitSha, contained: null } })),
          satisfiedByPr: epoch.prNumber,
        } }, 'reheld');
      }
      return out;
    }
    try {
      await api(repo.installationId, `/repos/${repo.repoFullName}/git/refs/heads/${encodeRef(step.branch)}`, { method: 'DELETE' });
    } catch (err) {
      const s = githubStatus(err);
      // 404 / 422: GitHub already deleted it (delete-branch-on-merge). The post-condition holds.
      if (s !== 404 && s !== 422) { out.steps.push({ step: step.step, epoch: epoch.epoch, outcome: `failed:${s ?? 'error'}` }); return out; }
    }
    await record({ type: 'Retired', actor: 'kernel:mission_epochs', at: now(), epochId: epoch.id }, 'retired');
  }
  return out;
}

async function cutBranch(api: GithubApi, repo: MissionRepo, branch: string, fromSha: string | null): Promise<string | null> {
  try {
    await api(repo.installationId, `/repos/${repo.repoFullName}/git/ref/heads/${encodeRef(branch)}`);
    return 'found';
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
    return githubStatus(err) === 422 && /reference already exists/i.test(err instanceof Error ? err.message : String(err)) ? 'found' : null;
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
  const refreshPrs = await (deps.refreshPrsOf ?? defaultRefreshPrsOf)(view.missionId);
  const candidates: Array<{ prNumber: number; headSha: string | null; baseRef: string; refresh: boolean }> = onBranch
    .filter((p) => p.number !== epoch.prNumber)
    .map((p) => ({ prNumber: p.number, headSha: p.head?.sha ?? null, baseRef: p.base?.ref ?? epoch.branch, refresh: refreshPrs.has(p.number) }));

  // GitHub retargets the open PRs of a branch it deletes on merge to that PR's base (trunk).
  for (const t of await (deps.missionTaskPrsOf ?? defaultMissionTaskPrsOf)(view.missionId)) {
    if (t.prNumber === epoch.prNumber || candidates.some((c) => c.prNumber === t.prNumber)) continue;
    if (t.recordedBase !== epoch.branch && t.recordedBase !== repo.trunk) continue;
    try {
      const pr = await api(repo.installationId, `/repos/${repo.repoFullName}/pulls/${t.prNumber}`);
      if (pr?.state === 'open' && pr?.base?.ref === repo.trunk) {
        candidates.push({ prNumber: t.prNumber, headSha: pr?.head?.sha ?? null, baseRef: repo.trunk, refresh: t.refresh });
      }
    } catch { return null; }
  }

  const into = epoch.mergeCommitSha;
  const classified: SettlementCandidate[] = [];
  for (const c of candidates) {
    const contained = c.headSha && into
      ? await contentContained(api, repo, c.headSha, into, `buildd-settle/${epoch.id.slice(0, 8)}-${c.prNumber}`)
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

async function defaultRefreshPrsOf(missionId: string): Promise<Set<number>> {
  const rows = ((await dbExec(sql`-- workflow:mission_refresh_prs
SELECT DISTINCT w.pr_number FROM tasks t JOIN workers w ON w.task_id = t.id
WHERE t.mission_id = ${missionId}::uuid AND w.pr_number IS NOT NULL AND (t.context->>'requireMergeCommit')::boolean IS TRUE`)).rows ?? []) as Array<{ pr_number: unknown }>;
  return new Set(rows.map((r) => Number(r.pr_number)));
}

async function defaultMissionTaskPrsOf(missionId: string): Promise<Array<{ prNumber: number; recordedBase: string | null; refresh: boolean }>> {
  const rows = ((await dbExec(sql`-- workflow:mission_task_prs
SELECT DISTINCT ON (w.pr_number) w.pr_number, w.pr_base_ref, (t.context->>'requireMergeCommit')::boolean IS TRUE AS refresh
FROM tasks t JOIN workers w ON w.task_id = t.id
WHERE t.mission_id = ${missionId}::uuid AND w.pr_number IS NOT NULL AND w.merged_at IS NULL
  AND COALESCE(w.pr_lifecycle_status, '') NOT IN ('closed', 'merged', 'unresolvable')
  AND NOT (t.task_class = 'bookkeeping' AND t.title LIKE 'Ship mission: %')
ORDER BY w.pr_number, w.created_at DESC`)).rows ?? []) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ prNumber: Number(r.pr_number), recordedBase: str(r.pr_base_ref), refresh: r.refresh === true || r.refresh === 't' }));
}

async function defaultObsoleteRefreshTasksOf(missionId: string, branch: string): Promise<string[]> {
  const rows = ((await dbExec(sql`-- workflow:mission_obsolete_refreshes
SELECT t.id FROM tasks t
WHERE t.mission_id = ${missionId}::uuid AND t.status = 'pending'
  AND (t.context->>'requireMergeCommit')::boolean IS TRUE AND t.context->>'baseBranch' = ${branch}::text
  AND NOT EXISTS (SELECT 1 FROM workers w WHERE w.task_id = t.id)`)).rows ?? []) as Array<{ id: unknown }>;
  return rows.map((r) => String(r.id));
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
