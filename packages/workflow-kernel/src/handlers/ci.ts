/**
 * The CI family's effects (docs/specs/workflow-state-kernel.md §5.7, §10.2,
 * §10.5). The ledger row was allocated by the transition that queued
 * `dispatch_ci_fix` (allocation is consumption, §5.7 rule 1): these handlers
 * never count anything.
 *
 *  - `dispatch_ci_fix`: revalidate against a live read (the row is still the
 *    bound, queued one; the PR is open; its head is the bound head; CI is not
 *    green now), then file the fix through `Work` under the row's own id, bind
 *    the row to it and wake it. What the task says (the CI logs, a schema-drift
 *    diagnose instead of a fix) is the host's builder for role `ci_fix`.
 *  - `capture_ci_evidence`: the follow-up the filing owes when the host has a
 *    job log to keep. It runs as its own effect, not after the response, and
 *    records what it captured as a fact on the delivery.
 *  - `escalate_exhaustion` (family `ci`): the budget is spent, or CI retries
 *    are off; a person owns the red PR (`Escalate`).
 */
import { applyCommandOn } from '../command-runner';
import type { Command } from '../commands';
import type { EffectHandler, EffectHandlers } from '../effects';
import { githubOf, type ClaimedEffect, type KernelPorts } from '../ports';
import type { DeliverySnapshot } from '../types';
import { hasPr, need } from './ports-of';

const NO_INSTALLATION = 'no GitHub installation for the workspace';

/** The fact a captured CI job log is recorded under: one per fix task. */
export const ciEvidenceFactKey = (taskId: string): string => `evidence:ci_job_log:${taskId}`;

export function ciHandlers(ports: KernelPorts): EffectHandlers {
  const apply = (deliveryId: string, cmd: Command) => applyCommandOn(ports.store, cmd, { ref: { deliveryId }, newId: ports.newId });

  const dispatchCiFix: EffectHandler = async (e) => {
    const source = 'effect:dispatch_ci_fix';
    const view = await ports.store.loadView({ deliveryId: e.deliveryId });
    const d = view.delivery;
    const attempt = view.attempts.find((a) => a.id === e.payload.attemptId);
    if (!d || !attempt) return { outcome: 'skipped:no_attempt' };
    // The task id IS the attempt id, so a re-run after a crash between filing and linking files nothing twice.
    const taskId = attempt.id;
    if (attempt.taskId) return { outcome: 'ok:task_exists' };
    if (attempt.status !== 'queued') return { outcome: `skipped:attempt_${attempt.status}` };
    if (d.state !== 'REPAIRING' || d.boundAttemptId !== attempt.id) {
      const r = await apply(d.id, { type: 'RepairNotNeeded', actor: source, attemptId: attempt.id, reason: 'state_moved' });
      return { outcome: `skipped:${'reason' in r ? r.reason : 'state_moved'}` };
    }
    if (!hasPr(d) || !attempt.boundHeadSha) return { outcome: 'skipped:no_pr' };
    const reader = await githubOf(ports, d.workspaceId);
    if (!reader) throw new Error(NO_INSTALLATION);
    const live = await reader.readPr(d.repoFullName, d.prNumber);
    if (!live) throw new Error('live PR read failed');

    // §10.5 at dispatch: the trigger fact must still be true for the current head.
    // A closed or merged PR is answered by its own fact (T17/T18 cancel the row).
    if (live.state !== 'open' || live.merged) return { outcome: 'skipped:pr_not_open' };
    if (live.headSha !== attempt.boundHeadSha) {
      // The head moved before the fix started: T3 skips the queued row and handles the head.
      await need(ports, 'ingest', e.kind).ingest(
        { kind: 'head_observed', workspaceId: d.workspaceId, source, repoFullName: d.repoFullName, prNumber: d.prNumber },
        { ...reader, readPr: async () => live },
      );
      return { outcome: 'skipped:head_moved' };
    }
    if ((await reader.ciGreen?.(d.repoFullName, live.headSha)) === true) {
      await apply(d.id, { type: 'RepairNotNeeded', actor: source, attemptId: attempt.id, reason: 'ci_green', live });
      return { outcome: 'skipped:ci_green' };
    }

    const headSha = attempt.boundHeadSha;
    // One row per (workspace, PR, head) in the host's legacy dedupe; a second attempt on the
    // same head (the first one failed without pushing) is deduped by the ledger instead.
    const firstAtHead = view.attempts.filter((a) => a.family === 'ci' && a.boundHeadSha === headSha && a.status !== 'skipped').length <= 1;
    const work = need(ports, 'work', e.kind);
    const filed = await work.file({
      role: 'ci_fix',
      workspaceId: d.workspaceId,
      taskId,
      target: { repoFullName: d.repoFullName, prNumber: d.prNumber, headSha, baseRef: d.baseRef },
      lineage: { deliveryId: d.id, attemptId: attempt.id, parentTaskId: d.ownerTaskId },
      dedupeKey: `ci_fix:${attempt.id}`,
      // "attempt N of M" is display only, from the ledger row (§5.7 rule 4).
      detail: { attemptNo: attempt.attemptNo, maxAttempts: attempt.maxAttempts, trigger: attempt.trigger, firstAtHead, signature: attempt.triggerReason },
    });
    if (filed.skipped || !filed.taskId) return { outcome: `skipped:${filed.skipped ?? 'not_filed'}` };
    await ports.store.linkAttemptTask(attempt.id, filed.taskId);
    // Not created: a run that filed it crashed before binding the row (a bound row returned above),
    // so it was never woken nor owed its evidence. This run finishes what that one started.
    await work.wake(filed.taskId, 'ci.retry');
    if (filed.evidence) {
      // Owed, not run after the response: the drain captures it and records what it got.
      await ports.store.insertFollowupEffect({
        deliveryId: d.id, transitionId: e.transitionId, kind: 'capture_ci_evidence',
        dedupeKey: `capture_ci_evidence:${filed.taskId}`, payload: { ...filed.evidence, taskId: filed.taskId },
      });
    }
    if (!filed.created) return { outcome: 'ok:task_bound' };
    return { outcome: filed.variant === 'diagnose' ? 'ok:diagnose' : 'ok' };
  };

  const captureCiEvidence: EffectHandler = async (e) => {
    const d = (await ports.store.loadView({ deliveryId: e.deliveryId })).delivery;
    if (!d) return { outcome: 'skipped:no_delivery' };
    const taskId = String(e.payload.taskId ?? '');
    if (!taskId) return { outcome: 'skipped:no_task' };
    const factKey = ciEvidenceFactKey(taskId);
    if (await ports.store.findFact(d.workspaceId, factKey)) return { outcome: 'ok:already_recorded' };
    const got = await need(ports, 'evidence', e.kind).capture({ kind: 'ci_job_log', workspaceId: d.workspaceId, deliveryId: d.id, payload: e.payload });
    await ports.store.insertFact({
      workspaceId: d.workspaceId, kind: 'evidence_captured', factKey, source: 'effect:capture_ci_evidence',
      repoFullName: d.repoFullName, prNumber: d.prNumber,
      payload: { deliveryId: d.id, taskId, evidenceKind: 'ci_job_log', status: got.status, ...(got.record ?? {}) },
    });
    return { outcome: `ok:${got.status}` };
  };

  return { dispatch_ci_fix: dispatchCiFix, capture_ci_evidence: captureCiEvidence };
}

/** `escalate_exhaustion` for family `ci`. */
export async function escalateCiExhaustion(ports: KernelPorts, e: ClaimedEffect, d: DeliverySnapshot | null): Promise<{ outcome: string }> {
  if (!hasPr(d)) return { outcome: 'skipped:no_pr' };
  if (!(await githubOf(ports, d.workspaceId))) return { outcome: 'skipped:no_installation' };
  const spent = Number(e.payload.attempts ?? 0);
  const max = Number(e.payload.max ?? spent);
  const headSha = String(e.payload.headSha ?? d.currentHeadSha ?? '');
  const disabled = max <= 0;
  const detail = disabled
    ? `CI retries are disabled for this workspace; CI is failing on PR #${d.prNumber}.`
    : `CI fix attempts used ${spent} of ${max} on PR #${d.prNumber}; CI is still failing.`;
  const title = disabled ? 'CI failing — retries disabled' : 'CI failing — agent retries exhausted';
  const outcome = await need(ports, 'escalate', e.kind).exhausted(d, { family: 'ci', headSha, attempts: spent, max, title, detail });
  return { outcome };
}
