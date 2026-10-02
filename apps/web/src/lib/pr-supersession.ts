/**
 * The write side of PR supersession (task fcaf83d5).
 *
 * `canCompleteMission`'s awaiting-merge gate (mission-completion.ts) blocks a
 * completed deliverable whose PR closed without merging — deliberately,
 * per the M4 incident (docs/specs/mission-task-lifecycle.md). That gate has no
 * representation of "this PR's diff landed under a different number", which is
 * exactly what happens when a mission integration branch is deleted out from
 * under an open PR (#2355) and the work is re-opened as a fresh PR rather than
 * resurrected under the old one. This module is the one sanctioned escape
 * hatch: a durable, auditable claim recorded on the worker row, never a
 * status an agent can assert its way past.
 *
 * The claim is validated against GitHub at write time — the superseding PR
 * must exist and be merged — so a read never has to re-verify: a GitHub merge
 * is permanent, so a stored claim stays valid forever once written (see the
 * schema comment on `workers.supersededByPrNumber`).
 *
 * The target may live in another repo when that repo belongs to the same
 * workspace or to a workspace with a task in the same mission (a
 * cross-repo move: docs relocated to a sibling repo). It is still verified
 * merged, through an installation that covers that repo.
 *
 * Also here: the two other durable resolutions of a closed-unmerged PR that a
 * person can choose — `recordPrAbandonment` (the work deliberately does not
 * ship) and `dismissSupersessionSuggestion` ("Not this" on an unverified
 * candidate from lib/pr-supersession-detect.ts).
 */
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import type { SupersessionScan } from '@buildd/core/pr-shipped';
import { and, eq, isNull, or } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import { normalizeRepoFullName, repoFullNameFromPrUrl } from '@/lib/repo-scope';
import { installationIdForRepo } from '@/lib/workspace-installation';

export interface RecordPrSupersessionParams {
  workerId: string;
  /** The PR number that carries this work now. Must already be merged. */
  supersedingPrNumber: number;
  /**
   * `owner/name` of the superseding PR's repo, when it is not the closed PR's
   * own repo. Must belong to the same workspace or mission.
   */
  supersedingRepo?: string | null;
  /** Required — never a silent agent assertion. */
  reason: string;
  /** Actor label (user email, or `agent:<taskId>`) — free text, not a FK. */
  recordedBy: string;
}

export interface RecordPrSupersessionOk {
  ok: true;
  supersededPrNumber: number;
  supersedingPrNumber: number;
  supersedingPrUrl: string;
  supersedingRepo: string;
}

export interface RecordPrSupersessionError {
  ok: false;
  error: string;
  status: number;
}

export type RecordPrSupersessionResult = RecordPrSupersessionOk | RecordPrSupersessionError;

const sameRepo = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * Repos a supersession target may live in for this worker: its workspace's
 * repo, the closed PR's own repo, and — when the task is in a mission — every
 * repo a task of that mission is bound to or opened a PR in. Lowercased.
 */
export async function supersessionRepoScope(worker: {
  prUrl: string | null;
  taskId: string | null;
  workspaceRepo: string | null;
}): Promise<Set<string>> {
  const out = new Set<string>();
  const add = (r: string | null | undefined) => {
    const n = normalizeRepoFullName(r);
    if (n) out.add(n.toLowerCase());
  };
  add(repoFullNameFromPrUrl(worker.prUrl));
  add(worker.workspaceRepo);
  if (!worker.taskId) return out;

  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, worker.taskId),
    columns: { missionId: true },
  });
  if (!task?.missionId) return out;
  const siblings = await db.query.tasks.findMany({
    where: eq(tasks.missionId, task.missionId),
    columns: { id: true },
    with: {
      workspace: { columns: { repo: true }, with: { githubRepo: { columns: { fullName: true } } } },
      workers: { columns: { prUrl: true } },
    },
  });
  for (const t of siblings) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ws = (t as any).workspace;
    add(ws?.githubRepo?.fullName ?? ws?.repo);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const w of ((t as any).workers ?? []) as Array<{ prUrl: string | null }>) add(repoFullNameFromPrUrl(w.prUrl));
  }
  return out;
}

/** Every row carrying this PR — a retry session can share its parent's PR. */
function rowsOfPr(workerId: string, prUrl: string) {
  return or(eq(workers.id, workerId), and(eq(workers.prUrl, prUrl), isNull(workers.mergedAt)));
}

/**
 * Record that `workerId`'s PR was superseded by `supersedingPrNumber`.
 *
 * Rejects at write time (never silently accepted, per the task's explicit
 * "Do NOT" doctrine) when:
 *  - `reason` is blank
 *  - the target is the PR being superseded
 *  - the worker's own PR is already merged (nothing to supersede)
 *  - the target repo is outside the workspace and the task's mission
 *  - the target PR does not exist in that repo, or no installation covers it
 *  - the target PR exists but is not merged
 */
export async function recordPrSupersession(
  params: RecordPrSupersessionParams,
): Promise<RecordPrSupersessionResult> {
  const { workerId, supersedingPrNumber, reason, recordedBy } = params;

  if (!reason || !reason.trim()) {
    return { ok: false, error: 'reason is required', status: 400 };
  }
  if (!Number.isInteger(supersedingPrNumber) || supersedingPrNumber <= 0) {
    return { ok: false, error: 'supersedingPrNumber must be a positive integer', status: 400 };
  }
  if (params.supersedingRepo && !normalizeRepoFullName(params.supersedingRepo)) {
    return { ok: false, error: 'supersedingRepo must be owner/name', status: 400 };
  }

  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, workerId),
    with: {
      workspace: {
        with: { githubRepo: { with: { installation: true } } },
      },
    },
  });
  if (!worker) return { ok: false, error: 'Worker not found', status: 404 };
  if (!worker.prNumber || !worker.prUrl) {
    return {
      ok: false,
      error: 'Worker has no PR to supersede — this worker is not tracking a PR. '
        + 'If you intended to record a supersession for a specific PR, '
        + 'use record_pr_supersession with prNumber to resolve the correct worker.',
      status: 400,
    };
  }
  if (worker.mergedAt) {
    return { ok: false, error: `PR #${worker.prNumber} already merged — nothing to supersede`, status: 409 };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wsRepo = (worker.workspace as any)?.githubRepo;
  const workspaceRepo: string | null = normalizeRepoFullName(wsRepo?.fullName) ?? null;
  const closedRepo = repoFullNameFromPrUrl(worker.prUrl) ?? workspaceRepo;
  if (!closedRepo) {
    return { ok: false, error: 'Workspace has no GitHub installation', status: 422 };
  }
  const targetRepo = normalizeRepoFullName(params.supersedingRepo) ?? closedRepo;
  const crossRepo = !sameRepo(targetRepo, closedRepo);

  if (!crossRepo && worker.prNumber === supersedingPrNumber) {
    return { ok: false, error: 'supersedingPrNumber must differ from the PR being superseded', status: 400 };
  }
  if (crossRepo) {
    // A PR number is only meaningful within one repo, so the repo itself must
    // be one this work could plausibly have moved to: never an arbitrary one.
    const scope = await supersessionRepoScope({ prUrl: worker.prUrl, taskId: worker.taskId, workspaceRepo });
    if (!scope.has(targetRepo.toLowerCase())) {
      return {
        ok: false,
        error: `${targetRepo} is not a repo of this workspace or of any task in its mission — `
          + 'a supersession target must live where this work could have moved',
        status: 403,
      };
    }
  }

  const installationId: number | null = sameRepo(targetRepo, workspaceRepo) && wsRepo?.installation?.installationId
    ? wsRepo.installation.installationId
    : await installationIdForRepo(targetRepo).catch(() => null);
  if (!installationId) {
    return { ok: false, error: `No GitHub installation covers ${targetRepo}`, status: 422 };
  }

  let prData: { merged?: boolean; html_url?: string; state?: string } | null = null;
  try {
    prData = await githubApi(installationId, `/repos/${targetRepo}/pulls/${supersedingPrNumber}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('404')) {
      return { ok: false, error: `PR #${supersedingPrNumber} not found in ${targetRepo}`, status: 404 };
    }
    return { ok: false, error: `Could not verify PR #${supersedingPrNumber}: ${msg}`, status: 502 };
  }

  if (!prData?.merged) {
    return {
      ok: false,
      error: `PR #${supersedingPrNumber} is not merged (state: ${prData?.state ?? 'unknown'}) — `
        + 'a supersession claim requires the target to already be merged',
      status: 409,
    };
  }

  const supersedingPrUrl = prData.html_url ?? `https://github.com/${targetRepo}/pull/${supersedingPrNumber}`;
  const now = new Date();
  await db.update(workers).set({
    supersededByPrNumber: supersedingPrNumber,
    supersededByPrUrl: supersedingPrUrl,
    supersededReason: reason.trim(),
    supersededRecordedBy: recordedBy,
    supersededAt: now,
    updatedAt: now,
  }).where(rowsOfPr(workerId, worker.prUrl));

  return {
    ok: true,
    supersededPrNumber: worker.prNumber,
    supersedingPrNumber,
    supersedingPrUrl,
    supersedingRepo: targetRepo,
  };
}

export type SimpleWriteResult = { ok: true } | { ok: false; error: string; status: number };

/**
 * Declare a closed-unmerged PR abandoned: the work is deliberately not
 * shipping. Its own durable state (`prShipState` → `abandoned`), never a
 * supersession, and only for a PR that is actually closed — an open PR should
 * be closed or merged, not explained away.
 */
export async function recordPrAbandonment(params: {
  workerId: string;
  reason: string;
  recordedBy: string;
}): Promise<SimpleWriteResult> {
  const reason = params.reason?.trim();
  if (!reason) return { ok: false, error: 'A reason is required to mark a PR abandoned', status: 400 };

  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, params.workerId),
    columns: { id: true, prUrl: true, prNumber: true, mergedAt: true, prLifecycleStatus: true, supersededByPrNumber: true },
  });
  if (!worker) return { ok: false, error: 'Worker not found', status: 404 };
  if (!worker.prUrl) return { ok: false, error: 'Worker has no PR', status: 400 };
  if (worker.mergedAt) return { ok: false, error: `PR #${worker.prNumber} merged — nothing to abandon`, status: 409 };
  if (worker.supersededByPrNumber) {
    return { ok: false, error: `PR #${worker.prNumber} is already recorded as superseded by #${worker.supersededByPrNumber}`, status: 409 };
  }
  if (worker.prLifecycleStatus !== 'closed') {
    return { ok: false, error: `PR #${worker.prNumber} is not closed — close it before marking it abandoned`, status: 409 };
  }

  const now = new Date();
  await db.update(workers).set({
    abandonedReason: reason,
    abandonedRecordedBy: params.recordedBy,
    abandonedAt: now,
    updatedAt: now,
  }).where(rowsOfPr(worker.id, worker.prUrl));
  return { ok: true };
}

/**
 * "Not this": drop an unverified supersession suggestion and remember the
 * candidate so a later scan never offers it again.
 */
export async function dismissSupersessionSuggestion(params: {
  workerId: string;
  candidatePrUrl: string;
}): Promise<SimpleWriteResult> {
  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, params.workerId),
    columns: { id: true, prUrl: true, supersessionScan: true },
  });
  if (!worker?.prUrl) return { ok: false, error: 'Worker not found', status: 404 };
  const prev: SupersessionScan | null = worker.supersessionScan ?? null;
  const dismissed = [...new Set([...(prev?.dismissed ?? []), params.candidatePrUrl])];
  const next: SupersessionScan = {
    scannedAt: prev?.scannedAt ?? new Date().toISOString(),
    candidatesChecked: prev?.candidatesChecked ?? 0,
    suggestion: prev?.suggestion?.prUrl === params.candidatePrUrl ? null : (prev?.suggestion ?? null),
    dismissed,
  };
  await db.update(workers).set({ supersessionScan: next, updatedAt: new Date() })
    .where(rowsOfPr(worker.id, worker.prUrl));
  return { ok: true };
}
