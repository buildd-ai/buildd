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
 */
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { githubApi } from '@/lib/github';

export interface RecordPrSupersessionParams {
  workerId: string;
  /** The PR number that carries this work now. Must already be merged. */
  supersedingPrNumber: number;
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
}

export interface RecordPrSupersessionError {
  ok: false;
  error: string;
  status: number;
}

export type RecordPrSupersessionResult = RecordPrSupersessionOk | RecordPrSupersessionError;

/**
 * Record that `workerId`'s PR was superseded by `supersedingPrNumber`.
 *
 * Rejects at write time (never silently accepted, per the task's explicit
 * "Do NOT" doctrine) when:
 *  - `reason` is blank
 *  - the target PR number is the same as the PR being superseded
 *  - the worker's own PR is already merged (nothing to supersede)
 *  - the target PR does not exist in the SAME repo as the worker's workspace
 *    (recommend same-workspace scoping — a PR number is only meaningful
 *    within one repo, and a cross-repo claim could never be verified against
 *    the workspace's own installation token)
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
    return { ok: false, error: 'Worker has no PR to supersede', status: 400 };
  }
  if (worker.mergedAt) {
    return { ok: false, error: `PR #${worker.prNumber} already merged — nothing to supersede`, status: 409 };
  }
  if (worker.prNumber === supersedingPrNumber) {
    return { ok: false, error: 'supersedingPrNumber must differ from the PR being superseded', status: 400 };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const repo = (worker.workspace as any)?.githubRepo;
  const installationId: number | undefined = repo?.installation?.installationId;
  if (!repo?.fullName || !installationId) {
    return { ok: false, error: 'Workspace has no GitHub installation', status: 422 };
  }

  // Same-repo scoping (recommended in the task brief): the superseding PR is
  // resolved through THIS workspace's installation token against THIS repo,
  // so a PR number belonging to a different repo either 404s or resolves to
  // an unrelated PR that will fail the merged-state check below. There is no
  // path here that can confirm a claim against a different workspace's repo.
  let prData: { merged?: boolean; html_url?: string; state?: string } | null = null;
  try {
    prData = await githubApi(installationId, `/repos/${repo.fullName}/pulls/${supersedingPrNumber}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('404')) {
      return { ok: false, error: `PR #${supersedingPrNumber} not found in ${repo.fullName}`, status: 404 };
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

  const supersedingPrUrl = prData.html_url ?? `https://github.com/${repo.fullName}/pull/${supersedingPrNumber}`;
  const now = new Date();
  await db.update(workers).set({
    supersededByPrNumber: supersedingPrNumber,
    supersededByPrUrl: supersedingPrUrl,
    supersededReason: reason.trim(),
    supersededRecordedBy: recordedBy,
    supersededAt: now,
    updatedAt: now,
  }).where(eq(workers.id, workerId));

  return {
    ok: true,
    supersededPrNumber: worker.prNumber,
    supersedingPrNumber,
    supersedingPrUrl,
  };
}
