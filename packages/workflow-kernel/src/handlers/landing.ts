/**
 * Landing and post-merge effects (docs/specs/workflow-state-kernel.md §10.2,
 * T15–T17, §14 Slice C). Every handler re-reads the delivery and is
 * idempotent: the outbox delivers at least once.
 *
 *  - `merge_call`: the one merge of a kernel-owned PR, pinned to the head T15
 *    approved (`GithubWrites.mergeAtHead`); its answer is T16, never a merged fact.
 *  - `verify_merge`: the live read that turns a merge answer into a fact
 *    (through the `Ingest` port), or tells the kernel nothing landed.
 *  - A merge answered `behind` or `conflict` is a conflict-family repair
 *    (T16 → §6.7): its effects are the conflict family's handlers, not these.
 *  - `emit_pr_merged`, `finalize_mission_pr`: the post-merge work, once per
 *    merge (`Lifecycle.merged` / `finalizeMerge`).
 */
import { applyCommandOn } from '../command-runner';
import { EFFECT_MAX_ATTEMPTS, type EffectHandler, type EffectHandlers } from '../effects';
import { LANDING_STATUS_CONTEXT, landingStatusOf, landingStatusUnknown, reviewGate } from '../landing-gate';
import { githubOf, type KernelPorts } from '../ports';
import { hasPr, need } from './ports-of';

const NO_INSTALLATION = 'no GitHub installation for the workspace';

export function externalMergeFixTitle(prNumber: number): string {
  return `fix: address the review left open when #${prNumber} was merged outside buildd`;
}

/** The trunk fix for a PR merged over an open verdict: what the review asked, against the base it merged into. */
export function externalMergeFixDescription(p: {
  repoFullName: string; prNumber: number; baseRef: string | null; round: number | null; reviewedHeadSha: string | null;
  mergeCommitSha: string | null; mergedBy: string | null; feedback: string | null;
}): string {
  const base = p.baseRef ?? 'the base branch';
  return [
    `PR #${p.prNumber} in ${p.repoFullName} was merged into \`${base}\` outside buildd${p.mergedBy ? ` (by ${p.mergedBy})` : ''} while a review verdict on it was still open${p.round != null ? ` (round ${p.round}${p.reviewedHeadSha ? `, at \`${p.reviewedHeadSha.slice(0, 12)}\`` : ''})` : ''}. The merge is recorded as merged over open findings; it approved nothing, and what the review asked for is now on \`${base}\`.`,
    '',
    '## What the review asked for',
    p.feedback?.trim() ? p.feedback.trim() : '(the reviewer left no written feedback; read the review on the PR)',
    '',
    '## Instructions',
    `1. Branch from the current \`${base}\`${p.mergeCommitSha ? ` (it contains merge commit \`${p.mergeCommitSha.slice(0, 12)}\`)` : ''}.`,
    '2. Fix exactly what the review asked for above. Change nothing unrelated.',
    `3. Open a PR into \`${base}\`. It is reviewed like any other PR.`,
  ].join('\n');
}

export function landingHandlers(ports: KernelPorts): EffectHandlers {
  const apply = (deliveryId: string, cmd: Parameters<typeof applyCommandOn>[1]) =>
    applyCommandOn(ports.store, cmd, { ref: { deliveryId }, newId: ports.newId });

  const mergeCall: EffectHandler = async (e) => {
    const view = await ports.store.loadView({ deliveryId: e.deliveryId });
    const d = view.delivery;
    const headSha = String(e.payload.headSha ?? '');
    if (!hasPr(d)) return { outcome: 'skipped:no_pr' };
    if (d.state !== 'LANDING' || d.currentHeadSha !== headSha) return { outcome: `skipped:state_${d.state}` };
    const github = await githubOf(ports, d.workspaceId);
    const writes = github?.writes;
    if (!github || !writes) throw new Error(NO_INSTALLATION);
    const landingVersion = typeof e.payload.landingVersion === 'number' ? e.payload.landingVersion : undefined;
    const lv = landingVersion !== undefined ? { landingVersion } : {};

    // §4: the gate is asked again here, against a fresh read, never trusted from the door.
    const live = await github.readPr(d.repoFullName, d.prNumber);
    if (!live) throw new Error('live PR read failed before the merge call');
    const pinned = { ...github, readPr: async () => live };
    const subject = { workspaceId: d.workspaceId, source: 'effect:merge_call', repoFullName: d.repoFullName, prNumber: d.prNumber };
    if (live.merged || live.state === 'closed') {
      // Merged or closed under the call: that is a fact for the funnel, not a second merge.
      const r = await need(ports, 'ingest', e.kind).ingest({ kind: 'pr_closed', ...subject }, pinned);
      return { outcome: `skipped:pr_${live.merged ? 'merged' : 'closed'}:${r.result}` };
    }
    if (live.headSha !== headSha) {
      // AC-14: approved at A, B pushed before this ran. The new head is recorded (it moves the
      // delivery out of LANDING and owes B its own review); nothing is merged.
      const r = await need(ports, 'ingest', e.kind).ingest({ kind: 'head_observed', ...subject }, pinned);
      return { outcome: `skipped:head_moved:${r.result}` };
    }
    const override = (e.payload.override ?? null) as { verdict?: boolean; kinds?: Array<'verdict' | 'freshness' | 'size'> } | null;
    const refuse = async (half: 'review' | 'rails', reasons: string[]) => {
      const r = await apply(d.id, {
        type: 'MergeCallResult', actor: 'effect:merge_call', headSha, outcome: 'gate_refused',
        detail: `the landing gate refused at merge time: ${reasons.join('; ')}`, gate: { half, reasons }, ...lv,
      });
      return { outcome: `ok:gate_refused:${half}:${r.result}` };
    };
    const review = reviewGate(view, { headSha, states: ['LANDING'], verdictOverride: override?.verdict === true });
    if (!review.ok) return refuse('review', [review.reason]);
    if (live.baseRef && d.baseRef && live.baseRef !== d.baseRef) return refuse('rails', [`the base moved from ${d.baseRef} to ${live.baseRef}`]);
    const rails = await need(ports, 'rails', e.kind).evaluate(d, { headSha, live, door: String(e.payload.door ?? ''), override });
    const sizeLifted = rails.sizeOnly === true && !!override?.kinds?.includes('size');
    if (!rails.passed && !sizeLifted) return refuse('rails', rails.reasons.length ? rails.reasons : ['a merge rail refused']);

    const method = (e.payload.mergeMethod as 'merge' | 'squash' | 'rebase' | undefined) ?? 'squash';
    // Pinned to the head T15 approved and the gate just passed: a replay at the same head is a no-op or a clean refusal.
    const ans = await writes.mergeAtHead({ repoFullName: d.repoFullName, prNumber: d.prNumber, headSha, method });
    const r = await apply(d.id, {
      type: 'MergeCallResult', actor: 'effect:merge_call', headSha, outcome: ans.outcome, detail: ans.detail,
      ...lv, ...(ans.retryAt ? { retryAt: ans.retryAt } : {}),
    });
    return { outcome: `ok:${ans.outcome}:${r.result}` };
  };

  /**
   * §4: the `buildd/landing` commit status on the delivery's current head. One
   * effect per version; only the newest version's effect publishes (an older
   * one is superseded by the one its successor queued), so a late or duplicate
   * effect never overwrites a newer answer. On the last attempt a failure to
   * decide publishes `failure`, never leaves a stale success standing.
   */
  const publishLandingStatus: EffectHandler = async (e) => {
    if (e.authority && e.authority !== 'kernel') return { outcome: 'skipped:legacy_owns' };
    const view = await ports.store.loadView({ deliveryId: e.deliveryId });
    const d = view.delivery;
    if (!hasPr(d)) return { outcome: 'skipped:no_pr' };
    const version = typeof e.payload.version === 'number' ? e.payload.version : null;
    if (version !== null && d.version > version) return { outcome: 'skipped:older_version' };
    const status = landingStatusOf(view);
    if (!status) return { outcome: `skipped:state_${d.state}` };
    const github = await githubOf(ports, d.workspaceId);
    const writes = github?.writes;
    if (!writes) throw new Error(NO_INSTALLATION);
    const publish = (s: { state: 'success' | 'failure'; description: string; sha: string }) =>
      writes.publishStatus({ repoFullName: d.repoFullName, sha: s.sha, context: LANDING_STATUS_CONTEXT, state: s.state, description: s.description });
    try {
      await publish(status);
    } catch (err) {
      if (e.attemptCount >= EFFECT_MAX_ATTEMPTS && status.state === 'success') {
        // Exhausted: never leave a success the kernel could not re-confirm. Best effort.
        await publish(landingStatusUnknown(status.sha)).catch(() => {});
      }
      throw err;
    }
    return { outcome: `ok:${status.state}` };
  };

  /**
   * §13.13 rule 10 (AC-15): a merge no buildd door made, over a verdict still
   * open, owes one fix task against the base for what the review asked. Filed
   * under the effect's own id, so a replay files nothing new.
   */
  const dispatchExternalMergeFix: EffectHandler = async (e) => {
    const view = await ports.store.loadView({ deliveryId: e.deliveryId });
    const d = view.delivery;
    if (!hasPr(d)) return { outcome: 'skipped:no_pr' };
    if (d.state !== 'MERGED') return { outcome: `skipped:state_${d.state}` };
    const round = view.rounds.find((r) => r.id === e.payload.roundId) ?? null;
    const output = round && ports.reviews ? await ports.reviews.output(round) : {};
    const work = need(ports, 'work', e.kind);
    const p = e.payload as { round?: number; reviewedHeadSha?: string; mergedHeadSha?: string; mergeCommitSha?: string | null; mergedBy?: string | null };
    const filed = await work.file({
      role: 'external_merge_fix',
      workspaceId: d.workspaceId,
      taskId: e.id,
      title: externalMergeFixTitle(d.prNumber),
      description: externalMergeFixDescription({
        repoFullName: d.repoFullName, prNumber: d.prNumber, baseRef: d.baseRef, round: p.round ?? round?.round ?? null,
        reviewedHeadSha: p.reviewedHeadSha ?? round?.headSha ?? null, mergeCommitSha: p.mergeCommitSha ?? d.mergeCommitSha, mergedBy: p.mergedBy ?? null,
        feedback: output.feedback ?? output.summary ?? null,
      }),
      target: { repoFullName: d.repoFullName, prNumber: null, headSha: p.mergeCommitSha ?? d.mergeCommitSha, baseRef: d.baseRef },
      lineage: { deliveryId: d.id, parentTaskId: d.ownerTaskId },
      dedupeKey: `external_merge_fix:${d.id}`,
      detail: { prNumber: d.prNumber, roundId: round?.id ?? null, mergedBy: p.mergedBy ?? null, mergedHeadSha: p.mergedHeadSha ?? null },
    });
    if (filed.skipped) return { outcome: `skipped:${filed.skipped}` };
    if (filed.created && filed.taskId) await work.wake(filed.taskId, 'task.created');
    return { outcome: filed.created ? 'ok' : 'ok:task_exists' };
  };

  const verifyMerge: EffectHandler = async (e) => {
    const d = (await ports.store.loadView({ deliveryId: e.deliveryId })).delivery;
    if (!hasPr(d)) return { outcome: 'skipped:no_pr' };
    if (d.state === 'MERGED') return { outcome: 'ok:already_merged' };
    const reader = await githubOf(ports, d.workspaceId);
    if (!reader) throw new Error(NO_INSTALLATION);
    const live = await reader.readPr(d.repoFullName, d.prNumber);
    if (!live) throw new Error('live PR read failed');
    // The funnel acts on this read, not another one.
    const github = { ...reader, readPr: async () => live };
    const subject = { workspaceId: d.workspaceId, source: 'effect:verify_merge', repoFullName: d.repoFullName, prNumber: d.prNumber };
    if (live.merged || live.state === 'closed') {
      // The merged (or closed) fact, from the kernel's own read: T17 / T18.
      const r = await need(ports, 'ingest', e.kind).ingest({ kind: 'pr_closed', ...subject }, github);
      return { outcome: `ok:${live.merged ? 'merged' : 'closed'}:${r.result}` };
    }
    const headSha = String(e.payload.headSha ?? '');
    if (live.headSha !== headSha) {
      await need(ports, 'ingest', e.kind).ingest({ kind: 'head_observed', ...subject }, github);
      return { outcome: 'ok:head_moved' };
    }
    if (e.payload.outcome === 'merged') {
      // GitHub accepted the merge and its read has not caught up: read again later (or the webhook arrives first).
      throw new Error('the merge was accepted but the live read still shows the PR open');
    }
    if (d.state !== 'LANDING') return { outcome: `skipped:state_${d.state}` };
    const landingVersion = typeof e.payload.landingVersion === 'number' ? e.payload.landingVersion : undefined;
    // A 5xx's retry-after, carried from the merge call through this read.
    const retryAt = typeof e.payload.retryAt === 'string' ? e.payload.retryAt : undefined;
    const r = await apply(d.id, {
      type: 'MergeCallResult', actor: 'effect:verify_merge', headSha, outcome: 'not_merged',
      detail: 'GitHub shows the PR still open and unmerged after the merge call',
      ...(landingVersion !== undefined ? { landingVersion } : {}), ...(retryAt ? { retryAt } : {}),
    });
    return { outcome: `ok:not_merged:${r.result}` };
  };

  const emitPrMerged: EffectHandler = async (e) => {
    const d = (await ports.store.loadView({ deliveryId: e.deliveryId })).delivery;
    if (!hasPr(d)) return { outcome: 'skipped:no_pr' };
    if (d.state !== 'MERGED') return { outcome: `skipped:state_${d.state}` };
    // One effect per merge (its dedupe key): the once-per-merge work runs here.
    if (!(await need(ports, 'lifecycle', e.kind).merged(d))) return { outcome: 'skipped:no_worker' };
    return { outcome: 'ok' };
  };

  const finalizeMissionPr: EffectHandler = async (e) => {
    const d = (await ports.store.loadView({ deliveryId: e.deliveryId })).delivery;
    if (!d?.repoFullName || d.state !== 'MERGED') return { outcome: `skipped:state_${d?.state ?? 'none'}` };
    await need(ports, 'lifecycle', e.kind).finalizeMerge(d);
    return { outcome: 'ok' };
  };

  return {
    merge_call: mergeCall, verify_merge: verifyMerge, emit_pr_merged: emitPrMerged, finalize_mission_pr: finalizeMissionPr,
    publish_landing_status: publishLandingStatus, dispatch_external_merge_fix: dispatchExternalMergeFix,
  };
}
