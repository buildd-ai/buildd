/**
 * The review verdict is the kernel's, bound to the commit and round it judged
 * (docs/specs/workflow-state-kernel.md §8; docs/specs/pr-lifecycle-reconciliation.md).
 * The GitHub review is a record of it, not the source: the App opens the PRs it
 * reviews, so GitHub shows every review as COMMENTED whatever it says.
 *
 * These tests drive the reducer through repeated review cycles, folding each
 * decision into the view, and ask the landing gate at every step.
 */
import { describe, expect, test } from 'bun:test';
import type { ApplyDecision, Command, Decision, LivePr } from './commands';
import { postReviewBody } from './handlers/review';
import { landingStatusOf, reviewGate } from './landing-gate';
import { reduce } from './reducer';
import type { DeliverySnapshot, KernelView, RoundSnapshot } from './types';

const REPO = 'acme/widgets';
const live = (headSha: string): LivePr => ({ state: 'open', merged: false, headSha, headRepoFullName: REPO, baseRef: 'dev' });
let seq = 0;
const newId = () => `id${++seq}`;

const start = (): KernelView => ({
  delivery: {
    id: 'd1', workspaceId: 'w1', ownerTaskId: 't1', repoFullName: REPO, prNumber: 7, baseRef: 'dev',
    state: 'AWAITING_REVIEW', stateReason: null, version: 5, currentHeadSha: 'A'.repeat(40), currentRound: 1, maxRounds: 9,
    boundAttemptId: null, resumeState: null, trunkIncidentId: null, approvedHeads: [], approvalBasis: null,
    compositionHeads: [], ci: null, ciHeadSha: null, mergeable: null, mergeableHeadSha: null, mergedAt: null,
    mergeCommitSha: null, supersededByPr: null,
  },
  rounds: [{ id: 'r1', round: 1, headSha: 'A'.repeat(40), kind: 'full', status: 'reviewing', verdict: null, effectiveVerdict: null, failureCount: 0 }],
  attempts: [],
});

/** Fold an applied decision into the view the way the store would. */
function fold(view: KernelView, dec: Decision): KernelView {
  if (dec.result !== 'apply') return view;
  const a = dec as ApplyDecision;
  const d = { ...view.delivery!, ...a.patch, state: a.toState, version: view.delivery!.version + 1 } as DeliverySnapshot;
  let rounds = view.rounds.map((r) => ({ ...r }));
  for (const op of a.rounds) {
    if (op.op === 'insert') {
      rounds.push({ id: op.id, round: op.round, headSha: op.headSha, kind: op.kind, status: 'queued', verdict: null, effectiveVerdict: null, failureCount: 0 } as RoundSnapshot);
      d.currentRound = op.round;
    } else {
      rounds = rounds.map((r) => (r.id === op.roundId ? { ...r, ...op.set } as RoundSnapshot : r));
    }
  }
  return { ...view, delivery: d, rounds };
}

const step = (v: KernelView, cmd: Command): { view: KernelView; dec: Decision } => {
  const dec = reduce(v, cmd, { newId });
  return { view: fold(v, dec), dec };
};
const verdict = (roundId: string, head: string, v: 'approve' | 'request_changes'): Command =>
  ({ type: 'ReviewVerdictRecorded', actor: 'reviewer', roundId, verdict: v, effectiveVerdict: v, headBound: head });
const push = (head: string): Command => ({ type: 'HeadObserved', actor: 'webhook', hintedHeadSha: head, live: live(head) });
const roundAt = (v: KernelView, head: string) => v.rounds.filter((r) => r.headSha === head).sort((a, b) => b.round - a.round)[0]!;

const A = 'A'.repeat(40);
const B = 'B'.repeat(40);
const C = 'C'.repeat(40);

describe('approved, then a new commit, then a blocking finding', () => {
  test('the approval covers only its commit; the new head is not mergeable; the blocking verdict withdraws the claim', () => {
    let { view } = step(start(), verdict('r1', A, 'approve'));
    expect(view.delivery!.state).toBe('APPROVED');
    expect(reviewGate(view)).toMatchObject({ ok: true });

    // A new commit: the approval of A does not cover B, and the status says so.
    ({ view } = step(view, push(B)));
    expect(view.delivery!.currentHeadSha).toBe(B);
    expect(reviewGate(view)).toMatchObject({ ok: false });
    const pending = landingStatusOf(view)!;
    expect(pending.state).toBe('pending');
    expect(pending.description).toContain('approval of AAAAAAA does not cover it');

    // The review of B finds a blocking issue.
    const r2 = roundAt(view, B);
    const { view: after, dec } = step(view, verdict(r2.id, B, 'request_changes'));
    expect(dec.result).toBe('apply');
    expect(after.delivery!.state).toBe('CHANGES_REQUESTED');
    expect(reviewGate(after)).toMatchObject({ ok: false });
    const status = landingStatusOf(after)!;
    expect(status.state).toBe('failure');
  });

  test('a request for changes at the commit that was approved withdraws that approval', () => {
    let { view } = step(start(), verdict('r1', A, 'approve'));
    expect(view.delivery!.approvedHeads).toEqual([A]);
    // A forced re-review of the same commit finds what the first one missed.
    view = { ...view, delivery: { ...view.delivery!, state: 'AWAITING_REVIEW', currentRound: 2 }, rounds: [...view.rounds, { id: 'r2', round: 2, headSha: A, kind: 'full', status: 'reviewing', verdict: null, effectiveVerdict: null, failureCount: 0 }] };
    const { view: after, dec } = step(view, verdict('r2', A, 'request_changes'));
    expect(dec.result).toBe('apply');
    expect(after.delivery!.approvedHeads).toEqual([]);
    expect(after.delivery!.approvalBasis).toBeNull();
    expect((dec as ApplyDecision).evidence.withdrewApproval).toMatchObject({ headSha: A, byRoundId: 'r2' });
    expect(reviewGate(after)).toMatchObject({ ok: false });
    expect(landingStatusOf(after)!.description).toContain('supersedes the approval of AAAAAAA');
  });

  test('a person\'s own approval is not withdrawn by a reviewer\'s later verdict', () => {
    const v0 = start();
    const view: KernelView = {
      ...v0,
      delivery: { ...v0.delivery!, approvedHeads: [A], approvalBasis: 'human' },
    };
    const { dec } = step(view, verdict('r1', A, 'request_changes'));
    expect((dec as ApplyDecision).patch.approvedHeads).toBeUndefined();
  });
});

describe('repeated review cycles', () => {
  test('approve → push → block → fix → approve: only the final commit lands, and nothing in between does', () => {
    const gate: boolean[] = [];
    let { view } = step(start(), verdict('r1', A, 'approve'));
    gate.push(reviewGate(view).ok);                      // A approved
    ({ view } = step(view, push(B)));
    gate.push(reviewGate(view).ok);                      // B unreviewed
    ({ view } = step(view, verdict(roundAt(view, B).id, B, 'request_changes')));
    gate.push(reviewGate(view).ok);                      // B blocked
    ({ view } = step(view, push(C)));
    gate.push(reviewGate(view).ok);                      // C unreviewed, B's block does not clear it
    ({ view } = step(view, verdict(roundAt(view, C).id, C, 'approve')));
    gate.push(reviewGate(view).ok);                      // C approved
    expect(gate).toEqual([true, false, false, false, true]);
    expect(view.delivery!.approvedHeads).toEqual([C]);
    // The approval of the first commit never covered the last.
    expect(reviewGate(view, { headSha: A })).toMatchObject({ ok: false, blocker: 'head_moved' });
  });

  test('a stale verdict for an older head changes nothing', () => {
    const { view } = step(start(), push(B));
    const stale = reduce(view, verdict('r1', A, 'approve'), { newId });
    expect(stale.result).not.toBe('apply');
    const after = fold(view, stale);
    expect(after.delivery!.approvedHeads).not.toContain(B);
    expect(reviewGate(after)).toMatchObject({ ok: false });
  });
});

describe('no unauthorized merge', () => {
  test('LandingRequested is refused on every head the review did not approve, and on an approved head with a blocking verdict', () => {
    const land = (v: KernelView, head: string) =>
      reduce(v, { type: 'LandingRequested', actor: 'kernel', door: 'auto', headSha: head, live: live(head), rails: { passed: true } }, { newId });
    let { view } = step(start(), verdict('r1', A, 'approve'));
    expect(land(view, A).result).toBe('apply');

    ({ view } = step(view, push(B)));
    expect(land(view, B).result).not.toBe('apply');

    ({ view } = step(view, verdict(roundAt(view, B).id, B, 'request_changes')));
    expect(land(view, B).result).not.toBe('apply');
    expect(land(view, A).result).not.toBe('apply');
  });
});

describe('the GitHub review body carries findings only', () => {
  const out = { confidence: 0.85, summary: 'Looks right.', feedback: 'resume re-starts hand-paused agents' };

  test('a request for changes is the findings alone, with no internal diagnostics', () => {
    const body = postReviewBody(out);
    expect(body).toBe('resume re-starts hand-paused agents');
    expect(body).not.toMatch(/buildd verdict|confidence|round \d|head [0-9A-Fa-f]{7}|approval|scope|manifest|GitHub does not/i);
  });

  test('an empty finding still says something actionable-neutral rather than posting a blank body', () => {
    expect(postReviewBody({ feedback: '  ', summary: null })).toBe('Changes requested. See the task for details.');
  });
});
