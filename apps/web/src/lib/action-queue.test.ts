import { describe, it, expect } from 'bun:test';
import { buildActionQueue, buildDecideItems, buildDiscrepancyItems, partitionEscalations, isActionableChip, isDocFixClaimStale, summariseActionQueueAge, DOC_FIX_RECHECK_GRACE_MS } from './action-queue';
import type { WaitingOnYouRawItem, EscalationRawItem, ResolvedEscalationItem, EscalatedMissionCandidate, DiscrepancyCandidate } from './action-queue';

const PR_URL_A = 'https://github.com/org/repo/pull/1480';
const PR_URL_B = 'https://github.com/org/repo/pull/1481';

// Defaults represent a fresh, just-opened, just-verified PR — the shape Home
// always supplies in production. The dedicated "freshness invariant" describe
// block below overrides these explicitly to exercise staleness; every other
// test should be unaffected by the freshness gate, same as before AC-6 closed
// the opt-out hole (omitting these fields used to opt a row out entirely —
// now that reads as "no age, no verification", which fails closed).
function mergeItem(overrides?: Partial<WaitingOnYouRawItem>): WaitingOnYouRawItem {
  return {
    kind: 'merge',
    prUrl: PR_URL_A,
    prNumber: 1480,
    upstreamTaskId: 'task-1',
    upstreamTaskTitle: 'feat: subject anchors',
    unblockCount: 3,
    missionId: 'mission-1',
    missionTitle: 'Mission Alpha',
    prOpenedAt: new Date(),
    prLifecycleVerifiedAt: new Date(),
    ...overrides,
  };
}

function escalationItem(overrides?: Partial<EscalationRawItem>): EscalationRawItem {
  return {
    workerId: 'worker-1',
    taskId: 'task-1',
    taskTitle: 'feat: subject anchors',
    workspaceId: 'ws-1',
    workspaceName: 'buildd',
    prNumber: 1480,
    prUrl: PR_URL_A,
    policyTier: 'human',
    escalationReason: 'Human Gate — manual merge required',
    waitingMinutes: 15,
    prOpenedAt: new Date(),
    prLifecycleVerifiedAt: new Date(),
    ...overrides,
  };
}

describe('buildActionQueue', () => {
  it('deduplicates a PR in both waitingOnYou and escalationInbox into one card', () => {
    const result = buildActionQueue([mergeItem()], [escalationItem()]);
    expect(result).toHaveLength(1);
    expect(result[0].chip).toBe('MERGE');
    expect(result[0].prNumber).toBe(1480);
  });

  it('merged card carries unblockCount from waitingOnYou and task context from escalation', () => {
    const result = buildActionQueue([mergeItem()], [escalationItem()]);
    expect(result[0].unblockCount).toBe(3);
    expect(result[0].escalationReason).toBe('Human Gate — manual merge required');
    expect(result[0].waitingMinutes).toBe(15);
    expect(result[0].taskId).toBe('task-1');
  });

  it('emits separate cards for different PRs', () => {
    const woy: WaitingOnYouRawItem[] = [
      mergeItem({ prUrl: PR_URL_A, prNumber: 1480, upstreamTaskId: 'u1' }),
    ];
    const esc: EscalationRawItem[] = [
      escalationItem({ prUrl: PR_URL_B, prNumber: 1481, taskId: 'task-2' }),
    ];
    const result = buildActionQueue(woy, esc);
    expect(result).toHaveLength(2);
  });

  it('assigns REVIEW chip to agent-review policy tier', () => {
    const result = buildActionQueue([], [escalationItem({ policyTier: 'agent-review' })]);
    expect(result[0].chip).toBe('REVIEW');
  });

  it('assigns MERGE chip to human policy tier', () => {
    const result = buildActionQueue([], [escalationItem({ policyTier: 'human' })]);
    expect(result[0].chip).toBe('MERGE');
  });

  it('orders MERGE → REVIEW → QUESTION → APPROVE', () => {
    const woy: WaitingOnYouRawItem[] = [
      { kind: 'approve', taskId: 'plan-1', taskTitle: 'Plan A' },
      { kind: 'answer', workerId: 'w-1', taskId: 'task-q', taskTitle: 'Q Task', question: 'Is X ready?' },
      mergeItem({ prUrl: 'https://github.com/org/repo/pull/5', prNumber: 5, upstreamTaskId: 'u5' }),
    ];
    const esc: EscalationRawItem[] = [
      escalationItem({
        prUrl: 'https://github.com/org/repo/pull/10',
        prNumber: 10,
        taskId: 'task-r',
        policyTier: 'agent-review',
      }),
    ];
    const result = buildActionQueue(woy, esc);
    expect(result.map(r => r.chip)).toEqual(['MERGE', 'REVIEW', 'QUESTION', 'APPROVE']);
  });

  it('sorts MERGE items by unblockCount descending', () => {
    const woy: WaitingOnYouRawItem[] = [
      mergeItem({ prUrl: 'https://github.com/org/repo/pull/1', prNumber: 1, upstreamTaskId: 'u1', unblockCount: 1 }),
      mergeItem({ prUrl: 'https://github.com/org/repo/pull/2', prNumber: 2, upstreamTaskId: 'u2', unblockCount: 5 }),
    ];
    const result = buildActionQueue(woy, []);
    expect(result[0].prNumber).toBe(2);
    expect(result[1].prNumber).toBe(1);
  });

  it('returns empty array for empty inputs', () => {
    expect(buildActionQueue([], [])).toHaveLength(0);
  });

  it('does not overwrite escalation item with approve item sharing same task key', () => {
    const woy: WaitingOnYouRawItem[] = [
      { kind: 'approve', taskId: 'task-1', taskTitle: 'Plan A' },
    ];
    const esc: EscalationRawItem[] = [
      escalationItem({ taskId: 'task-1', prUrl: null, prNumber: null }),
    ];
    const result = buildActionQueue(woy, esc);
    expect(result).toHaveLength(1);
    expect(result[0].chip).toBe('MERGE');
  });

  it('includes missionTitle from waitingOnYou in merged card', () => {
    const result = buildActionQueue(
      [mergeItem({ missionTitle: 'Alpha' })],
      [escalationItem({ escalationReason: null })],
    );
    expect(result[0].missionTitle).toBe('Alpha');
  });

  it('preserves escalation missionTitle when both are set', () => {
    // escalation does not carry missionTitle, so waitingOnYou value wins
    const result = buildActionQueue(
      [mergeItem({ missionTitle: 'Upstream Mission' })],
      [escalationItem()],
    );
    expect(result[0].missionTitle).toBe('Upstream Mission');
  });

  it('standalone QUESTION item is included with correct fields', () => {
    const woy: WaitingOnYouRawItem[] = [
      { kind: 'answer', workerId: 'w-2', taskId: 'tq', taskTitle: 'Check deploy', question: 'Is prod green?' },
    ];
    const result = buildActionQueue(woy, []);
    expect(result).toHaveLength(1);
    expect(result[0].chip).toBe('QUESTION');
    expect(result[0].question).toBe('Is prod green?');
    expect(result[0].taskId).toBe('tq');
  });

  it('standalone APPROVE item is included with correct fields', () => {
    const woy: WaitingOnYouRawItem[] = [
      { kind: 'approve', taskId: 'plan-99', taskTitle: 'Migration plan' },
    ];
    const result = buildActionQueue(woy, []);
    expect(result).toHaveLength(1);
    expect(result[0].chip).toBe('APPROVE');
    expect(result[0].taskId).toBe('plan-99');
  });

  it('escalation item without PR gets key task:<taskId>', () => {
    const esc: EscalationRawItem[] = [
      escalationItem({ prUrl: null, prNumber: null, taskId: 'task-no-pr' }),
    ];
    const result = buildActionQueue([], esc);
    expect(result).toHaveLength(1);
    expect(result[0].prUrl).toBeUndefined();
  });

  it('passes prLifecycleStatus=merged through to ActionQueueItem', () => {
    const result = buildActionQueue([mergeItem({ prLifecycleStatus: 'merged' })], []);
    expect(result[0].prLifecycleStatus).toBe('merged');
  });

  it('passes prLifecycleStatus=closed through to ActionQueueItem', () => {
    const result = buildActionQueue([mergeItem({ prLifecycleStatus: 'closed' })], []);
    expect(result[0].prLifecycleStatus).toBe('closed');
  });

  it('leaves prLifecycleStatus undefined when not set on merge item', () => {
    const result = buildActionQueue([mergeItem()], []);
    expect(result[0].prLifecycleStatus).toBeUndefined();
  });

  it('preserves prLifecycleStatus when merging waitingOnYou into existing escalation item', () => {
    const result = buildActionQueue(
      [mergeItem({ prLifecycleStatus: 'merged' })],
      [escalationItem()],
    );
    expect(result[0].prLifecycleStatus).toBe('merged');
  });
});

// ── partitionEscalations ────────────────────────────────────────────────────

function baseResolved(overrides?: Partial<ResolvedEscalationItem>): ResolvedEscalationItem {
  return {
    workerId: 'w-1',
    taskId: 't-1',
    taskTitle: 'feat: some change',
    prNumber: 42,
    prUrl: 'https://github.com/org/repo/pull/42',
    prLifecycleStatus: 'merged',
    workspaceName: 'buildd',
    ...overrides,
  };
}

describe('buildActionQueue — reconnect items', () => {
  const reconnect = (over: Partial<WaitingOnYouRawItem> = {}): WaitingOnYouRawItem => ({
    kind: 'reconnect',
    connectorId: 'c-1',
    connectorName: 'Cue',
    ...over,
  });

  it('turns an expired connector into a RECONNECT item', () => {
    const [item] = buildActionQueue([reconnect()], []);
    expect(item.chip).toBe('RECONNECT');
    expect(item.connectorId).toBe('c-1');
    expect(item.connectorName).toBe('Cue');
    expect(item.subjectKey).toBe('connector:c-1');
  });

  it('dedupes repeated reports of the same connector', () => {
    const queue = buildActionQueue([reconnect(), reconnect()], []);
    expect(queue).toHaveLength(1);
  });

  it('ranks RECONNECT above REVIEW/QUESTION but below MERGE', () => {
    const queue = buildActionQueue(
      [
        { kind: 'answer', workerId: 'w-1', taskId: 't-1', taskTitle: 'q', question: 'why?' },
        reconnect(),
        { kind: 'merge', prUrl: 'https://github.com/x/y/pull/1', prNumber: 1, prOpenedAt: new Date(), prLifecycleVerifiedAt: new Date() },
      ],
      [],
    );
    expect(queue.map(i => i.chip)).toEqual(['MERGE', 'RECONNECT', 'QUESTION']);
  });

  it('keeps one item per connector', () => {
    const queue = buildActionQueue(
      [
        reconnect({ connectorId: 'c-a', connectorName: 'Alpha' }),
        reconnect({ connectorId: 'c-b', connectorName: 'Beta' }),
      ],
      [],
    );
    expect(queue.map(i => i.connectorName)).toEqual(['Alpha', 'Beta']);
  });

  it('does not collide with task- or PR-keyed items', () => {
    const queue = buildActionQueue([reconnect({ connectorId: 't-1' })], [
      {
        workerId: 'w-1',
        taskId: 't-1',
        taskTitle: 'Task one',
        workspaceId: 'ws-1',
        workspaceName: 'buildd',
        prNumber: null,
        prUrl: null,
        policyTier: 'human-gate',
        escalationReason: null,
        waitingMinutes: 5,
      },
    ]);
    expect(queue).toHaveLength(2);
  });
});

describe('buildDecideItems + buildActionQueue — decide items', () => {
  const candidate = (overrides?: Partial<EscalatedMissionCandidate>): EscalatedMissionCandidate => ({
    missionId: 'mission-99',
    missionTitle: 'Mission Gamma',
    criteriaEscalatedAt: new Date(),
    criteriaRearmFingerprint: 'fail|description:abc123',
    openNote: {
      id: 'note-1',
      title: 'Goal criteria blocked — owner decision needed',
      body: 'Blocking criteria:\n- [fail] Design doc exists',
    },
    status: 'active',
    criteriaOverallVerdict: 'fail',
    ...overrides,
  });

  it('an escalated mission with an open question note produces exactly one decide card', () => {
    const items = buildDecideItems([candidate()]);
    const queue = buildActionQueue(items, []);
    expect(queue).toHaveLength(1);
    expect(queue[0].chip).toBe('DECIDE');
    expect(queue[0].missionId).toBe('mission-99');
    expect(queue[0].noteId).toBe('note-1');
  });

  it('a re-worded verdict with the same fingerprint does not produce a second card', () => {
    const items = [
      ...buildDecideItems([candidate()]),
      ...buildDecideItems([candidate({
        openNote: {
          id: 'note-1',
          title: 'Goal criteria blocked — owner decision needed',
          body: 'Blocking criteria:\n- [fail] the design document must exist', // reworded evidence
        },
      })]),
    ];
    const queue = buildActionQueue(items, []);
    expect(queue).toHaveLength(1);
  });

  it('clearing criteriaEscalatedAt removes it', () => {
    const items = buildDecideItems([candidate({ criteriaEscalatedAt: null })]);
    expect(items).toHaveLength(0);
    expect(buildActionQueue(items, [])).toHaveLength(0);
  });

  it('a mission with an open question note but no escalation produces none', () => {
    const items = buildDecideItems([candidate({ criteriaEscalatedAt: null, openNote: {
      id: 'note-2', title: 'Some other question', body: 'unrelated',
    } })]);
    expect(items).toHaveLength(0);
  });

  it('an escalation with no open note produces none — the note may have been answered', () => {
    const items = buildDecideItems([candidate({ openNote: null })]);
    expect(items).toHaveLength(0);
  });

  it('an escalated + completed mission produces zero decide items — the flag outlived the mission', () => {
    const items = buildDecideItems([candidate({ status: 'completed' })]);
    expect(items).toHaveLength(0);
    expect(buildActionQueue(items, [])).toHaveLength(0);
  });

  it('an escalated + archived mission produces zero decide items', () => {
    const items = buildDecideItems([candidate({ status: 'archived' })]);
    expect(items).toHaveLength(0);
  });

  it('an escalated mission whose verdict now passes produces zero decide items', () => {
    const items = buildDecideItems([candidate({ criteriaOverallVerdict: 'pass' })]);
    expect(items).toHaveLength(0);
    expect(buildActionQueue(items, [])).toHaveLength(0);
  });

  it('an escalated + active + failing-verdict mission with an open note still produces exactly one card', () => {
    const items = buildDecideItems([candidate({ status: 'active', criteriaOverallVerdict: 'fail' })]);
    expect(items).toHaveLength(1);
    const queue = buildActionQueue(items, []);
    expect(queue).toHaveLength(1);
    expect(queue[0].chip).toBe('DECIDE');
  });

  it('a paused mission is still live — a decide card can still be a real ask', () => {
    const items = buildDecideItems([candidate({ status: 'paused' })]);
    expect(items).toHaveLength(1);
  });

  it('ranks DECIDE below QUESTION but above APPROVE', () => {
    const queue = buildActionQueue([
      { kind: 'approve', taskId: 'plan-1', taskTitle: 'Plan A' },
      ...buildDecideItems([candidate()]),
      { kind: 'answer', workerId: 'w-1', taskId: 'task-q', taskTitle: 'Q Task', question: 'Is X ready?' },
    ], []);
    expect(queue.map(i => i.chip)).toEqual(['QUESTION', 'DECIDE', 'APPROVE']);
  });

  it('carries the failure-pattern recommendation through to the card', () => {
    const items = buildDecideItems([candidate({
      recommendation: 'The same machine-checked criterion has failed unchanged across every retry — the work it names likely has no owner.',
    })]);
    const queue = buildActionQueue(items, []);
    expect(queue[0].recommendation).toBe(
      'The same machine-checked criterion has failed unchanged across every retry — the work it names likely has no owner.',
    );
  });

  it('leaves recommendation null when the caller supplied none', () => {
    const items = buildDecideItems([candidate()]);
    const queue = buildActionQueue(items, []);
    expect(queue[0].recommendation ?? null).toBeNull();
  });
});

describe('isDocFixClaimStale', () => {
  it('false while the task is not completed — no completion to check against', () => {
    expect(isDocFixClaimStale({
      docFixTaskStatus: 'in_progress',
      docFixPrLifecycleStatus: 'merged',
      docFixMergedAt: new Date('2026-09-01T00:00:00Z'),
      lastCheckedAt: new Date('2026-09-02T00:00:00Z'),
    })).toBe(false);
  });

  it('false when the PR never merged — never claim staleness before the fix actually landed', () => {
    expect(isDocFixClaimStale({
      docFixTaskStatus: 'completed',
      docFixPrLifecycleStatus: 'open',
      docFixMergedAt: null,
      lastCheckedAt: new Date('2026-09-02T00:00:00Z'),
    })).toBe(false);
  });

  it('false when the row has never been rechecked at all', () => {
    expect(isDocFixClaimStale({
      docFixTaskStatus: 'completed',
      docFixPrLifecycleStatus: 'merged',
      docFixMergedAt: new Date('2026-09-01T00:00:00Z'),
      lastCheckedAt: undefined,
    })).toBe(false);
  });

  it('false when merged but the last check predates the merge — genuinely awaiting the re-run', () => {
    expect(isDocFixClaimStale({
      docFixTaskStatus: 'completed',
      docFixPrLifecycleStatus: 'merged',
      docFixMergedAt: new Date('2026-09-01T00:00:00Z'),
      lastCheckedAt: new Date('2026-08-25T00:00:00Z'),
    })).toBe(false);
  });

  it('true when merged and the checker has rechecked at least one checker interval after the merge', () => {
    const merged = new Date('2026-09-01T00:00:00Z');
    expect(isDocFixClaimStale({
      docFixTaskStatus: 'completed',
      docFixPrLifecycleStatus: 'merged',
      docFixMergedAt: merged,
      lastCheckedAt: new Date(merged.getTime() + DOC_FIX_RECHECK_GRACE_MS),
    })).toBe(true);
  });

  it('false when the only recheck landed inside the checker interval after the merge — that run may predate the fix', () => {
    // A ledger run that started on an earlier dev push and finished just after
    // the merge stamps last_checked_at past mergedAt without ever reading the
    // fixed doc. Counting it as "rechecked" re-dispatched fixes that had landed.
    const merged = new Date('2026-09-01T00:00:00Z');
    expect(isDocFixClaimStale({
      docFixTaskStatus: 'completed',
      docFixPrLifecycleStatus: 'merged',
      docFixMergedAt: merged,
      lastCheckedAt: new Date(merged.getTime() + 60_000),
    })).toBe(false);
  });
});

describe('buildDiscrepancyItems', () => {
  const row = (overrides?: Partial<DiscrepancyCandidate>): DiscrepancyCandidate => ({
    id: 'd-1',
    workspaceId: 'ws-1',
    workspaceName: 'buildd',
    specPath: 'docs/design/spec-conformance.md',
    assertionId: 'evaluate-spec-documents',
    direction: 'code_ahead',
    status: 'open',
    firstSeenAt: new Date('2026-08-25T00:00:00Z'),
    ...overrides,
  });

  it('produces one discrepancy item per open row', () => {
    const { items, overflowCount } = buildDiscrepancyItems([row()]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'discrepancy',
      discrepancyId: 'd-1',
      specPath: 'docs/design/spec-conformance.md',
      assertionId: 'evaluate-spec-documents',
      direction: 'code_ahead',
    });
    expect(overflowCount).toBe(0);
  });

  it('groups N rows on one spec path into ONE card carrying all N assertion ids', () => {
    const { items } = buildDiscrepancyItems([
      row({ id: 'd-1', assertionId: 'a-1', firstSeenAt: new Date('2026-08-03T00:00:00Z') }),
      row({ id: 'd-2', assertionId: 'a-2', firstSeenAt: new Date('2026-08-01T00:00:00Z') }),
      row({ id: 'd-3', assertionId: 'a-3', firstSeenAt: new Date('2026-08-02T00:00:00Z') }),
      row({ id: 'd-4', assertionId: 'a-4', firstSeenAt: new Date('2026-08-04T00:00:00Z') }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].assertionIds).toEqual(['a-2', 'a-3', 'a-1', 'a-4']);
    expect(items[0].discrepancyIds).toEqual(['d-2', 'd-3', 'd-1', 'd-4']);
    // Representative row + first-seen are the OLDEST in the group, so the card
    // reports the age of the finding rather than of its newest sighting.
    expect(items[0].discrepancyId).toBe('d-2');
    expect(items[0].assertionId).toBe('a-2');
    expect(items[0].firstSeenAt).toEqual(new Date('2026-08-01T00:00:00Z'));
  });

  it('does not merge two directions on one spec path — direction decides the whole CTA set', () => {
    const { items } = buildDiscrepancyItems([
      row({ id: 'd-1', assertionId: 'a-1', direction: 'code_ahead' }),
      row({ id: 'd-2', assertionId: 'a-2', direction: 'contradicted' }),
    ]);
    expect(items).toHaveLength(2);
    expect(items.map(i => i.direction)).toEqual(['contradicted', 'code_ahead']);
  });

  it('does not merge the same spec path across workspaces', () => {
    const { items } = buildDiscrepancyItems([
      row({ id: 'd-1', workspaceId: 'ws-a' }),
      row({ id: 'd-2', workspaceId: 'ws-b' }),
    ]);
    expect(items).toHaveLength(2);
  });

  it('marks the whole group in-flight when any row carries a live doc-fix task', () => {
    const { items } = buildDiscrepancyItems([
      row({ id: 'd-1', assertionId: 'a-1', docFixTaskId: 'task-1', docFixTaskStatus: 'in_progress' }),
      row({ id: 'd-2', assertionId: 'a-2' }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].docFixTaskId).toBe('task-1');
    expect(items[0].docFixTaskStatus).toBe('in_progress');
  });

  it('a completed doc-fix task still owns the path — the rows wait on the checker re-run, not on a second dispatch', () => {
    const { items } = buildDiscrepancyItems([
      row({ docFixTaskId: 'task-1', docFixTaskStatus: 'completed' }),
    ]);
    expect(items[0].docFixTaskId).toBe('task-1');
  });

  it('a failed doc-fix task releases the claim — nothing is coming, so the CTA comes back', () => {
    const { items } = buildDiscrepancyItems([
      row({ docFixTaskId: 'task-1', docFixTaskStatus: 'failed' }),
    ]);
    expect(items[0].docFixTaskId).toBeNull();
  });

  it('completed + PR merged + rechecked since merge and STILL open -> claim releases (the stranded-card bug)', () => {
    const { items } = buildDiscrepancyItems([
      row({
        docFixTaskId: 'task-1',
        docFixTaskStatus: 'completed',
        docFixPrLifecycleStatus: 'merged',
        docFixMergedAt: new Date('2026-09-01T00:00:00Z'),
        firstSeenAt: new Date('2026-08-20T00:00:00Z'),
        // last_checked_at moved to AFTER the merge — the checker genuinely
        // re-evaluated post-merge and the gap is still there.
        lastCheckedAt: new Date('2026-09-02T00:00:00Z'),
      }),
    ]);
    expect(items[0].docFixTaskId).toBeNull();
    expect(items[0].docFixTaskStatus).toBeNull();
    // ...but the card is told a fix already merged, so it offers the owner's
    // exits (accept / correct the assertion) rather than a second doc fix.
    expect(items[0].mergedDocFixTaskId).toBe('task-1');
  });

  it('a fresh code_ahead group with no prior merged fix carries no mergedDocFixTaskId', () => {
    const { items } = buildDiscrepancyItems([row()]);
    expect(items[0].mergedDocFixTaskId ?? null).toBeNull();
  });

  it('mergedDocFixTaskId survives buildActionQueue onto the card item', () => {
    const { items } = buildDiscrepancyItems([
      row({
        docFixTaskId: 'task-1',
        docFixTaskStatus: 'completed',
        docFixPrLifecycleStatus: 'merged',
        docFixMergedAt: new Date('2026-09-01T00:00:00Z'),
        lastCheckedAt: new Date('2026-09-02T00:00:00Z'),
      }),
    ]);
    const queue = buildActionQueue(items, []);
    expect(queue[0].mergedDocFixTaskId).toBe('task-1');
  });

  it('completed + PR merged but NOT yet rechecked -> claim stays live (genuinely awaiting the re-run)', () => {
    const { items } = buildDiscrepancyItems([
      row({
        docFixTaskId: 'task-1',
        docFixTaskStatus: 'completed',
        docFixPrLifecycleStatus: 'merged',
        docFixMergedAt: new Date('2026-09-01T00:00:00Z'),
        // last_checked_at is from BEFORE the merge — no re-run has happened yet.
        lastCheckedAt: new Date('2026-08-25T00:00:00Z'),
      }),
    ]);
    expect(items[0].docFixTaskId).toBe('task-1');
  });

  it('completed + PR still open (not merged) -> claim stays live, no premature release', () => {
    const { items } = buildDiscrepancyItems([
      row({
        docFixTaskId: 'task-1',
        docFixTaskStatus: 'completed',
        docFixPrLifecycleStatus: 'open',
        docFixMergedAt: null,
        lastCheckedAt: new Date('2026-09-02T00:00:00Z'),
      }),
    ]);
    expect(items[0].docFixTaskId).toBe('task-1');
  });

  it('ranks an in-flight card below every card still waiting on a human', () => {
    const { items } = buildDiscrepancyItems([
      // contradicted normally outranks everything — but not once it is agent-handled.
      row({ id: 'busy', specPath: 'busy.md', direction: 'contradicted', docFixTaskId: 't', docFixTaskStatus: 'in_progress' }),
      row({ id: 'open', specPath: 'open.md', direction: 'code_ahead' }),
    ]);
    expect(items.map(i => i.specPath)).toEqual(['open.md', 'busy.md']);
  });

  it('excludes accepted rows outright — re-surfacing an owner call already made is the Schedules-page problem again', () => {
    const { items } = buildDiscrepancyItems([row({ status: 'accepted' })]);
    expect(items).toHaveLength(0);
  });

  it('excludes resolved rows — no open gap left to show', () => {
    const { items } = buildDiscrepancyItems([row({ status: 'resolved' })]);
    expect(items).toHaveLength(0);
  });

  it('ranks contradicted first, then spec_ahead, then code_ahead', () => {
    const { items } = buildDiscrepancyItems([
      row({ id: 'code', assertionId: 'a-code', direction: 'code_ahead' }),
      row({ id: 'spec', assertionId: 'a-spec', direction: 'spec_ahead' }),
      row({ id: 'contra', assertionId: 'a-contra', direction: 'contradicted' }),
    ]);
    expect(items.map(i => i.discrepancyId)).toEqual(['contra', 'spec', 'code']);
  });

  it('within a direction, ranks oldest first_seen_at first — a spec that survived several runs always outranks a fresh one', () => {
    const { items } = buildDiscrepancyItems([
      row({ id: 'new', specPath: 'new.md', assertionId: 'a-new', firstSeenAt: new Date('2026-09-01T00:00:00Z') }),
      row({ id: 'old', specPath: 'old.md', assertionId: 'a-old', firstSeenAt: new Date('2026-08-01T00:00:00Z') }),
    ]);
    expect(items.map(i => i.discrepancyId)).toEqual(['old', 'new']);
  });

  it('caps at the top N SPECS per workspace and reports the rest as overflow, never silently dropping them', () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      row({ id: `d-${i}`, specPath: `docs/design/s-${i}.md`, assertionId: `a-${i}`, firstSeenAt: new Date(2026, 7, i + 1) }));
    const { items, overflowCount } = buildDiscrepancyItems(rows, { cap: 10 });
    expect(items).toHaveLength(10);
    expect(overflowCount).toBe(2);
    // The oldest 10 make the cut, not an arbitrary slice.
    expect(items.map(i => i.assertionId)).toEqual(
      Array.from({ length: 10 }, (_, i) => `a-${i}`),
    );
  });

  it('the cap counts SPECS, not rows — 40 stale claims across 4 docs is four cards, not an overflowing queue', () => {
    const rows = Array.from({ length: 4 }).flatMap((_, doc) =>
      Array.from({ length: 10 }, (_, i) =>
        row({ id: `d-${doc}-${i}`, specPath: `docs/design/s-${doc}.md`, assertionId: `a-${doc}-${i}` })));
    const { items, overflowCount } = buildDiscrepancyItems(rows, { cap: 10 });
    expect(items).toHaveLength(4);
    expect(overflowCount).toBe(0);
    expect(items.every(i => i.assertionIds?.length === 10)).toBe(true);
  });

  it('overflow is counted in specs too — 12 docs over a cap of 10 is 2, whatever each doc\'s row count is', () => {
    const rows = Array.from({ length: 12 }).flatMap((_, doc) =>
      Array.from({ length: 3 }, (_, i) =>
        row({ id: `d-${doc}-${i}`, specPath: `docs/design/s-${doc}.md`, assertionId: `a-${doc}-${i}`, firstSeenAt: new Date(2026, 7, doc + 1) })));
    const { items, overflowCount } = buildDiscrepancyItems(rows, { cap: 10 });
    expect(items).toHaveLength(10);
    expect(overflowCount).toBe(2);
  });

  it('caps independently per workspace — one workspace\'s backlog cannot crowd out another\'s', () => {
    const rows = [
      ...Array.from({ length: 12 }, (_, i) => row({ id: `a-${i}`, specPath: `a-${i}.md`, assertionId: `a-${i}`, workspaceId: 'ws-a' })),
      row({ id: 'b-1', specPath: 'b-1.md', assertionId: 'b-1', workspaceId: 'ws-b' }),
    ];
    const { items, overflowCount } = buildDiscrepancyItems(rows, { cap: 10 });
    expect(items.filter(i => i.workspaceId === 'ws-a')).toHaveLength(10);
    expect(items.filter(i => i.workspaceId === 'ws-b')).toHaveLength(1);
    expect(overflowCount).toBe(2);
  });
});

describe('buildActionQueue — discrepancy items', () => {
  const discrepancyItem = (overrides?: Partial<WaitingOnYouRawItem>): WaitingOnYouRawItem => ({
    kind: 'discrepancy',
    discrepancyId: 'd-1',
    specPath: 'docs/design/spec-conformance.md',
    assertionId: 'evaluate-spec-documents',
    direction: 'code_ahead',
    firstSeenAt: new Date('2026-08-25T00:00:00Z'),
    promotedMissionId: null,
    workspaceId: 'ws-1',
    workspaceName: 'buildd',
    ...overrides,
  });

  it('builds exactly one DISCREPANCY card, keyed on workspace + specPath + direction', () => {
    const queue = buildActionQueue([discrepancyItem(), discrepancyItem()], []);
    expect(queue).toHaveLength(1);
    expect(queue[0].chip).toBe('DISCREPANCY');
    expect(queue[0].subjectKey).toBe('discrepancy:ws-1:docs/design/spec-conformance.md:code_ahead');
  });

  it('a dispatched doc fix flips the card to FIXING_SPEC — agent-handled, so it leaves Waiting-on-You', () => {
    const queue = buildActionQueue([
      discrepancyItem({ docFixTaskId: 'task-7', docFixTaskStatus: 'in_progress' }),
    ], []);
    expect(queue[0].chip).toBe('FIXING_SPEC');
    expect(queue[0].docFixTaskId).toBe('task-7');
    expect(isActionableChip(queue[0].chip)).toBe(false);
  });

  it('a FIXING_SPEC card sorts below every actionable chip but stays in the queue', () => {
    const queue = buildActionQueue([
      discrepancyItem({ specPath: 'busy.md', docFixTaskId: 'task-7', docFixTaskStatus: 'in_progress' }),
      discrepancyItem({ specPath: 'open.md' }),
      { kind: 'approve', taskId: 'plan-1', taskTitle: 'Plan A' },
    ], []);
    expect(queue.map(i => i.chip)).toEqual(['DISCREPANCY', 'APPROVE', 'FIXING_SPEC']);
  });

  it('carries the grouped assertion + row ids through to the card', () => {
    const queue = buildActionQueue([
      discrepancyItem({ assertionIds: ['a-1', 'a-2'], discrepancyIds: ['d-1', 'd-2'] }),
    ], []);
    expect(queue[0].assertionIds).toEqual(['a-1', 'a-2']);
    expect(queue[0].discrepancyIds).toEqual(['d-1', 'd-2']);
  });

  it('ranks DISCREPANCY below DECIDE but above APPROVE', () => {
    const queue = buildActionQueue([
      { kind: 'approve', taskId: 'plan-1', taskTitle: 'Plan A' },
      discrepancyItem(),
      ...buildDecideItems([{
        missionId: 'mission-99',
        missionTitle: 'Mission Gamma',
        criteriaEscalatedAt: new Date(),
        criteriaRearmFingerprint: 'fp1',
        openNote: { id: 'note-1', title: 'Decide', body: 'body' },
        status: 'active',
        criteriaOverallVerdict: 'fail',
      }]),
    ], []);
    expect(queue.map(i => i.chip)).toEqual(['DECIDE', 'DISCREPANCY', 'APPROVE']);
  });

  it('re-ranks a merged multi-workspace queue by direction then age', () => {
    const queue = buildActionQueue([
      discrepancyItem({ specPath: 'a.md', assertionId: 'a1', direction: 'code_ahead', firstSeenAt: new Date('2026-08-01T00:00:00Z') }),
      discrepancyItem({ specPath: 'b.md', assertionId: 'b1', direction: 'contradicted', firstSeenAt: new Date('2026-09-01T00:00:00Z') }),
    ], []);
    expect(queue.map(i => i.assertionId)).toEqual(['b1', 'a1']);
  });

  it('carries promotedMissionId through so the card can show the link instead of a promote action', () => {
    const queue = buildActionQueue([discrepancyItem({ promotedMissionId: 'mission-42' })], []);
    expect(queue[0].promotedMissionId).toBe('mission-42');
  });
});

describe('partitionEscalations', () => {
  it('treats null lifecycle as active (keep fallback)', () => {
    const { active, resolved } = partitionEscalations([
      { ...baseResolved(), prLifecycleStatus: null as any },
    ]);
    expect(active).toHaveLength(1);
    expect(resolved).toHaveLength(0);
  });

  it('treats merged lifecycle as resolved', () => {
    const { active, resolved } = partitionEscalations([
      baseResolved({ prLifecycleStatus: 'merged' }),
    ]);
    expect(active).toHaveLength(0);
    expect(resolved).toHaveLength(1);
  });

  it('treats closed lifecycle as resolved', () => {
    const { active, resolved } = partitionEscalations([
      baseResolved({ prLifecycleStatus: 'closed' }),
    ]);
    expect(active).toHaveLength(0);
    expect(resolved).toHaveLength(1);
  });

  it('treats any other lifecycle value as active', () => {
    const { active, resolved } = partitionEscalations([
      { ...baseResolved(), prLifecycleStatus: 'pr_open' as any },
      { ...baseResolved({ workerId: 'w-2' }), prLifecycleStatus: 'ci_green' as any },
    ]);
    expect(active).toHaveLength(2);
    expect(resolved).toHaveLength(0);
  });

  it('partitions a mixed list correctly', () => {
    const items = [
      baseResolved({ workerId: 'w-1', prLifecycleStatus: null as any }),
      baseResolved({ workerId: 'w-2', prLifecycleStatus: 'merged' }),
      baseResolved({ workerId: 'w-3', prLifecycleStatus: 'closed' }),
      baseResolved({ workerId: 'w-4', prLifecycleStatus: 'ci_green' as any }),
    ];
    const { active, resolved } = partitionEscalations(items);
    expect(active).toHaveLength(2);
    expect(resolved).toHaveLength(2);
    expect(resolved.map(r => r.workerId)).toEqual(['w-2', 'w-3']);
  });

  it('returns empty arrays for empty input', () => {
    const { active, resolved } = partitionEscalations([]);
    expect(active).toHaveLength(0);
    expect(resolved).toHaveLength(0);
  });

  it('preserves all item fields in both partitions', () => {
    const item = baseResolved({ workerId: 'w-x', taskTitle: 'Custom task', prNumber: 99 });
    const { resolved } = partitionEscalations([item]);
    expect(resolved[0]).toEqual(item);
  });
});

describe('buildActionQueue — mission context', () => {
  it('carries missionId/missionTitle from an escalation-only item', () => {
    const result = buildActionQueue([], [
      escalationItem({ missionId: 'mission-9', missionTitle: 'Health analytics restructure' }),
    ]);
    expect(result[0].missionId).toBe('mission-9');
    expect(result[0].missionTitle).toBe('Health analytics restructure');
  });

  it('leaves mission fields undefined when the escalation has no mission', () => {
    const result = buildActionQueue([], [escalationItem()]);
    expect(result[0].missionId ?? null).toBeNull();
    expect(result[0].missionTitle ?? null).toBeNull();
  });

  it('prefers the escalation mission when both sides carry one', () => {
    const result = buildActionQueue(
      [mergeItem({ missionId: 'mission-woy', missionTitle: 'From blocker query' })],
      [escalationItem({ missionId: 'mission-esc', missionTitle: 'From worker task' })],
    );
    expect(result).toHaveLength(1);
    expect(result[0].missionTitle).toBe('From worker task');
  });

  it('ranks mission-linked MERGE items above unlinked ones at equal impact', () => {
    const esc: EscalationRawItem[] = [
      escalationItem({
        prUrl: 'https://github.com/org/repo/pull/798',
        prNumber: 798,
        taskId: 'orphan',
        missionId: null,
        missionTitle: null,
      }),
      escalationItem({
        prUrl: 'https://github.com/org/repo/pull/2052',
        prNumber: 2052,
        taskId: 'mission-task',
        missionId: 'mission-1',
        missionTitle: 'Release attribution',
      }),
    ];
    const result = buildActionQueue([], esc);
    expect(result.map(r => r.prNumber)).toEqual([2052, 798]);
  });

  it('breaks remaining MERGE ties by freshness (least waiting first)', () => {
    const esc: EscalationRawItem[] = [
      escalationItem({
        prUrl: 'https://github.com/org/repo/pull/798',
        prNumber: 798,
        taskId: 'ancient',
        waitingMinutes: 129_360,
      }),
      escalationItem({
        prUrl: 'https://github.com/org/repo/pull/2052',
        prNumber: 2052,
        taskId: 'recent',
        waitingMinutes: 20,
      }),
    ];
    const result = buildActionQueue([], esc);
    expect(result.map(r => r.prNumber)).toEqual([2052, 798]);
  });

  it('keeps unblockCount as the dominant MERGE sort key', () => {
    const woy: WaitingOnYouRawItem[] = [
      mergeItem({
        prUrl: 'https://github.com/org/repo/pull/2040',
        prNumber: 2040,
        upstreamTaskId: 'u-2040',
        unblockCount: 1,
        missionId: null,
        missionTitle: null,
      }),
    ];
    const esc: EscalationRawItem[] = [
      escalationItem({
        prUrl: 'https://github.com/org/repo/pull/2052',
        prNumber: 2052,
        taskId: 'fresh-mission',
        missionId: 'mission-1',
        missionTitle: 'Release attribution',
        waitingMinutes: 1,
      }),
    ];
    const result = buildActionQueue(woy, esc);
    expect(result.map(r => r.prNumber)).toEqual([2040, 2052]);
  });
});

describe('buildActionQueue — unblocked mission vs own mission', () => {
  it('keeps the blocked mission separate from the PR own mission', () => {
    const result = buildActionQueue(
      [mergeItem({ missionId: 'mission-blocked', missionTitle: 'Downstream mission' })],
      [escalationItem({ missionId: 'mission-own', missionTitle: 'Owning mission' })],
    );
    expect(result[0].missionTitle).toBe('Owning mission');
    expect(result[0].unblockMissionTitle).toBe('Downstream mission');
  });

  it('sets unblockMissionTitle on a blocker-only merge item', () => {
    const result = buildActionQueue([mergeItem()], []);
    expect(result[0].unblockMissionTitle).toBe('Mission Alpha');
    expect(result[0].missionTitle).toBe('Mission Alpha');
  });
});

describe('buildActionQueue — CI gate', () => {
  it('renders a live CI fix as an informational FIXING_CI card', () => {
    const result = buildActionQueue([], [escalationItem({
      ciGate: { kind: 'fixing', label: 'Fixing CI · attempt 2 of 3', taskId: 'fix-1' },
    })]);
    expect(result[0].chip).toBe('FIXING_CI');
    expect(result[0].ciGate).toEqual({ kind: 'fixing', label: 'Fixing CI · attempt 2 of 3', taskId: 'fix-1' });
    expect(isActionableChip(result[0].chip)).toBe(false);
  });

  it('renders a pending suite as an informational CI_RUNNING card', () => {
    const result = buildActionQueue([], [escalationItem({
      ciGate: { kind: 'running', label: 'CI running' },
    })]);
    expect(result[0].chip).toBe('CI_RUNNING');
    expect(isActionableChip(result[0].chip)).toBe(false);
  });

  it('renders a red PR with no fixer as an actionable BLOCKED card carrying the recommendation', () => {
    const result = buildActionQueue([], [escalationItem({
      ciGate: {
        kind: 'blocked',
        reason: 'CI failing — 3 fix attempts exhausted',
        recommendation: 'Migration 0071 needs a manual backfill before CI can pass.',
      },
    })]);
    expect(result[0].chip).toBe('BLOCKED');
    expect(result[0].escalationReason).toBe('CI failing — 3 fix attempts exhausted');
    expect(result[0].recommendation).toBe('Migration 0071 needs a manual backfill before CI can pass.');
    expect(isActionableChip(result[0].chip)).toBe(true);
  });

  it('keeps a conflict retry ahead of the CI gate — the conflict is why CI cannot run', () => {
    const result = buildActionQueue([], [escalationItem({
      conflictRetryTaskId: 'conflict-1',
      ciGate: { kind: 'blocked', reason: 'CI failing — no fix in flight', recommendation: null },
    })]);
    expect(result[0].chip).toBe('RESOLVING');
  });

  it('sorts informational CI cards below every actionable card', () => {
    const esc: EscalationRawItem[] = [
      escalationItem({
        prUrl: 'https://github.com/org/repo/pull/1',
        prNumber: 1,
        taskId: 'fixing',
        ciGate: { kind: 'fixing', label: 'Fixing CI', taskId: 'fix-1' },
      }),
      escalationItem({
        prUrl: 'https://github.com/org/repo/pull/2',
        prNumber: 2,
        taskId: 'green',
      }),
      escalationItem({
        prUrl: 'https://github.com/org/repo/pull/3',
        prNumber: 3,
        taskId: 'red',
        ciGate: { kind: 'blocked', reason: 'CI failing — no fix in flight', recommendation: null },
      }),
    ];
    const result = buildActionQueue([], esc);
    expect(result.map(r => r.chip)).toEqual(['MERGE', 'BLOCKED', 'FIXING_CI']);
  });

  it('never offers a merge on a CI-gated card', () => {
    const gated = buildActionQueue([], [escalationItem({
      ciGate: { kind: 'fixing', label: 'Fixing CI', taskId: 'fix-1' },
    })]);
    expect(gated[0].chip).not.toBe('MERGE');
    expect(gated[0].chip).not.toBe('REVIEW');
  });
});

describe('isActionableChip', () => {
  it('counts human-gated chips and excludes agent-handled ones', () => {
    expect(['MERGE', 'BLOCKED', 'RECONNECT', 'REVIEW', 'QUESTION', 'APPROVE', 'STALE'].map(isActionableChip))
      .toEqual([true, true, true, true, true, true, true]);
    expect(['RESOLVING', 'FIXING_CI', 'CI_RUNNING'].map(isActionableChip))
      .toEqual([false, false, false]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Freshness invariant. A card that asks a human to merge is a claim about the
// PR's CURRENT state; this is where that claim is refused on stale input.
//
// Every assertion here pins the FAIL-CLOSED direction: unknown degrades to
// STALE, never to a CTA. The queue is allowed to say "I don't know"; it is not
// allowed to say "merge this" about a PR that merged three months ago.
// ─────────────────────────────────────────────────────────────────────────────

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const AT = new Date('2026-09-03T22:51:00Z');
const before = (ms: number) => new Date(AT.getTime() - ms);

describe('buildActionQueue — freshness invariant', () => {
  it('refuses a MERGE card when the row has never been verified', () => {
    const result = buildActionQueue([], [escalationItem({
      prOpenedAt: before(3 * HOUR),
      prLifecycleVerifiedAt: null,
    })], { now: AT });

    expect(result[0].chip).toBe('STALE');
    expect(result[0].staleGate?.kind).toBe('unverified');
  });

  it('refuses a MERGE card when the last check is past the row tier SLA', () => {
    const result = buildActionQueue([], [escalationItem({
      prOpenedAt: before(90 * DAY),
      prLifecycleVerifiedAt: before(4 * DAY),
    })], { now: AT });

    expect(result[0].chip).toBe('STALE');
    expect(result[0].staleGate?.kind).toBe('unverified');
  });

  it('refuses a MERGE card for a verified-open PR that is simply ancient', () => {
    const result = buildActionQueue([], [escalationItem({
      prOpenedAt: before(90 * DAY),
      prLifecycleVerifiedAt: before(HOUR),
    })], { now: AT });

    expect(result[0].chip).toBe('STALE');
    expect(result[0].staleGate?.kind).toBe('ancient');
    expect(result[0].escalationReason).toContain('90 days');
  });

  it('degrades a REVIEW card the same way — the gate is on the claim, not the tier', () => {
    const result = buildActionQueue([], [escalationItem({
      policyTier: 'agent-review',
      prOpenedAt: before(90 * DAY),
      prLifecycleVerifiedAt: null,
    })], { now: AT });

    expect(result[0].chip).toBe('STALE');
  });

  it('allows a MERGE card for a recent PR verified inside its SLA', () => {
    const result = buildActionQueue([], [escalationItem({
      prOpenedAt: before(3 * HOUR),
      prLifecycleVerifiedAt: before(60_000),
    })], { now: AT });

    expect(result[0].chip).toBe('MERGE');
    expect(result[0].staleGate).toBeNull();
  });

  it('AC-6: fails closed, rather than opting out, for a caller that supplies no PR age', () => {
    // Home always supplies both fields, but a caller that omits prOpenedAt no
    // longer gets a free pass — it fails closed to STALE/unverified, same as a
    // row with a known age and no verification. There is no more "no tier,
    // therefore no SLA to be outside of" escape hatch.
    const result = buildActionQueue([], [escalationItem({
      prOpenedAt: undefined,
      prLifecycleVerifiedAt: undefined,
    })], { now: AT });
    expect(result[0].chip).toBe('STALE');
    expect(result[0].staleGate?.kind).toBe('unverified');
  });

  it('drops a terminal unresolvable row out of the queue', () => {
    const result = buildActionQueue([], [escalationItem({
      prLifecycleStatus: 'unresolvable',
      prOpenedAt: before(90 * DAY),
      prLifecycleVerifiedAt: null,
    })], { now: AT });

    expect(result).toHaveLength(0);
  });

  it('gates a blocker-derived merge card too, not just escalation cards', () => {
    const result = buildActionQueue([mergeItem({
      prOpenedAt: before(90 * DAY),
      prLifecycleVerifiedAt: null,
    })], [], { now: AT });

    expect(result[0].chip).toBe('STALE');
  });

  it('sorts every live decision above a stale one', () => {
    const result = buildActionQueue([], [
      escalationItem({
        prUrl: PR_URL_B, prNumber: 1481, taskId: 'task-2',
        prOpenedAt: before(90 * DAY), prLifecycleVerifiedAt: null,
      }),
      escalationItem({
        prOpenedAt: before(2 * HOUR), prLifecycleVerifiedAt: before(60_000),
      }),
    ], { now: AT });

    expect(result.map(r => r.chip)).toEqual(['MERGE', 'STALE']);
  });

  it('orders stale cards oldest-first — the 90-day one is the least ambiguous', () => {
    const result = buildActionQueue([], [
      escalationItem({
        prUrl: PR_URL_B, prNumber: 1481, taskId: 'task-2',
        prOpenedAt: before(20 * DAY), prLifecycleVerifiedAt: null,
      }),
      escalationItem({
        prOpenedAt: before(90 * DAY), prLifecycleVerifiedAt: null,
      }),
    ], { now: AT });

    expect(result.map(r => r.prNumber)).toEqual([1480, 1481]);
  });
});

describe('summariseActionQueueAge', () => {
  it('reports zeros for an empty queue', () => {
    expect(summariseActionQueueAge([])).toEqual({
      measured: 0,
      p99AgeHours: 0,
      olderThan7dCount: 0,
      staleUnverified: 0,
      staleAncient: 0,
    });
  });

  it('counts the cards that should not exist, split by why', () => {
    // The exact shape observed on Home: one recent card and three ancient ones.
    const queue = buildActionQueue([], [
      escalationItem({ taskId: 't0', prUrl: 'https://github.com/org/repo/pull/2040', prNumber: 2040, prOpenedAt: before(36 * HOUR), prLifecycleVerifiedAt: null }),
      escalationItem({ taskId: 't1', prUrl: 'https://github.com/org/repo/pull/25', prNumber: 25, prOpenedAt: before(73 * DAY), prLifecycleVerifiedAt: null }),
      escalationItem({ taskId: 't2', prUrl: 'https://github.com/org/repo/pull/77', prNumber: 77, prOpenedAt: before(90 * DAY), prLifecycleVerifiedAt: before(2 * HOUR) }),
      escalationItem({ taskId: 't3', prUrl: 'https://github.com/org/repo/pull/59', prNumber: 59, prOpenedAt: before(90 * DAY), prLifecycleVerifiedAt: null }),
    ], { now: AT });

    const metrics = summariseActionQueueAge(queue);
    expect(metrics.measured).toBe(4);
    expect(metrics.p99AgeHours).toBe(90 * 24);
    expect(metrics.olderThan7dCount).toBe(3);
    expect(metrics.staleUnverified).toBe(3);
    expect(metrics.staleAncient).toBe(1);
    // None of the four may present as a merge tap.
    expect(queue.every(c => c.chip === 'STALE')).toBe(true);
  });

  it('AC-6 steady state: once the sweep has stamped them merged, nothing is left', () => {
    // What the backfill produces: the four rows become prLifecycleStatus
    // 'merged', which Home's openPrWorkers query excludes outright — so the
    // queue they feed is empty and no card is older than the stale threshold.
    const queue = buildActionQueue([], [], { now: AT });
    const metrics = summariseActionQueueAge(queue);
    expect(queue).toHaveLength(0);
    expect(metrics.olderThan7dCount).toBe(0);
  });
});

describe('buildActionQueue — decide cards', () => {
  it('builds a DECIDE card from an escalated mission item', () => {
    const woy: WaitingOnYouRawItem[] = [
      {
        kind: 'decide',
        missionId: 'mission-escalated',
        missionTitle: 'Escalated Mission',
        criteriaRearmFingerprint: 'fp1',
      },
    ];
    const result = buildActionQueue(woy, []);
    expect(result).toHaveLength(1);
    expect(result[0].chip).toBe('DECIDE');
    expect(result[0].missionId).toBe('mission-escalated');
    expect(result[0].missionTitle).toBe('Escalated Mission');
  });

  it('deduplicates decide cards by mission id and fingerprint', () => {
    const woy: WaitingOnYouRawItem[] = [
      {
        kind: 'decide',
        missionId: 'mission-1',
        missionTitle: 'Mission',
        criteriaRearmFingerprint: 'fp1',
      },
      {
        kind: 'decide',
        missionId: 'mission-1',
        missionTitle: 'Mission',
        criteriaRearmFingerprint: 'fp1',
      },
    ];
    const result = buildActionQueue(woy, []);
    expect(result).toHaveLength(1);
  });

  it('creates separate decide cards for different fingerprints on same mission', () => {
    const woy: WaitingOnYouRawItem[] = [
      {
        kind: 'decide',
        missionId: 'mission-1',
        missionTitle: 'Mission',
        criteriaFingerprint: 'fp1',
        noteId: 'note-1',
        noteTitle: 'Note 1',
      },
      {
        kind: 'decide',
        missionId: 'mission-1',
        missionTitle: 'Mission',
        criteriaFingerprint: 'fp2',
        noteId: 'note-2',
        noteTitle: 'Note 2',
      },
    ];
    const result = buildActionQueue(woy, []);
    expect(result).toHaveLength(2);
  });

  it('orders DECIDE before APPROVE', () => {
    const woy: WaitingOnYouRawItem[] = [
      { kind: 'approve', taskId: 'plan-1', taskTitle: 'Plan A' },
      {
        kind: 'decide',
        missionId: 'mission-1',
        missionTitle: 'Mission',
        criteriaFingerprint: 'fp1',
        noteId: 'note-1',
        noteTitle: 'Note 1',
      },
      { kind: 'answer', workerId: 'w-1', taskId: 'task-q', taskTitle: 'Q Task', question: 'Is X ready?' },
    ];
    const result = buildActionQueue(woy, []);
    expect(result.map(r => r.chip)).toEqual(['QUESTION', 'DECIDE', 'APPROVE']);
  });
});

describe('buildActionQueue — recommendations', () => {
  it('carries a reviewer recommendation onto the escalation card', () => {
    const result = buildActionQueue([], [escalationItem({
      recommendation: 'Confirm the token refresh lock by hand, then merge.',
    })]);
    expect(result[0].recommendation).toBe('Confirm the token refresh lock by hand, then merge.');
  });

  it('prefers the CI handoff over the reviewer recommendation when CI is the blocker', () => {
    const result = buildActionQueue([], [escalationItem({
      recommendation: 'Reviewer advice',
      ciGate: { kind: 'blocked', reason: 'CI failing — no fix in flight', recommendation: 'CI handoff advice' },
    })]);
    expect(result[0].recommendation).toBe('CI handoff advice');
  });
})

describe('buildActionQueue — approvedSha / headSha pass-through', () => {
  it('carries approvedSha and headSha through unchanged, for the card\'s re-review-since-approval gate', () => {
    const result = buildActionQueue([], [escalationItem({
      verdictSummary: 'Looks good, confidence 0.92',
      approvedSha: 'old-sha',
      headSha: 'new-sha',
    })]);
    expect(result[0].approvedSha).toBe('old-sha');
    expect(result[0].headSha).toBe('new-sha');
  });

  it('defaults both to null when the caller supplied neither', () => {
    const result = buildActionQueue([], [escalationItem()]);
    expect(result[0].approvedSha).toBeNull();
    expect(result[0].headSha).toBeNull();
  });
})

describe('buildActionQueue — hasEscalationNote pass-through', () => {
  it('carries hasEscalationNote through unchanged — the fix-dispatch CTA discriminator', () => {
    const result = buildActionQueue([], [escalationItem({ hasEscalationNote: true })]);
    expect(result[0].hasEscalationNote).toBe(true);
  });

  it('defaults to false when the caller omits it (pure task-status inference, no note)', () => {
    const result = buildActionQueue([], [escalationItem()]);
    expect(result[0].hasEscalationNote).toBe(false);
  });
})

describe('buildActionQueue — snoozedSubjectKeys', () => {
  it('drops a MERGE card whose subjectKey is in the snoozed set', () => {
    const result = buildActionQueue([], [escalationItem()], {
      snoozedSubjectKeys: new Set([PR_URL_A]),
    });
    expect(result).toHaveLength(0);
  });

  it('leaves a card whose subjectKey is not in the snoozed set', () => {
    const result = buildActionQueue([], [escalationItem()], {
      snoozedSubjectKeys: new Set(['some-other-key']),
    });
    expect(result).toHaveLength(1);
  });

  it('drops only the snoozed PR, keeping other cards visible', () => {
    const woy: WaitingOnYouRawItem[] = [
      mergeItem({ prUrl: PR_URL_A, prNumber: 1480, upstreamTaskId: 'u1' }),
    ];
    const esc: EscalationRawItem[] = [
      escalationItem({ prUrl: PR_URL_B, prNumber: 1481, taskId: 'task-2' }),
    ];
    const result = buildActionQueue(woy, esc, { snoozedSubjectKeys: new Set([PR_URL_A]) });
    expect(result).toHaveLength(1);
    expect(result[0].prNumber).toBe(1481);
  });

  it('with no snoozedSubjectKeys option, behaves exactly as before (no filtering)', () => {
    const result = buildActionQueue([mergeItem()], [escalationItem()]);
    expect(result).toHaveLength(1);
  });
})

describe('buildActionQueue — missionMergeBlockedReason pass-through', () => {
  it('carries the reason through unchanged when the caller supplies it', () => {
    const result = buildActionQueue([], [escalationItem({
      verdictSummary: 'Reviewer approved — awaiting human merge',
      missionMergeBlockedReason:
        "This mission's work is not finished — 2 task PR(s) still open on the integration branch: "
        + 'PR #2514 (fix retry logic), PR #2516 (add timeout). Cancel the remaining task(s), or let '
        + 'them land, then merge.',
    })]);
    expect(result[0].missionMergeBlockedReason).toContain('PR #2514');
    expect(result[0].missionMergeBlockedReason).toContain('PR #2516');
  });

  it('defaults to null for an ordinary task PR — guardMissionPrMerge never blocks those', () => {
    const result = buildActionQueue([], [escalationItem()]);
    expect(result[0].missionMergeBlockedReason).toBeNull();
  });
})
