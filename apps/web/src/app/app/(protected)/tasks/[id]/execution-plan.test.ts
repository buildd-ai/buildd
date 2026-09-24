/**
 * Addendum D9 (docs/design/mission-feed-mobile-continuity.md): reviewer and
 * retry attempts never render as the task page's "Execution plan", and the
 * deliverable text is not printed twice (description + summary).
 * Fixtures are illustrative.
 */
import { describe, expect, it } from 'bun:test';
import {
  descriptionDuplicatesSummary,
  isAttemptTask,
  partitionChildTasks,
  selectExecutionPlan,
} from './execution-plan';

const work = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: `Step ${id}`, status: 'completed', taskClass: 'work' as string | null, parentTaskId: 'plan', mode: 'execution' as string | null, ...over,
});
const attempt = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: `[reviewer #1] Step`, status: 'completed', taskClass: 'attempt' as string | null, parentTaskId: 'b', mode: null as string | null, ...over,
});

describe('isAttemptTask', () => {
  it('reads the stored discriminator first', () => {
    expect(isAttemptTask({ taskClass: 'attempt' })).toBe(true);
    expect(isAttemptTask({ taskClass: 'work', title: '[reviewer #2] X', parentTaskId: 'p' })).toBe(false);
    expect(isAttemptTask({ taskClass: 'bookkeeping' })).toBe(false);
  });

  it('falls back to the title/parent rule for rows with no taskClass', () => {
    expect(isAttemptTask({ taskClass: null, title: '[reviewer #1] Add lease column', parentTaskId: 'p' })).toBe(true);
    expect(isAttemptTask({ taskClass: null, title: '[CI retry #1] Add lease column', parentTaskId: 'p' })).toBe(true);
    // A spawned execution child of a planning task is a unit of work, not an attempt.
    expect(isAttemptTask({ taskClass: null, title: 'Add lease column', parentTaskId: 'p', mode: 'execution' })).toBe(false);
    expect(isAttemptTask({ taskClass: null, title: 'Add lease column', parentTaskId: null })).toBe(false);
  });
});

describe('selectExecutionPlan', () => {
  it('drops attempts from the chain', () => {
    const chain = [work('plan', { parentTaskId: null, mode: 'planning' }), work('a'), attempt('a-r1', { parentTaskId: 'a' }), work('b')];
    expect(selectExecutionPlan({ id: 'a', taskClass: 'work' }, chain).map(t => t.id)).toEqual(['plan', 'a', 'b']);
  });

  it('a builder whose only children are reviewer/retry passes has no execution plan', () => {
    const chain = [work('b', { parentTaskId: null }), attempt('r1'), attempt('r2', { title: '[CI retry #1] Step' })];
    expect(selectExecutionPlan({ id: 'b', taskClass: 'work' }, chain)).toEqual([]);
  });

  it('viewing an attempt never shows the attempts as a plan', () => {
    const chain = [work('b', { parentTaskId: null }), attempt('r1'), attempt('r2')];
    expect(selectExecutionPlan({ id: 'r1', taskClass: 'attempt' }, chain)).toEqual([]);
  });

  it('a chain holding only the current task is empty (self-loop)', () => {
    expect(selectExecutionPlan({ id: 'a', taskClass: 'work' }, [work('a')])).toEqual([]);
  });
});

describe('partitionChildTasks', () => {
  it('separates attempts from genuine subtasks, keeping order', () => {
    const { subtasks, attempts } = partitionChildTasks([work('s1'), attempt('r1'), work('s2'), attempt('r2')]);
    expect(subtasks.map(t => t.id)).toEqual(['s1', 's2']);
    expect(attempts.map(t => t.id)).toEqual(['r1', 'r2']);
  });
});

describe('descriptionDuplicatesSummary', () => {
  const summary = 'Added the lease column and a backfill.\n\nTests cover expiry and renewal.';

  it('is true for the same text, modulo whitespace', () => {
    expect(descriptionDuplicatesSummary(`  ${summary.replace('\n\n', '\n\n\n\n')}  `, summary)).toBe(true);
  });

  it('is true when one is a near-complete copy of the other', () => {
    expect(descriptionDuplicatesSummary(`## Summary\n\n${summary}`, summary)).toBe(true);
  });

  it('is false for a short brief that merely appears inside a long summary', () => {
    expect(descriptionDuplicatesSummary('lease column', summary)).toBe(false);
  });

  it('is false when either side is missing', () => {
    expect(descriptionDuplicatesSummary(null, summary)).toBe(false);
    expect(descriptionDuplicatesSummary(summary, undefined)).toBe(false);
    expect(descriptionDuplicatesSummary('', '')).toBe(false);
  });
});
