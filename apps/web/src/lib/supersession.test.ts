import { describe, it, expect } from 'bun:test';
import {
  MAX_CANCELS_PER_EVENT,
  SUPERSESSION_RULES,
  SUPERSESSION_RULE_IDS,
  checkDispatch,
  decideCancellations,
  decideDispatch,
  guardDispatchedTask,
  reconcileSubjectEvent,
  type CancelDecision,
  type DispatchFacts,
  type DispatchProposal,
  type EventFacts,
  type SubjectEvent,
  type SupersessionCandidate,
  type SupersessionRule,
  type SupersessionStore,
} from './supersession';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const WS = 'ws-1';
const PR = 42;
const ORIGINAL = 'original-task';
const EXACT = { source: 'system', confidence: 'exact' };

function task(overrides: Partial<SupersessionCandidate> = {}): SupersessionCandidate {
  return {
    id: 'task-1',
    workspaceId: WS,
    missionId: 'mission-1',
    status: 'pending',
    parentTaskId: ORIGINAL,
    category: null,
    taskClass: null,
    creationSource: 'webhook',
    reviewerRetryPrNumber: null,
    reviewerRetryHeadSha: null,
    ciRetryPrNumber: null,
    subjectPrNumber: null,
    subjectAnchor: null,
    subjectResolution: null,
    context: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ownLivePrNumber: null,
    ...overrides,
  };
}

const reviewFix = (o: Partial<SupersessionCandidate> = {}) =>
  task({ id: 'fix-1', taskClass: 'attempt', reviewerRetryPrNumber: PR, reviewerRetryHeadSha: 'sha-old', ...o });
const ciFix = (o: Partial<SupersessionCandidate> = {}) =>
  task({ id: 'ci-1', taskClass: 'attempt', ciRetryPrNumber: PR, ...o });
const reviewer = (o: Partial<SupersessionCandidate> = {}) =>
  task({
    id: 'review-1',
    category: 'review',
    context: { reviewerFor: ORIGINAL, prNumber: PR },
    subjectPrNumber: PR,
    subjectAnchor: EXACT,
    ...o,
  });
const anchored = (o: Partial<SupersessionCandidate> = {}) =>
  task({ id: 'anchored-1', parentTaskId: null, subjectPrNumber: PR, subjectAnchor: EXACT, ...o });

const approve = (o: Partial<Extract<SubjectEvent, { kind: 'verdict' }>> = {}): SubjectEvent => ({
  kind: 'verdict', verdict: 'approve', workspaceId: WS, prNumber: PR, reviewerTaskId: 'review-2',
  headSha: 'sha-new', roundCreatedAt: new Date('2026-01-02T00:00:00Z'), originalTaskId: ORIGINAL, door: 'test', ...o,
});
const requestChanges = (o: Partial<Extract<SubjectEvent, { kind: 'verdict' }>> = {}): SubjectEvent =>
  approve({ verdict: 'request-changes', ...o });
const merged: SubjectEvent = { kind: 'merged', workspaceId: WS, prNumber: PR, originalTaskId: ORIGINAL, door: 'test' };
const closed: SubjectEvent = { kind: 'closed', workspaceId: WS, prNumber: PR, originalTaskId: ORIGINAL, door: 'test' };
const subjectCheck: SubjectEvent = { kind: 'subject_check', workspaceId: WS, prNumber: PR, door: 'test' };
const parentDone: SubjectEvent = { kind: 'parent_done', workspaceId: WS, parentTaskId: ORIGINAL, prNumber: PR, door: 'test' };
const cancelled: SubjectEvent = { kind: 'cancelled', workspaceId: WS, taskId: ORIGINAL, door: 'test' };

const DEAD: EventFacts = { subjectHasLiveSuccessor: false };

function decide(event: SubjectEvent, t: SupersessionCandidate, facts: EventFacts = {}) {
  const [d] = decideCancellations(event, [t], facts);
  return d;
}

// ── In-memory store: a status CAS shared by every caller ─────────────────────

function memoryStore(rows: SupersessionCandidate[], opts: { facts?: EventFacts; dispatch?: DispatchFacts } = {}) {
  const status = new Map(rows.map(r => [r.id, r.status]));
  const ledger: Array<{ taskId: string; rule: string; event: string }> = [];
  const activity: Array<{ taskId: string; rule: string }> = [];
  const effects: string[] = [];
  const refusals: CancelDecision[][] = [];
  const store: SupersessionStore = {
    loadCandidates: async () =>
      rows.filter(r => ['pending', 'assigned', 'in_progress'].includes(status.get(r.id)!))
        .map(r => ({ ...r, status: status.get(r.id)! })),
    loadEventFacts: async () => opts.facts ?? {},
    loadDispatchFacts: async () => opts.dispatch ?? {},
    casCancel: async (t: SupersessionCandidate, rule: SupersessionRule) => {
      // Yield first so two concurrent reconciles interleave between read and write.
      await Promise.resolve();
      const allowed = rule.casStatuses ?? ['pending', 'assigned', 'in_progress'];
      if (!allowed.includes(status.get(t.id)!)) return false;
      status.set(t.id, 'cancelled');
      return true;
    },
    applyCancelEffects: async t => { effects.push(t.id); },
    recordSupersession: async (t, rule, event) => {
      ledger.push({ taskId: t.id, rule: rule.id, event: event.kind });
      activity.push({ taskId: t.id, rule: rule.id });
    },
    recordBulkRefusal: async (_e, would) => { refusals.push(would); },
  };
  return { store, status, ledger, activity, effects, refusals };
}

// ── The table ────────────────────────────────────────────────────────────────

describe('SUPERSESSION_RULES', () => {
  it('lists every rule exactly once, in the design order', () => {
    expect(SUPERSESSION_RULES.map(r => r.id)).toEqual([...SUPERSESSION_RULE_IDS]);
  });
});

describe('approve_supersedes_fix', () => {
  it('cancels a queued review fix for the approved PR', () => {
    expect(decide(approve(), reviewFix())).toMatchObject({ verdict: 'cancel', rule: 'approve_supersedes_fix' });
  });
  it('cancels a running review fix too', () => {
    expect(decide(approve(), reviewFix({ status: 'in_progress' })).rule).toBe('approve_supersedes_fix');
  });
  it('keeps a CI fix: an approve does not make red CI green', () => {
    expect(decide(approve(), ciFix()).verdict).toBe('keep');
  });
  it('keeps a review fix for another PR', () => {
    expect(decide(approve(), reviewFix({ reviewerRetryPrNumber: 7 })).verdict).toBe('keep');
  });
  it('skips dispatching a fix once the newest round approved', () => {
    expect(decideDispatch(
      { kind: 'fix', workspaceId: WS, prNumber: PR, triggeringReviewTaskId: 'review-1', door: 't' },
      { newestReviewTaskId: 'review-1', newestReviewVerdict: 'approve' },
    )).toEqual({ verdict: 'skip_dispatch', rule: 'approve_supersedes_fix' });
  });
});

describe('merge_supersedes_review', () => {
  it('cancels a live reviewer of the merged PR', () => {
    expect(decide(merged, reviewer()).rule).toBe('merge_supersedes_review');
    expect(decide(merged, reviewer({ status: 'in_progress' })).rule).toBe('merge_supersedes_review');
  });
  it('keeps a reviewer on a close without merge', () => {
    expect(decide(closed, reviewer({ status: 'in_progress' })).verdict).toBe('keep');
  });
  it('skips dispatching a reviewer for a merged PR', () => {
    expect(decideDispatch({ kind: 'reviewer', workspaceId: WS, prNumber: PR, door: 't' }, { prState: 'merged' }).rule)
      .toBe('merge_supersedes_review');
  });
});

describe('merge_supersedes_fix', () => {
  it('cancels review and CI fixes for the merged PR', () => {
    expect(decide(merged, reviewFix({ status: 'in_progress' })).rule).toBe('merge_supersedes_fix');
    expect(decide(merged, ciFix()).rule).toBe('merge_supersedes_fix');
  });
  it('skips dispatching a CI fix for a merged PR', () => {
    expect(decideDispatch({ kind: 'ci_retry', workspaceId: WS, prNumber: PR, door: 't' }, { prState: 'merged' }).rule)
      .toBe('merge_supersedes_fix');
  });
});

describe('close_reconciles_subject', () => {
  it('cancels and stamps an unstarted task anchored to a dead PR', () => {
    const rule = SUPERSESSION_RULES.find(r => r.id === 'close_reconciles_subject')!;
    expect(decide(closed, anchored(), DEAD).rule).toBe('close_reconciles_subject');
    expect(decide(merged, anchored({ status: 'assigned' }), DEAD).rule).toBe('close_reconciles_subject');
    expect(decide(subjectCheck, anchored(), DEAD).rule).toBe('close_reconciles_subject');
    expect(rule.stamp).toEqual({ subjectResolution: 'reconciled' });
    expect(rule.casStatuses).toEqual(['pending', 'assigned']);
  });
  it('keeps it while a retry-chain member still has a live PR', () => {
    expect(decide(closed, anchored(), { subjectHasLiveSuccessor: true }).verdict).toBe('keep');
  });
  it('keeps it when liveness was not loaded', () => {
    expect(decide(closed, anchored(), {}).verdict).toBe('keep');
  });
  it('keeps a task a worker already started', () => {
    expect(decide(closed, anchored({ status: 'in_progress' }), DEAD).verdict).toBe('keep');
  });
  it('is idempotent: an already-reconciled task is left alone', () => {
    expect(decide(closed, anchored({ subjectResolution: 'reconciled' }), DEAD).verdict).toBe('keep');
  });
  it('subject_check never cancels a fix or a review on its own', () => {
    expect(decide(subjectCheck, reviewFix(), DEAD).verdict).toBe('keep');
    expect(decide(subjectCheck, reviewer({ subjectAnchor: { source: 'text', confidence: 'derived' } }), DEAD).verdict).toBe('keep');
  });
});

describe('close_supersedes_fix', () => {
  it('cancels an unstarted fix for a PR closed without merging', () => {
    expect(decide(closed, reviewFix()).rule).toBe('close_supersedes_fix');
    expect(decide(closed, ciFix({ status: 'assigned' })).rule).toBe('close_supersedes_fix');
  });
  it('keeps a running fix — it may be the retry opening the successor PR', () => {
    expect(decide(closed, reviewFix({ status: 'in_progress' })).verdict).toBe('keep');
  });
  it('skips dispatching a fix for a closed PR', () => {
    expect(decideDispatch({ kind: 'fix', workspaceId: WS, prNumber: PR, door: 't' }, { prState: 'closed' }).rule)
      .toBe('close_supersedes_fix');
  });
});

describe('newer_verdict_supersedes_fix', () => {
  it('cancels an unstarted fix dispatched off an older round at another head', () => {
    expect(decide(requestChanges(), reviewFix()).rule).toBe('newer_verdict_supersedes_fix');
  });
  it('keeps the fix this round dispatched (created after the round)', () => {
    expect(decide(requestChanges(), reviewFix({ createdAt: new Date('2026-01-03T00:00:00Z') })).verdict).toBe('keep');
  });
  it('keeps a fix for the same head', () => {
    expect(decide(requestChanges(), reviewFix({ reviewerRetryHeadSha: 'sha-new' })).verdict).toBe('keep');
  });
  it('keeps a running fix — it may have pushed the head being reviewed', () => {
    expect(decide(requestChanges(), reviewFix({ status: 'in_progress' })).verdict).toBe('keep');
  });
  it('skips dispatching a fix whose triggering round is no longer the newest', () => {
    const p: DispatchProposal = { kind: 'fix', workspaceId: WS, prNumber: PR, triggeringReviewTaskId: 'review-1', door: 't' };
    expect(decideDispatch(p, { newestReviewTaskId: 'review-2', newestReviewVerdict: null }).rule)
      .toBe('newer_verdict_supersedes_fix');
    expect(decideDispatch(p, { newestReviewTaskId: 'review-1', newestReviewVerdict: 'request-changes' }).verdict)
      .toBe('keep');
  });
});

describe('parent_done_supersedes_retry', () => {
  it('cancels an open retry of a task whose PR merged', () => {
    const conflictRetry = task({ id: 'retry-1', taskClass: 'attempt', status: 'in_progress' });
    expect(decide(parentDone, conflictRetry).rule).toBe('parent_done_supersedes_retry');
  });
  it('keeps a non-attempt child (a decomposition subtask is not a retry)', () => {
    expect(decide(parentDone, task({ id: 'child' })).verdict).toBe('keep');
  });
  it('skips dispatching a retry of a merged task', () => {
    expect(decideDispatch({ kind: 'retry', workspaceId: WS, parentTaskId: ORIGINAL, door: 't' }, { parentMerged: true }).rule)
      .toBe('parent_done_supersedes_retry');
  });
});

describe('cancel_supersedes_retry', () => {
  it('cancels an open retry of a cancelled task', () => {
    expect(decide(cancelled, task({ id: 'retry-1', taskClass: 'attempt' })).rule).toBe('cancel_supersedes_retry');
  });
  it('skips dispatching a retry of a cancelled task, but not a reviewer', () => {
    expect(decideDispatch({ kind: 'ci_retry', workspaceId: WS, parentTaskId: ORIGINAL, door: 't' }, { parentStatus: 'cancelled' }).rule)
      .toBe('cancel_supersedes_retry');
    expect(decideDispatch({ kind: 'reviewer', workspaceId: WS, parentTaskId: ORIGINAL, door: 't' }, { parentStatus: 'cancelled' }).verdict)
      .toBe('keep');
  });
});

// ── Bounds ───────────────────────────────────────────────────────────────────

describe('bounds', () => {
  it('never cancels on an advisory anchor (prose-scraped PR number)', () => {
    expect(decide(closed, anchored({ subjectAnchor: { source: 'text', confidence: 'derived' } }), DEAD).verdict).toBe('keep');
    expect(decide(closed, anchored({ subjectAnchor: { source: 'url', confidence: 'derived' } }), DEAD).verdict).toBe('keep');
  });
  it('never cancels on a binding source whose confidence is derived', () => {
    expect(decide(closed, anchored({ subjectAnchor: { source: 'context', confidence: 'derived' } }), DEAD).verdict).toBe('keep');
  });
  it('never cancels when the anchor jsonb is missing (fail open)', () => {
    expect(decide(closed, anchored({ subjectAnchor: null }), DEAD).verdict).toBe('keep');
  });
  it('reconciles a context-sourced exact anchor (the other identifying class)', () => {
    expect(decide(closed, anchored({ subjectAnchor: { source: 'context', confidence: 'exact' } }), DEAD).verdict).toBe('cancel');
  });
  it('never cancels a human-filed task', () => {
    for (const creationSource of ['dashboard', 'github']) {
      const d = decide(closed, anchored({ creationSource }), DEAD);
      expect(d).toMatchObject({ verdict: 'keep', bound: 'human_filed' });
    }
  });
  it('does cancel a system retry even when a person filed it from the dashboard', () => {
    expect(decide(approve(), reviewFix({ creationSource: 'dashboard' })).verdict).toBe('cancel');
  });
  it('never cancels a task whose own live PR is not the subject', () => {
    const d = decide(merged, ciFix({ ownLivePrNumber: 99 }));
    expect(d).toMatchObject({ verdict: 'keep', bound: 'own_live_pr' });
    // ...but its own PR being the subject is no protection.
    expect(decide(merged, ciFix({ ownLivePrNumber: PR })).verdict).toBe('cancel');
  });
  it('never touches a task that is already terminal', () => {
    expect(decide(merged, reviewFix({ status: 'completed' })).bound).toBe('not_open');
  });
});

// ── Orchestration ────────────────────────────────────────────────────────────

describe('reconcileSubjectEvent', () => {
  it('cancels each decided task once, and the winner writes one ledger row and one activity entry', async () => {
    const m = memoryStore([reviewFix(), ciFix({ id: 'ci-other', ciRetryPrNumber: 7 })]);
    const result = await reconcileSubjectEvent(approve(), { store: m.store });
    expect(result.cancelled).toEqual([{ taskId: 'fix-1', rule: 'approve_supersedes_fix' }]);
    expect(m.status.get('ci-other')).toBe('pending');
    expect(m.ledger).toEqual([{ taskId: 'fix-1', rule: 'approve_supersedes_fix', event: 'verdict' }]);
    expect(m.activity).toHaveLength(1);
    expect(m.effects).toEqual(['fix-1']);
  });

  it('COLLISION: the old helper and the reconciler firing for one approve yield one cancellation and one ledger row', async () => {
    const m = memoryStore([reviewFix()]);
    // The legacy helper is a wrapper that runs exactly its one rule.
    const [legacy, reconciler] = await Promise.all([
      reconcileSubjectEvent(approve({ door: 'supersedeFixTaskOnApproval' }), { store: m.store, rules: ['approve_supersedes_fix'] }),
      reconcileSubjectEvent(approve(), { store: m.store }),
    ]);
    const cancellations = [...legacy.cancelled, ...reconciler.cancelled];
    expect(cancellations).toHaveLength(1);
    expect([...legacy.lostRace, ...reconciler.lostRace]).toEqual(['fix-1']);
    expect(m.ledger).toHaveLength(1);
    expect(m.activity).toHaveLength(1);
    expect(m.effects).toHaveLength(1);
  });

  it('two doors observing the same merge cancel the reviewer once', async () => {
    const m = memoryStore([reviewer({ status: 'in_progress' })]);
    await Promise.all([
      reconcileSubjectEvent({ ...merged, door: 'webhook' }, { store: m.store }),
      reconcileSubjectEvent({ ...merged, door: 'merge route' }, { store: m.store }),
    ]);
    expect(m.ledger).toEqual([{ taskId: 'review-1', rule: 'merge_supersedes_review', event: 'merged' }]);
  });

  it(`refuses an event that would cancel more than ${MAX_CANCELS_PER_EVENT} tasks: cancels none, records the set`, async () => {
    const rows = Array.from({ length: MAX_CANCELS_PER_EVENT + 1 }, (_, i) => reviewFix({ id: `fix-${i}` }));
    const m = memoryStore(rows);
    const result = await reconcileSubjectEvent(approve(), { store: m.store });
    expect(result.cancelled).toEqual([]);
    expect(result.refused?.wouldCancel).toHaveLength(MAX_CANCELS_PER_EVENT + 1);
    expect([...m.status.values()].every(s => s === 'pending')).toBe(true);
    expect(m.refusals).toHaveLength(1);
    expect(m.ledger).toEqual([]);
  });

  it(`cancels exactly ${MAX_CANCELS_PER_EVENT} — the cap is inclusive`, async () => {
    const rows = Array.from({ length: MAX_CANCELS_PER_EVENT }, (_, i) => reviewFix({ id: `fix-${i}` }));
    const m = memoryStore(rows);
    const result = await reconcileSubjectEvent(approve(), { store: m.store });
    expect(result.cancelled).toHaveLength(MAX_CANCELS_PER_EVENT);
  });

  it('a rules restriction runs only those rules', async () => {
    const m = memoryStore([reviewer(), reviewFix()]);
    const result = await reconcileSubjectEvent(merged, { store: m.store, rules: ['merge_supersedes_review'] });
    expect(result.cancelled.map(c => c.taskId)).toEqual(['review-1']);
    expect(m.status.get('fix-1')).toBe('pending');
  });

  it('loads event facts only when a subject rule could use them', async () => {
    let loaded = 0;
    const m = memoryStore([anchored()], { facts: DEAD });
    const store = { ...m.store, loadEventFacts: async () => { loaded++; return DEAD; } };
    await reconcileSubjectEvent(approve(), { store });
    expect(loaded).toBe(0);
    await reconcileSubjectEvent(closed, { store });
    expect(loaded).toBe(1);
    expect(m.status.get('anchored-1')).toBe('cancelled');
  });

  it('a CAS narrowed to unstarted work loses to a worker that just claimed the task', async () => {
    const m = memoryStore([anchored()], { facts: DEAD });
    const store = {
      ...m.store,
      casCancel: async (t: SupersessionCandidate, rule: SupersessionRule) => {
        m.status.set(t.id, 'in_progress'); // claimed between the read and the write
        return m.store.casCancel(t, rule);
      },
    };
    const result = await reconcileSubjectEvent(closed, { store });
    expect(result.cancelled).toEqual([]);
    expect(result.lostRace).toEqual(['anchored-1']);
    expect(m.ledger).toEqual([]);
  });

  it('never throws — a store failure returns an empty result', async () => {
    const m = memoryStore([reviewFix()]);
    const store = { ...m.store, loadCandidates: async () => { throw new Error('db down'); } };
    const result = await reconcileSubjectEvent(approve(), { store });
    expect(result.cancelled).toEqual([]);
  });
});

describe('checkDispatch / guardDispatchedTask', () => {
  const proposal: DispatchProposal = {
    kind: 'fix', workspaceId: WS, prNumber: PR, parentTaskId: ORIGINAL, triggeringReviewTaskId: 'review-1', door: 't',
  };

  it('keeps when the triggering round is still the newest', async () => {
    const m = memoryStore([], { dispatch: { prState: 'open', newestReviewTaskId: 'review-1', newestReviewVerdict: 'request-changes' } });
    expect((await checkDispatch(proposal, { store: m.store })).verdict).toBe('keep');
  });

  it('fails open (keep) when the facts cannot be read', async () => {
    const m = memoryStore([]);
    const store = { ...m.store, loadDispatchFacts: async () => { throw new Error('db down'); } };
    expect((await checkDispatch(proposal, { store })).verdict).toBe('keep');
  });

  it('cancels only the just-inserted row when an approve landed after the first check', async () => {
    const inserted = reviewFix({ id: 'fix-new', reviewerRetryHeadSha: 'sha-new', createdAt: new Date('2026-01-03T00:00:00Z') });
    const newerRoundFix = reviewFix({ id: 'fix-newer', reviewerRetryHeadSha: 'sha-newer' });
    const m = memoryStore([inserted, newerRoundFix], { dispatch: { newestReviewTaskId: 'review-2', newestReviewVerdict: null } });
    const cancelledRow = await guardDispatchedTask(proposal, 'fix-new', requestChanges({ reviewerTaskId: 'review-1' }), { store: m.store });
    expect(cancelledRow).toBe(true);
    expect(m.status.get('fix-new')).toBe('cancelled');
    expect(m.status.get('fix-newer')).toBe('pending');
    expect(m.ledger).toEqual([{ taskId: 'fix-new', rule: 'newer_verdict_supersedes_fix', event: 'verdict' }]);
  });

  it('leaves the inserted row alone when nothing changed', async () => {
    const m = memoryStore([reviewFix({ id: 'fix-new' })], { dispatch: { newestReviewTaskId: 'review-1' } });
    expect(await guardDispatchedTask(proposal, 'fix-new', requestChanges(), { store: m.store })).toBe(false);
    expect(m.status.get('fix-new')).toBe('pending');
  });
});
