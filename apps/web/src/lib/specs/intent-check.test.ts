import { describe, expect, it } from 'bun:test';
import { independenceRefusal, parseFindings, recordIntentCheck, type IntentFacts } from './intent-check';
import type { SpecCaller } from './store';

const C = '11111111-1111-4111-8111-111111111111';
const S = '33333333-3333-4333-8333-333333333333';
const M = '22222222-2222-4222-8222-222222222222';
const task = (accountId: string, taskId: string): SpecCaller => ({ kind: 'account', account: { id: accountId, taskScope: { workspaceId: 'w', taskId } } as never });
const facts = (over: Partial<IntentFacts> = {}): IntentFacts => ({
  workspaceId: 'w', revision: 2, contentHash: 'h', provenance: { conversationId: C, messageId: M, messageAt: '2026-01-01T00:00:00Z' },
  drafterId: 'acct-drafter', drafterTaskId: 'task-drafter', pinnedTaskIds: ['task-builder'], ...over,
});
const deps = (f: IntentFacts | null, saved: unknown[] = []) => ({ load: async () => f, save: async (row: unknown) => { saved.push(row); return true; }, reachable: async () => true });
const finding = { kind: 'mismatch', text: 'The draft lets refunds wait for packing, but you said they never should.', recommended: 'Change the draft to refund at once.' };
const input = { revision: 2, contentHash: 'h', conversationId: C, messageIds: [M], findings: [finding] };

describe('independence', () => {
  it('refuses the drafter account, the drafting task and any task pinned to the spec', () => {
    expect(independenceRefusal(task('acct-drafter', 't-x'), facts())).toMatchObject({ status: 403, code: 'checker_not_independent' });
    expect(independenceRefusal(task('acct-other', 'task-drafter'), facts())).toMatchObject({ status: 403 });
    expect(independenceRefusal(task('acct-other', 'task-builder'), facts())).toMatchObject({ status: 403 });
    expect(independenceRefusal({ kind: 'user', userId: 'acct-drafter' }, facts())).toMatchObject({ status: 403 });
  });
  it('refuses a caller that cannot be shown independent (an unscoped key shares the drafter\'s account only by id, so a person is refused: a person answers, never checks)', () => {
    expect(independenceRefusal({ kind: 'user', userId: 'owner' }, facts())).toMatchObject({ status: 403 });
  });
  it('accepts an unrelated task', () => {
    expect(independenceRefusal(task('acct-other', 'task-checker'), facts())).toBeNull();
  });
});

describe('parseFindings', () => {
  it('needs one sentence with a recommended answer, batched up to a cap', () => {
    expect(parseFindings([finding])).toMatchObject({ ok: true });
    expect(parseFindings([{ ...finding, recommended: '' }])).toMatchObject({ ok: false, status: 400 });
    expect(parseFindings([{ ...finding, text: 'One. Two.' }])).toMatchObject({ ok: false, status: 400 });
    expect(parseFindings([{ ...finding, kind: 'pass' }])).toMatchObject({ ok: false, status: 400 });
    expect(parseFindings(Array(40).fill(finding))).toMatchObject({ ok: false, status: 400 });
  });
  it('accepts no findings: a clean check', () => {
    expect(parseFindings([])).toEqual({ ok: true, questions: [] });
  });
});

describe('recordIntentCheck', () => {
  it('refuses the drafter and stores nothing', async () => {
    const saved: unknown[] = [];
    const r = await recordIntentCheck(task('acct-drafter', 't'), S, input, deps(facts(), saved));
    expect([r.ok, (r as { status?: number }).status, saved.length]).toEqual([false, 403, 0]);
  });
  it('turns a mismatch into a question for the owner', async () => {
    const saved: Array<{ questions: unknown[] }> = [];
    const r = await recordIntentCheck(task('acct-other', 'task-checker'), S, input, deps(facts(), saved));
    expect(r).toMatchObject({ ok: true, questions: [{ kind: 'mismatch', text: finding.text, recommended: finding.recommended }] });
    expect(saved[0].questions).toHaveLength(1);
  });
  it('a clean check records no question', async () => {
    const saved: Array<{ questions: unknown[] }> = [];
    const r = await recordIntentCheck(task('acct-other', 'task-checker'), S, { ...input, findings: [] }, deps(facts(), saved));
    expect(r).toMatchObject({ ok: true, questions: [] });
    expect(saved[0].questions).toEqual([]);
  });
  it('refuses a revision with no provenance, a moved hash, a different conversation, and a second result', async () => {
    const c = task('acct-other', 'task-checker');
    expect(await recordIntentCheck(c, S, input, deps(facts({ provenance: null })))).toMatchObject({ ok: false, status: 409, code: 'no_provenance' });
    expect(await recordIntentCheck(c, S, { ...input, contentHash: 'old' }, deps(facts()))).toMatchObject({ ok: false, status: 409 });
    expect(await recordIntentCheck(c, S, { ...input, conversationId: M }, deps(facts()))).toMatchObject({ ok: false, status: 400 });
    expect(await recordIntentCheck(c, S, input, { ...deps(facts()), save: async () => false })).toMatchObject({ ok: false, status: 409, code: 'already_checked' });
  });
});
