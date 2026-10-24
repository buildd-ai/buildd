import { describe, expect, it } from 'bun:test';
import { buildTaskTimeline } from './task-timeline';

const attempt = (id: string, family: string, triggerReason: string | null, extra = {}) => ({ id, family, triggerReason, mode: 'agent', attemptNo: 1, taskId: id, status: 'completed', outcome: 'delivered', reportedShas: [], boundHeadSha: 'old', maxAttempts: 3, ...extra });
const round = (id: string, n: number) => ({ id, round: n, headSha: 'old', status: 'decided', verdict: 'request_changes', effectiveVerdict: null });
const worker = (id: string, extra = {}) => ({ id, status: 'completed', startedAt: new Date(0), completedAt: new Date(60000), ...extra });
const build = (extra = {}) => buildTaskTimeline({ task: { status: 'completed' }, workers: [worker('builder')], kind: 'landed', ...extra } as never);

describe('task timeline', () => {
  it('groups Build, Verify, Deliver and nests repairs under exactly their triggering round', () => {
    const groups = build({ delivery: { rounds: [round('r1', 1), round('r2', 2)], ledger: [attempt('fix2', 'review_fix', 'r2'), attempt('fix1', 'review_fix', 'r1')], prState: 'merged', state: 'MERGED' } });
    expect(groups.map(g => g.label)).toEqual(['Build', 'Verify', 'Deliver']);
    const reviews = groups[1].events.filter(e => e.id.startsWith('round:'));
    expect(reviews.map(e => e.children.map(c => c.taskId))).toEqual([['fix1'], ['fix2']]);
  });
  it('keeps mechanical refreshes in Deliver and does not call them fixes', () => {
    const groups = build({ delivery: { rounds: [], ledger: [attempt('refresh', 'conflict', 'behind', { mode: 'mechanical' })], prState: 'merged', state: 'MERGED' } });
    expect(groups[2].events[0].label).toBe('Branch update');
    expect(groups[1].events).toHaveLength(0);
  });
  it('retains unmatched CI and conflict causes without attaching them to an unrelated review', () => {
    const groups = build({ delivery: { rounds: [round('r1', 1)], ledger: [attempt('ci', 'ci', 'failed'), attempt('conflict', 'conflict', 'conflict')], prState: 'ci_failed', state: 'REPAIRING' } });
    expect(groups[1].events.find(e => e.id === 'round:r1')?.children).toEqual([]);
    expect(groups[1].events.find(e => e.label === 'CI failed')?.children[0].taskId).toBe('ci');
    expect(groups[2].events.find(e => e.label === 'Merge conflict')?.children[0].taskId).toBe('conflict');
  });
  it('collapses lost claims and keeps real build attempts in chronological order', () => {
    const groups = build({ workers: [worker('last'), worker('lost2', { status: 'failed', exitCause: 'never_started' }), worker('lost1', { status: 'failed', exitCause: 'never_started' }), worker('first')] });
    expect(groups[0].events.map(e => e.id)).toEqual(['worker:first', 'claims:lost2', 'worker:last']);
    expect(groups[0].events[1].label).toContain('2');
  });
  it('nests legacy retries beneath CI failure and omits a duplicate build attempt', () => {
    const groups = build({ lineage: [{ kind: 'attempt', title: 'First run', sub: '', at: null }, { kind: 'ci_failed', title: 'CI failed', sub: 'test', at: null }, { kind: 'retry', title: 'Retry sent', sub: '', at: null }, { kind: 'attempt', title: 'CI fix 1', n: 2, sub: '', at: null }, { kind: 'merged', title: 'Merged', sub: '', at: null }], ciAttemptTasks: [{ id: 'retry', status: 'completed' }] });
    expect(groups[1].events[0].children[0].taskId).toBe('retry');
    expect(groups[0].events).toHaveLength(1);
  });
  it('does not invent success or future stages before work starts', () => {
    expect(build({ workers: [], kind: 'waiting' })).toEqual([]);
  });
});
it('keeps a legacy fix that has no worker yet, without using it for a later completed fix', () => {
  const groups = build({ lineage: [{ kind: 'ci_failed', title: 'CI failed', sub: '', at: null }, { kind: 'attempt', n: 2, title: 'CI fix 1', sub: '', at: null }], ciAttemptTasks: [{ id: 'queued', status: 'pending', workers: [] }, { id: 'ran', status: 'completed', workers: [{}] }] });
  expect(groups[1].events[0].children[0].taskId).toBe('ran');
  expect(groups[1].events.flatMap(e => e.children).some(e => e.taskId === 'queued')).toBe(true);
});
it('reads a legacy step offset ("+3m") as no time instead of throwing', () => {
  const groups = build({ lineage: [{ kind: 'ci_failed', title: 'CI failed', sub: '', at: '4m after push' }, { kind: 'attempt', n: 2, title: 'CI fix 1', sub: '', at: '+3m' }, { kind: 'merged', title: 'Merged', sub: '', at: '+1m' }], ciAttemptTasks: [{ id: 'ran', status: 'completed', workers: [{}] }] });
  const legacy = groups.flatMap(g => g.events).filter(e => e.id.startsWith('legacy:'));
  expect(legacy.length).toBeGreaterThan(0);
  expect(legacy.every(e => e.at === null && e.children.every(c => c.at === null))).toBe(true);
});
// Surface audit ff33de4d (phone-task-merged, desktop-task-waiting; R-8, R-11).
describe('task timeline — review, ages and a task that has not run', () => {
  const legacyMerged = (extra = {}) => build({ lineage: [{ kind: 'attempt', n: 1, title: 'First run', sub: '', at: null }, { kind: 'ci_green', title: 'CI green', sub: 'checks passed', at: null }, { kind: 'merged', title: 'Merged', sub: '', at: '+1m' }], mergedAt: new Date(600000), ...extra });
  it('names a legacy PR\'s agent review in Verify, linked to its run (R-11)', () => {
    const groups = legacyMerged({ review: { taskId: 'rev', verdict: 'approve', round: 1 } });
    const review = groups[1].events.find(e => e.label === 'Code review · Approved · round 1');
    expect(review?.taskId).toBe('rev');
    expect(review?.state).toBe('passed');
  });
  it('a review that asked for changes reads so', () => {
    const groups = legacyMerged({ review: { taskId: 'rev', verdict: 'request-changes', round: 2 } });
    expect(groups[1].events.some(e => e.label === 'Code review · Changes requested · round 2' && e.state === 'failed')).toBe(true);
  });
  it('gives a linked run its stored time, and Merged the merge time (R-8)', () => {
    const groups = legacyMerged({ review: { taskId: 'rev', verdict: 'approve', round: 1 }, eventTimes: new Map([['rev', new Date(300000)]]) });
    expect(groups[1].events.find(e => e.taskId === 'rev')?.at).toBe(new Date(300000).toISOString());
    expect(groups[2].events.find(e => e.label === 'Merged')?.at).toBe(new Date(600000).toISOString());
  });
  it('a legacy CI failure carries the time its fix was dispatched', () => {
    const groups = build({ lineage: [{ kind: 'ci_failed', title: 'CI failed', sub: '', at: null }, { kind: 'attempt', n: 2, title: 'CI fix 1', sub: '', at: null }], ciAttemptTasks: [{ id: 'ran', status: 'completed', createdAt: new Date(120000), workers: [{}] }] });
    expect(groups[1].events[0].at).toBe(new Date(120000).toISOString());
  });
  it('a task waiting on another shows all three stages: what it waits on, then where it merges', () => {
    const groups = buildTaskTimeline({ task: { status: 'pending', createdAt: new Date(0) }, workers: [], kind: 'waiting', waitingOn: { taskId: 'dep', title: 'Mirror the runner image' }, deliverInto: 'dev' } as never);
    expect(groups.map(g => g.label)).toEqual(['Build', 'Verify', 'Deliver']);
    expect(groups[0].events[0]).toMatchObject({ label: 'Filed', at: new Date(0).toISOString() });
    expect(groups[1].events[0]).toMatchObject({ label: 'Runs after Mirror the runner image merges', taskId: 'dep', state: 'pending' });
    expect(groups[2].events[0]).toMatchObject({ label: 'Merge into dev', state: 'pending' });
  });
  it('a waiting task keeps its stopped attempts in Build, numbered', () => {
    const groups = buildTaskTimeline({ task: { status: 'pending' }, workers: [worker('a2', { status: 'failed' }), worker('a1', { status: 'failed' })], kind: 'waiting', waitingOn: { taskId: 'dep', title: 'Dep' }, deliverInto: null } as never);
    expect(groups[0].events.map(e => e.label)).toEqual(['Filed', 'Attempt 1 stopped', 'Attempt 2 stopped']);
    expect(groups[2].events[0].label).toBe('Merge');
  });
});
