import { describe, it, expect } from 'bun:test';
import { completedWithoutPr } from './task-completed-without-pr';

describe('completedWithoutPr', () => {
  it('names the recorded no-PR outcome of a completed task', () => {
    expect(completedWithoutPr({ status: 'completed', result: { refreshAlreadyLanded: { branch: 'mission/a' } } })).toMatch(/already contained/);
    expect(completedWithoutPr({ status: 'completed', result: { alreadyShippedIn: { prNumber: 7 } } })).toMatch(/already shipped/);
    expect(completedWithoutPr({ status: 'completed', result: { discardedEdits: 'scratch' } })).toMatch(/discarded/);
  });

  it('is null for a completion that recorded no such outcome', () => {
    expect(completedWithoutPr({ status: 'completed', result: { summary: 'done' } })).toBeNull();
    expect(completedWithoutPr({ status: 'completed', result: null })).toBeNull();
  });

  it('is null for a task that is not completed: a requeued or running task may still open its PR', () => {
    expect(completedWithoutPr({ status: 'in_progress', result: { refreshAlreadyLanded: {} } })).toBeNull();
    expect(completedWithoutPr({ status: 'pending', result: { discardedEdits: 'x' } })).toBeNull();
    expect(completedWithoutPr(null)).toBeNull();
  });
});
