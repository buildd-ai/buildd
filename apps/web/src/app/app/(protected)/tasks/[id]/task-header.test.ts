import { describe, test, expect } from 'bun:test';
import { headerLifecycle, taskHeading, type LifecycleInput } from './task-header';

describe('taskHeading', () => {
  test('a conventional title becomes eyebrow parts + a readable subject', () => {
    expect(taskHeading({ title: "feat(invoices): render invoices in the customer's currency", label: null }, 'Builder')).toEqual({
      eyebrow: ['feat', 'invoices', 'Builder'],
      heading: "Render invoices in the customer's currency",
    });
  });

  test('a stored scope-less title keeps the whole title and just the role', () => {
    expect(taskHeading({ title: 'Investigate the flaky login test', label: null }, 'Researcher')).toEqual({
      eyebrow: ['Researcher'],
      heading: 'Investigate the flaky login test',
    });
  });

  test('type without scope, and no role', () => {
    expect(taskHeading({ title: 'fix: handle empty carts', label: null }, null)).toEqual({
      eyebrow: ['fix'],
      heading: 'Handle empty carts',
    });
  });

  test('retry bracket prefixes are peeled into the eyebrow, not the heading', () => {
    const h = taskHeading({ title: '[builder · after CI #1] feat(invoices): render invoices', label: null }, 'Builder');
    expect(h.heading).toBe('Render invoices');
    expect(h.eyebrow).toEqual(['feat', 'invoices', 'Builder', 'after CI #1']);
  });
});

describe('taskHeading delegates to displayTaskTitle', () => {
  test('a mission refresh title reads the same as on every other surface', () => {
    expect(taskHeading({ title: 'chore(mission): merge dev into the Widget Polish integration branch', label: null }, null).heading)
      .toBe('Refresh Widget Polish from dev');
  });

  test('a ship title behind a retry wrap', () => {
    expect(taskHeading({ title: '[builder · after review #2] Ship mission: Widget Polish', label: null }, null).heading)
      .toBe('Ship Widget Polish');
  });
});

describe('taskHeading names the role once (docs/specs/task-page.md AC-9)', () => {
  test('a reviewer bracket equal to the role name is not repeated', () => {
    const h = taskHeading({ title: '[reviewer] PR #4413: Urgent: finish landing', label: null }, 'Reviewer');
    expect(h.eyebrow.filter(e => e.toLowerCase() === 'reviewer')).toHaveLength(1);
  });
  test('a qualifier that is not the role stays', () => {
    expect(taskHeading({ title: '[builder · after CI #1] fix: x', label: null }, 'Builder').eyebrow).toContain('after CI #1');
  });
});

const V = (o: Partial<LifecycleInput> = {}): LifecycleInput => ({
  stage: 'review', state: 'AWAITING_REVIEW', stateReason: null, prState: 'awaiting_ci', headSha: 'H', rounds: [], ...o,
});

describe('headerLifecycle (docs/specs/task-page.md, State mapping)', () => {
  test('AC-2: a base refresh is Audit · updating branch, never a repair', () => {
    expect(headerLifecycle(V({ stage: 'repairing', state: 'REPAIRING', stateReason: 'behind' }))).toEqual({ state: 'review', phrase: 'updating branch' });
  });
  test('an agent CI repair is the one that reads as fixing', () => {
    expect(headerLifecycle(V({ stage: 'repairing', state: 'REPAIRING', stateReason: 'ci' }))).toEqual({ state: 'fixing', phrase: 'fixing CI' });
    expect(headerLifecycle(V({ stage: 'fixing', state: 'FIXING' }))).toEqual({ state: 'fixing', phrase: 'fixing review feedback' });
  });
  test('review: in review while a reviewer works, awaiting review before', () => {
    const r = { id: 'r', round: 1, headSha: 'H', kind: 'full' as const, verdict: null, effectiveVerdict: null, failureCount: 0 };
    expect(headerLifecycle(V({ rounds: [{ ...r, status: 'reviewing' }] }))).toEqual({ state: 'review', phrase: 'in review' });
    expect(headerLifecycle(V({ rounds: [{ ...r, status: 'queued' }] }))).toEqual({ state: 'review', phrase: 'awaiting review' });
    expect(headerLifecycle(V({ state: 'CHANGES_REQUESTED' }))).toEqual({ state: 'review', phrase: 'changes requested' });
  });
  test('approved waits on the merge; checks pending say so', () => {
    expect(headerLifecycle(V({ stage: 'approved', state: 'APPROVED', prState: 'ci_passed' }))).toEqual({ state: 'landing', phrase: 'awaiting merge' });
    expect(headerLifecycle(V({ stage: 'approved', state: 'APPROVED', prState: 'awaiting_ci' }))).toEqual({ state: 'landing', phrase: 'approved · checking' });
    expect(headerLifecycle(V({ stage: 'landing', state: 'LANDING' }))).toEqual({ state: 'landing', phrase: 'merging' });
  });
  test('merged only on the merge fact; closed is not landed', () => {
    expect(headerLifecycle(V({ stage: 'merged', state: 'MERGED' }))).toEqual({ state: 'landed', phrase: null });
    expect(headerLifecycle(V({ stage: 'closed', state: 'CLOSED_UNMERGED' }))).toEqual({ state: 'not_landed', phrase: null });
  });
  test('no track without a delivery, or for superseded work', () => {
    expect(headerLifecycle(null)).toBeNull();
    expect(headerLifecycle(V({ stage: 'superseded', state: 'SUPERSEDED' }))).toBeNull();
  });
});
