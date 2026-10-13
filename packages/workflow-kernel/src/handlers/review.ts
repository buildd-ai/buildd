/**
 * The review loop's effects (docs/specs/workflow-state-kernel.md §10.2, §8.4,
 * §9). Each one re-reads the delivery and acts only on what is still owed:
 * the outbox delivers at least once.
 *
 *  - `dispatch_review`: one reviewer per round. A composed PR whose changes
 *    were all reviewed is attested instead (`Reviews.attestComposition`); a
 *    workspace with no role that can review fails the round (T27), never
 *    drops it.
 *  - `dispatch_fix`: T8 (the ledger row) then the fix task, under the row's
 *    task id, through `Work` (role `fix`).
 *  - `post_review`: the GitHub review at the round's own commit, never the
 *    PR's current head; one GitHub refused is recorded for a person, not
 *    retried into a duplicate.
 *  - `mission_note` (review escalated), `escalate_exhaustion` (family
 *    `review_fix`), the team notices (`notify`), the review loop's
 *    cancellations (`cancel_open_attempts`) and `push_recovery`'s bounded
 *    re-reads.
 *
 * What a reviewer said, and what only the host records, is the `Reviews`
 * port; the task rows are `Work`'s.
 */
import { applyCommandOn } from '../command-runner';
import type { Command } from '../commands';
import type { EffectHandler, EffectHandlers } from '../effects';
import { githubOf, NO_ROLE, type ClaimedEffect, type KernelPorts, type PostedReview, type ReviewOutput } from '../ports';
import { PUSH_RECOVERY_BACKOFF_MS } from '../reducer';
import type { DeliverySnapshot, RoundSnapshot } from '../types';
import { hasPr, need, type WithPr } from './ports-of';

const NO_INSTALLATION = 'no GitHub installation for the workspace';

/**
 * The GitHub review body. A composition delta round (§5.9, S33) reviewed only
 * the paths new to the composed PR (a release's own changes, or what a mission
 * branch refresh's merge resolved), so its approval says so: it is not a
 * reviewer verdict on the whole PR.
 */
export function postReviewBody(
  event: 'APPROVE' | 'REQUEST_CHANGES',
  out: { confidence?: number | null; summary?: string | null; feedback?: string | null },
  scope: unknown,
): string {
  if (event !== 'APPROVE') return `Changes requested by buildd reviewer: ${out.feedback ?? out.summary ?? ''}`;
  const sc = scope as { compositionDelta?: unknown; paths?: unknown } | null | undefined;
  if (sc?.compositionDelta === true) {
    const paths = Array.isArray(sc.paths) ? sc.paths.map(String) : [];
    const list = paths.length ? `\n\n${paths.map((p) => `- \`${p}\``).join('\n')}` : '';
    const text = `New changes approved by buildd reviewer (confidence ${(out.confidence ?? 0).toFixed(2)}). `
      + `This review covers only the ${paths.length} ${paths.length === 1 ? 'path' : 'paths'} new to this PR; `
      + `every other change was reviewed at its own head and is not re-reviewed here.${list}\n\n${out.summary ?? ''}`;
    return text.trimEnd();
  }
  return `Approved by buildd reviewer (confidence ${(out.confidence ?? 0).toFixed(2)}): ${out.summary ?? ''}`;
}

/**
 * The next try's key, in the chain `key` belongs to. A chain is its first key's
 * prefix plus the try number: `push_recovery:{d}:{L}:{n}` for the chain the
 * attempt's end started, `push_recovery:{d}:{L}:head:{H}:{n}` for the one an
 * unproven head restarted (its first key carries no number). 9e27996d: numbering
 * the restart's follow-ups in the original chain collided with tries that chain
 * had already spent, so the insert was a no-op and recovery ended silently.
 */
export function pushRecoveryFollowupKey(key: string, tryNo: number): string {
  const own = `:${tryNo}`;
  return key.endsWith(own) ? `${key.slice(0, -own.length)}:${tryNo + 1}` : `${key}:${tryNo + 1}`;
}

/** The novel-delta scope a composition delta round carries, for the reviewer. */
function compositionScopeOf(round: RoundSnapshot): { novelDeltaPaths: string[] } | undefined {
  const sc = round.scope;
  if (!sc?.composition || !Array.isArray(sc.novelDeltaPaths)) return undefined;
  return { novelDeltaPaths: (sc.novelDeltaPaths as unknown[]).map(String) };
}

const prUrl = (d: WithPr) => `https://github.com/${d.repoFullName}/pull/${d.prNumber}`;

const DEAD_EFFECT_COPY: Record<string, string> = {
  merge_call: 'the merge call kept failing',
  verify_merge: 'reading back the merge kept failing',
  dispatch_fix: 'filing the fix task kept failing',
  dispatch_review: 'filing the review task kept failing',
  post_review: 'posting the review to GitHub kept failing',
};

/** A team notice about a PR that needs a person. */
async function needsAttention(ports: KernelPorts, kind: string, d: WithPr, title: string, body: string): Promise<void> {
  await need(ports, 'notify', kind).team({ workspaceId: d.workspaceId, deliveryId: d.id, kind: 'needsAttention', title, body, prNumber: d.prNumber, url: prUrl(d), urlTitle: 'View PR' });
}

export function reviewHandlers(ports: KernelPorts): EffectHandlers {
  const apply = (deliveryId: string, cmd: Command) => applyCommandOn(ports.store, cmd, { ref: { deliveryId }, newId: ports.newId });
  const newId = ports.newId ?? (() => crypto.randomUUID());

  const dispatchReview: EffectHandler = async (e) => {
    const view = await ports.store.loadView({ deliveryId: e.deliveryId });
    const d = view.delivery;
    const roundId = String(e.payload.roundId ?? '');
    const round = view.rounds.find((r) => r.id === roundId);
    if (!d || !round || (round.status !== 'queued' && round.status !== 'reviewing')) return { outcome: 'skipped:round_closed' };
    if (round.reviewerTaskId) return { outcome: 'skipped:already_dispatched' };
    if (!hasPr(d)) return { outcome: 'skipped:no_pr' };
    const reviews = need(ports, 'reviews', e.kind);

    // §5.9: once per round that is not itself the composition's delta round.
    if (!round.scope?.composition) {
      const composed = await reviews.attestComposition(d, round);
      if (composed) return { outcome: composed };
    }

    // A delta round reviews the change since the last decided verdict.
    let priorVerdict: Record<string, unknown> | undefined;
    if (round.kind === 'delta') {
      const prior = view.rounds.filter((r) => r.status === 'decided' && r.round < round.round).sort((a, b) => b.round - a.round)[0];
      if (prior && prior.headSha !== round.headSha) {
        const out = await reviews.output(prior);
        if (out.verdict === 'request-changes' || out.verdict === 'escalate' || out.verdict === 'approve') {
          priorVerdict = {
            headSha: prior.headSha, verdict: out.verdict, confidence: out.confidence ?? 0,
            summary: out.summary ?? '', feedback: out.feedback ?? null, escalationReason: out.escalationReason ?? null,
          };
        }
      }
    }

    const work = need(ports, 'work', e.kind);
    const filed = await work.file({
      role: 'review',
      workspaceId: d.workspaceId,
      target: { repoFullName: d.repoFullName, prNumber: d.prNumber, headSha: round.headSha, baseRef: d.baseRef },
      lineage: { deliveryId: d.id, parentTaskId: d.ownerTaskId },
      dedupeKey: `review:${round.id}`,
      detail: {
        roundId: round.id, round: round.round, maxRounds: d.maxRounds,
        ...(priorVerdict ? { priorVerdict } : {}), ...(compositionScopeOf(round) ? { compositionScope: compositionScopeOf(round) } : {}),
      },
    });
    if (filed.skipped === NO_ROLE) {
      // No role can run the review: the round cannot be served (T27 → review_unavailable).
      await apply(d.id, { type: 'ReviewRoundFailed', actor: 'kernel', roundId, reason: 'infra', maxContractRetries: 0 });
      return { outcome: 'skipped:no_reviewer_role' };
    }
    if (filed.skipped || !filed.taskId) return { outcome: `skipped:${filed.skipped ?? 'dispatch_refused'}` };
    await ports.store.linkRoundReviewer(round.id, filed.taskId);
    await work.cancelPending({ deliveryId: d.id, role: 'review', keepTaskId: filed.taskId, ...superseded(`round ${round.round} superseded it`) });
    // Not created: another door's live reviewer already covers this head, and the host adopted it as the round's.
    if (!filed.created) return { outcome: 'ok:adopted_live_reviewer' };
    await work.wake(filed.taskId, 'task.created');
    return { outcome: 'ok' };
  };

  const dispatchFix: EffectHandler = async (e) => {
    let view = await ports.store.loadView({ deliveryId: e.deliveryId });
    const d = view.delivery;
    if (!d || d.state !== 'CHANGES_REQUESTED') return { outcome: 'skipped:state_moved' };
    if (!hasPr(d)) return { outcome: 'skipped:no_pr' };
    const roundId = (e.payload.roundId as string | null) ?? view.rounds.find((r) => r.round === d.currentRound)?.id ?? null;
    const round = view.rounds.find((r) => r.id === roundId);
    if (!round) return { outcome: 'skipped:no_round' };
    const reader = await githubOf(ports, d.workspaceId);
    if (!reader) throw new Error(NO_INSTALLATION);

    // T23: a person's apply/request-changes on an escalation (§5.7 rule 5, trigger=human).
    const human = e.payload.trigger === 'human';
    const humanInstructions = typeof e.payload.humanInstructions === 'string' && e.payload.humanInstructions.trim() ? e.payload.humanInstructions.trim() : null;
    const humanActor = typeof e.payload.actor === 'string' ? e.payload.actor : null;
    const openFix = () => view.attempts.find((a) => a.family === 'review_fix' && a.triggerReason === round.id && (a.status === 'queued' || a.status === 'running'));
    let attempt = openFix();
    if (!attempt) {
      const live = await reader.readPr(d.repoFullName, d.prNumber);
      if (!live) throw new Error('live PR read failed');
      const newerApprove = view.rounds.some((r) => r.round > round.round && r.status === 'decided' && r.effectiveVerdict === 'approve');
      const res = await apply(d.id, {
        type: 'FixDispatched', actor: 'kernel', roundId: round.id, taskId: newId(), maxAttempts: d.maxRounds,
        ...(human ? { trigger: 'human' as const } : {}),
        revalidation: { live, newerApprove },
      });
      if (res.result === 'rejected' || res.result === 'stale') return { outcome: `skipped:${res.reason}` };
      // A spent fix ledger escalates in T8 itself (67d34094): no task to file.
      if (res.result === 'applied' && res.decision?.toState === 'ESCALATED') return { outcome: 'ok:escalated_budget_exhausted' };
      view = await ports.store.loadView({ deliveryId: d.id });
      attempt = openFix();
      if (!attempt) return { outcome: 'skipped:no_open_attempt' };
    }
    const taskId = attempt.taskId;
    if (!taskId) return { outcome: 'skipped:attempt_has_no_task' };
    // The (workspace, PR, head) dedupe allows one row per head; a second
    // attempt on the same head (the first one failed) is deduped by the ledger.
    const boundHead = attempt.boundHeadSha;
    const firstAtHead = view.attempts.filter((a) => a.family === 'review_fix' && a.boundHeadSha === boundHead).length <= 1;
    const work = need(ports, 'work', e.kind);
    const filed = await work.file({
      role: 'fix',
      workspaceId: d.workspaceId,
      taskId,
      target: { repoFullName: d.repoFullName, prNumber: d.prNumber, headSha: boundHead, baseRef: d.baseRef },
      lineage: { deliveryId: d.id, attemptId: attempt.id, parentTaskId: d.ownerTaskId },
      dedupeKey: `fix:${attempt.id}`,
      detail: {
        roundId: round.id, reviewerTaskId: round.reviewerTaskId ?? null, attemptNo: attempt.attemptNo, maxAttempts: attempt.maxAttempts, firstAtHead,
        ...(human ? { trigger: 'human', humanInstructions, actor: humanActor } : {}),
      },
    });
    if (filed.skipped) return { outcome: `skipped:${filed.skipped}` };
    if (!filed.created || !filed.taskId) return { outcome: 'ok:task_exists' };
    await work.wake(filed.taskId, 'review.fix_requested');
    return { outcome: 'ok' };
  };

  const postReview: EffectHandler = async (e) => {
    const view = await ports.store.loadView({ deliveryId: e.deliveryId });
    const d = view.delivery;
    const round = view.rounds.find((r) => r.id === e.payload.roundId);
    if (!hasPr(d) || !round) return { outcome: 'skipped:no_round' };
    const writes = (await githubOf(ports, d.workspaceId))?.writes;
    if (!writes) return { outcome: 'skipped:no_installation' };
    const reviews = need(ports, 'reviews', e.kind);
    const out = await reviews.output(round);
    const event = e.payload.event === 'APPROVE' ? 'APPROVE' : 'REQUEST_CHANGES';
    const res = await writes.postReview({
      repoFullName: d.repoFullName, prNumber: d.prNumber,
      // §8.4: commit_id is the round's head, never whatever the PR shows now.
      commitId: String(e.payload.commitId ?? round.headSha),
      event,
      body: postReviewBody(event, out, e.payload.scope),
    }).catch((err: unknown): PostedReview => ({ id: null, posted: false, reason: err instanceof Error ? err.message : 'unknown error' }));
    if (res.posted === false && res.reason !== 'a matching review already exists for this commit') {
      await reviews.postFailed(d, { event, reason: res.reason ?? 'unknown error' });
      return { outcome: `failed_post:${res.reason ?? 'unknown'}` };
    }
    return { outcome: res.commentedOwnPr ? 'ok:commented_own_pr' : 'ok' };
  };

  const missionNote: EffectHandler = async (e) => {
    if (e.payload.reason !== 'review_escalated') return { outcome: 'skipped:legacy_owns' };
    const view = await ports.store.loadView({ deliveryId: e.deliveryId });
    const d = view.delivery;
    if (!hasPr(d)) return { outcome: 'skipped:no_pr' };
    await need(ports, 'reviews', e.kind).escalated(d, view.rounds.find((r) => r.id === e.payload.roundId) ?? null);
    return { outcome: 'ok' };
  };

  const notify: EffectHandler = async (e) => {
    const event = e.payload.event;
    if (event !== 'policy_human' && event !== 'push_undeliverable' && event !== 'effect_dead' && event !== 'landing_needs_human') return { outcome: 'skipped:no_channel' };
    const d = (await ports.store.loadView({ deliveryId: e.deliveryId })).delivery;
    if (!hasPr(d)) return { outcome: 'skipped:no_pr' };
    if (event === 'policy_human') {
      // T28: the one admission point for a pre-flight finding. The delivery is ESCALATED(policy_human)
      // at this head, so Home (needsYou) and this notice agree; a finding for an older head never gets here.
      if (d.state !== 'ESCALATED' || d.currentHeadSha !== e.payload.headSha) return { outcome: 'skipped:state_moved' };
      await needsAttention(ports, e.kind, d, `PR #${d.prNumber} needs a person`, String(e.payload.reason ?? 'workspace policy requires human review'));
      return { outcome: 'ok' };
    }
    if (event === 'landing_needs_human') {
      await needsAttention(ports, e.kind, d, `PR #${d.prNumber}: landing needs a person`, String(e.payload.detail ?? 'the platform could not bring the branch up to date'));
      return { outcome: 'ok' };
    }
    if (event === 'effect_dead') {
      // §10.3: a critical effect went dead and the delivery escalated (67d34094).
      const what = DEAD_EFFECT_COPY[String(e.payload.effectKind)] ?? `the ${String(e.payload.effectKind)} step kept failing`;
      await needsAttention(ports, e.kind, d, `PR #${d.prNumber} needs a person: ${what}`,
        `buildd retried ${what.replace(' kept failing', '')} until it gave up, so nothing will move this PR on its own. Check the PR and land or re-run it.`);
      return { outcome: 'ok' };
    }
    const local = (e.payload.localHeadSha as string | null) ?? null;
    await needsAttention(ports, e.kind, d, `PR #${d.prNumber}: a fix never reached GitHub`,
      `The fix attempt ended but the PR head is still ${d.currentHeadSha?.slice(0, 7) ?? 'unchanged'}${local ? `; its local commit was ${local.slice(0, 7)}` : ''}. Push the branch or re-run the fix.`);
    return { outcome: 'ok' };
  };

  const pushRecovery: EffectHandler = async (e) => {
    const d = (await ports.store.loadView({ deliveryId: e.deliveryId })).delivery;
    if (!d || d.state !== 'AWAITING_PUSH') return { outcome: 'skipped:state_moved' };
    if (!hasPr(d)) return { outcome: 'skipped:no_pr' };
    const reader = await githubOf(ports, d.workspaceId);
    if (!reader) throw new Error(NO_INSTALLATION);
    const live = await reader.readPr(d.repoFullName, d.prNumber);
    if (live && live.headSha !== d.currentHeadSha) {
      // A head arrived that the webhook did not deliver: T3 decides whether it is proof.
      await need(ports, 'ingest', e.kind).ingest({ kind: 'head_observed', workspaceId: d.workspaceId, source: 'effect:push_recovery', repoFullName: d.repoFullName, prNumber: d.prNumber }, reader);
      return { outcome: 'ok:head_observed' };
    }
    const tryNo = Number(e.payload.try ?? 1);
    const maxTries = Number(e.payload.maxTries ?? 3);
    const local = (e.payload.localHeadSha as string | null) ?? null;
    if (tryNo < maxTries) {
      const inserted = await ports.store.insertFollowupEffect({
        deliveryId: d.id, transitionId: e.transitionId, kind: 'push_recovery',
        dedupeKey: pushRecoveryFollowupKey(e.dedupeKey, tryNo),
        payload: { ...e.payload, try: tryNo + 1 },
        delayMs: PUSH_RECOVERY_BACKOFF_MS[Math.min(tryNo, PUSH_RECOVERY_BACKOFF_MS.length - 1)],
      });
      // The next try already exists (a redelivery of this one): this run scheduled nothing, so it
      // must not read as the chain moving on. A chain left with no live try is the floor's (§11).
      if (!inserted) return { outcome: `skipped:retry_${tryNo + 1}_exists` };
      return { outcome: `ok:retry_${tryNo + 1}` };
    }
    await apply(d.id, { type: 'PushRecoveryExhausted', actor: 'effect:push_recovery', localHeadSha: local });
    return { outcome: 'ok:exhausted' };
  };

  // Nothing emits these two yet: acknowledged, so a transition that names them never retries forever.
  const legacyOwns: EffectHandler = async () => ({ outcome: 'skipped:legacy_owns' });

  return {
    dispatch_review: dispatchReview, dispatch_fix: dispatchFix, post_review: postReview, mission_note: missionNote,
    notify, push_recovery: pushRecovery, release_attribution: legacyOwns, gate_event: legacyOwns,
  };
}

const superseded = (reason: string) => ({ reason, summary: `Superseded before it started: ${reason}` });

/** `cancel_open_attempts` for the review loop (a moved head, an approval); anything else is legacy's. */
export async function cancelReviewAttempts(ports: KernelPorts, e: ClaimedEffect): Promise<{ outcome: string }> {
  const d = (await ports.store.loadView({ deliveryId: e.deliveryId })).delivery;
  if (!hasPr(d)) return { outcome: 'skipped:no_pr' };
  const reason = e.payload.reason;
  if (reason === 'head_moved') {
    const families = Array.isArray(e.payload.families) ? (e.payload.families as string[]) : ['review_fix'];
    const role = families.includes('ci') ? 'ci_fix' : families.includes('conflict') || families.includes('migration') ? 'conflict_fix' : 'fix';
    const n = await need(ports, 'work', e.kind).cancelPending({ deliveryId: d.id, role, ...superseded('the PR head moved before the fix started') });
    return { outcome: `ok:cancelled_${n}` };
  }
  if (reason === 'approved') {
    if (!(await githubOf(ports, d.workspaceId))) return { outcome: 'skipped:no_installation' };
    await need(ports, 'reviews', e.kind).supersedeFixOnApproval(d);
    await need(ports, 'work', e.kind).cancelPending({ deliveryId: d.id, role: 'fix', ...superseded('the PR was approved') });
    return { outcome: 'ok' };
  }
  // Merge / close cancellations: the legacy supersession rules still run them.
  return { outcome: 'skipped:legacy_owns' };
}

/** `escalate_exhaustion` for family `review_fix`: the rounds, or the fix ledger, ran out. */
export async function escalateReviewExhaustion(ports: KernelPorts, e: ClaimedEffect, d: DeliverySnapshot | null, rounds: RoundSnapshot[]): Promise<{ outcome: string }> {
  if (!hasPr(d) || !d.currentHeadSha) return { outcome: 'skipped:no_pr' };
  const current = rounds.find((r) => r.round === d.currentRound);
  const out: ReviewOutput = current ? await need(ports, 'reviews', e.kind).output(current) : {};
  // A fix ledger spent before the rounds were (T8, 67d34094) says so; otherwise the rounds ran out.
  const detail = e.payload.max != null ? `after ${Number(e.payload.attempts)} fix attempts` : `after ${d.currentRound} review rounds`;
  const outcome = await need(ports, 'escalate', e.kind).exhausted(d, {
    family: 'review_fix', headSha: d.currentHeadSha, attempts: Number(e.payload.attempts ?? d.currentRound), max: Number(e.payload.max ?? d.maxRounds),
    title: 'Review fix attempts exhausted', detail, note: out.feedback ?? null,
  });
  return { outcome };
}
