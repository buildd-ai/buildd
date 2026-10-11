import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  adviceViewFromRow,
  attachMergeAdvice,
  latestAnswerPerPr,
  mergeAdviceDigest,
  signMergeAdviceToken,
  verifyMergeAdviceToken,
  type MergeAdviceBase,
  type MergeAdviceRow,
} from './merge-advice-server';
import { mergeAdviceSubjectId, type MergeAdviceFacts } from './merge-advice';
import type { ActionQueueItem } from './action-queue';

const facts = (over: Partial<MergeAdviceFacts> = {}): MergeAdviceFacts => ({
  ci: 'green', review: 'escalated', reviewConfidence: 'high', reviewCoversHead: true, blockers: ['migration'],
  policyTier: 'agent-review', githubApprovalRequired: false, draft: false, refreshFirst: false, missionBlocked: false,
  escalationCause: 'reviewer', diffSize: 'medium', ...over,
});
const row = (over: Partial<MergeAdviceRow> = {}): MergeAdviceRow => ({
  subjectId: mergeAdviceSubjectId('ws-1', 7, 'head-1'), fingerprint: mergeAdviceDigest(facts()),
  appliedAnswer: 'needs_human', reason: 'fallback:no_call; cause=shadow; chain=cheap', failureClass: null,
  verdict: 'merge_now', confidence: 0.2, model: 'example/decider-1',
  createdAt: new Date('2026-01-01T00:00:00Z'), ...over,
});

let savedSecret: string | undefined;
beforeEach(() => { savedSecret = process.env.AUTH_SECRET; process.env.AUTH_SECRET = 'test-secret'; });
afterEach(() => { if (savedSecret === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = savedSecret; });

describe('signed facts', () => {
  const input = { workspaceId: 'ws-1', prNumber: 7, headSha: 'head-1', taskId: 'task-1', facts: facts() };

  it('round-trips and binds the facts to one PR head', () => {
    const v = verifyMergeAdviceToken(signMergeAdviceToken(input, 1_000), 2_000);
    expect(v).toMatchObject({ ok: true, payload: input });
  });

  it('refuses a tampered body, an expired token and a missing secret', () => {
    const token = signMergeAdviceToken(input, 1_000)!;
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), facts: facts({ ci: 'green', review: 'approved' }) })).toString('base64url');
    expect(verifyMergeAdviceToken(`${forged}.${sig}`, 2_000)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyMergeAdviceToken(token, 1_000 + 31 * 60 * 1000)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyMergeAdviceToken('nope', 2_000)).toEqual({ ok: false, reason: 'malformed' });
    delete process.env.AUTH_SECRET;
    expect(signMergeAdviceToken(input)).toBeNull();
  });
});

describe('stored answers', () => {
  it('is current only for the same head and facts', () => {
    expect(adviceViewFromRow(row(), { headSha: 'head-1', facts: facts() })?.stale).toBeNull();
    expect(adviceViewFromRow(row(), { headSha: 'head-2', facts: facts() })?.stale).toBe('new_commits');
    expect(adviceViewFromRow(row(), { headSha: 'head-1', facts: facts({ blockers: ['security'] }) })?.stale).toBe('facts_changed');
  });

  it('shows the recorded model yes only at the display threshold, naming the model for the tooltip', () => {
    const current = { headSha: 'head-1', facts: facts() };
    expect(adviceViewFromRow(row({ confidence: 0.5 }), current)).toMatchObject({ line: 'Model: looks safe to merge as-is.', model: 'example/decider-1', recorded: true });
    expect(adviceViewFromRow(row({ confidence: 0.2 }), current)?.line).toBeNull();
    expect(adviceViewFromRow(row({ verdict: 'needs_human', confidence: 0.9 }), current)?.line).toBeNull();
  });

  it('never shows a capability-off or no-key fallback as advice', () => {
    expect(adviceViewFromRow(row({ failureClass: 'capability', appliedAnswer: 'needs_human', reason: 'fallback:fallback_disabled' }), { headSha: 'head-1', facts: facts() })).toBeNull();
    expect(adviceViewFromRow(row({ failureClass: 'key', reason: 'fallback:fallback_no_provider' }), { headSha: 'head-1', facts: facts() })).toBeNull();
  });

  it('keeps the newest answer per PR, skipping non-answers', () => {
    const newest = row({ subjectId: mergeAdviceSubjectId('ws-1', 7, 'head-2'), failureClass: 'key' });
    const answer = row();
    const other = row({ subjectId: mergeAdviceSubjectId('ws-1', 8, 'h') });
    const latest = latestAnswerPerPr([newest, answer, other]);
    expect(latest.get('ws-1#7')).toBe(answer);
    expect(latest.get('ws-1#8')).toBe(other);
  });
});

describe('attachMergeAdvice', () => {
  const base: MergeAdviceBase = {
    prLifecycleStatus: 'ci_green', review: 'escalated', reviewConfidence: 0.9, reviewHeadSha: 'head-1',
    githubApprovalRequired: false, draft: false, policyTier: 'agent-review',
    escalationCause: 'reviewer', linesAdded: 150, linesRemoved: 20,
  };
  const card = (over: Partial<ActionQueueItem> = {}): ActionQueueItem => ({
    subjectKey: 'pr:ws-1:7', chip: 'REVIEW', prNumber: 7, workspaceId: 'ws-1', workerId: 'w-1', taskId: 'task-1', headSha: 'head-1',
    humanReview: { label: 'Review on GitHub', reason: 'A schema change needs a person.', decision: 'Approve the migration.', blockers: [{ kind: 'migration', text: 'adds a table' }] },
    ...over,
  } as ActionQueueItem);

  it('gives a human-review card its stored answer and a token for the same facts', async () => {
    const [item] = await attachMergeAdvice([card()], new Map([['w-1', base]]), { readRows: async () => [row()], now: () => 1_000 });
    expect(item!.mergeAdvice).toMatchObject({ prNumber: 7, workspaceId: 'ws-1', unavailable: null, advice: { decision: 'needs_human', stale: null } });
    const v = verifyMergeAdviceToken(item!.mergeAdvice!.token, 2_000);
    expect(v.ok && v.payload.facts).toEqual(facts());
  });

  it('folds the refresh dependency into the facts, so an answer from before it reads as changed', async () => {
    const [item] = await attachMergeAdvice([card({ refreshFirst: { prNumber: 9, prUrl: null, taskId: null, chip: 'RESOLVING' } })], new Map([['w-1', base]]), { readRows: async () => [row()] });
    expect(item!.mergeAdvice!.advice?.stale).toBe('facts_changed');
  });

  it('shows the rule answer before anyone asks, free, and still offers Assess', async () => {
    const policyOnly = { ...base, escalationCause: 'policy' as const };
    const [item] = await attachMergeAdvice([card()], new Map([['w-1', policyOnly]]), { readRows: async () => [], now: () => 1_000 });
    expect(item!.mergeAdvice!.advice).toMatchObject({
      source: 'rule', recorded: false, line: 'From the PR state: looks mergeable as-is.', reasonCode: 'rule_mergeable_as_is',
    });
  });

  it('an XL or unreported diff never looks mergeable as-is', async () => {
    for (const lines of [{ linesAdded: 1500, linesRemoved: 0 }, { linesAdded: null, linesRemoved: null }]) {
      const [item] = await attachMergeAdvice([card()], new Map([['w-1', { ...base, escalationCause: 'policy' as const, ...lines }]]), { readRows: async () => [] });
      expect(item!.mergeAdvice!.advice).toBeNull();
    }
  });

  it('leaves other cards alone and survives a failed read', async () => {
    const items = [card(), card({ subjectKey: 'x', chip: 'MERGE' }), card({ subjectKey: 'y', humanReview: null })];
    const out = await attachMergeAdvice(items, new Map([['w-1', base]]), { readRows: async () => { throw new Error('db down'); } });
    expect(out[0]!.mergeAdvice).toMatchObject({ advice: null });
    expect(out[1]!.mergeAdvice).toBeUndefined();
    expect(out[2]!.mergeAdvice).toBeUndefined();
  });

  it('says it cannot ask when the server cannot sign', async () => {
    delete process.env.AUTH_SECRET;
    const prevNext = process.env.NEXTAUTH_SECRET; const prevEnc = process.env.ENCRYPTION_KEY;
    delete process.env.NEXTAUTH_SECRET; delete process.env.ENCRYPTION_KEY;
    try {
      const [item] = await attachMergeAdvice([card()], new Map([['w-1', base]]), { readRows: async () => [] });
      expect(item!.mergeAdvice).toMatchObject({ token: null, unavailable: 'This server cannot sign the request.' });
    } finally {
      if (prevNext !== undefined) process.env.NEXTAUTH_SECRET = prevNext;
      if (prevEnc !== undefined) process.env.ENCRYPTION_KEY = prevEnc;
    }
  });
});
