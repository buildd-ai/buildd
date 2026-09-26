/**
 * The completion record, as a reader sees it. The note body is written by
 * `completeMission` (lib/mission-completion.ts) in a machine shape; the mission
 * page humanises it at render. Fixtures are illustrative.
 */
import { describe, expect, it } from 'bun:test';
import { formatCompletionRecord, situationRepeatsCompletion } from './mission-completion-record';

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000 - 60_000).toISOString();

describe('formatCompletionRecord', () => {
  it('reads the deliverable histogram as "N delivered · M cancelled", delivered first', () => {
    expect(formatCompletionRecord('Deliverables: cancelled: 9, completed: 12')).toBe('12 delivered · 9 cancelled');
    expect(formatCompletionRecord('Deliverables: failed: 1, completed: 3, cancelled: 2'))
      .toBe('3 delivered · 1 failed · 2 cancelled');
    expect(formatCompletionRecord('Deliverables: completed: 1')).toBe('1 delivered');
    expect(formatCompletionRecord('Deliverables: none')).toBe('No deliverables');
  });

  it('replaces the raw ISO evaluation time with the app’s relative time', () => {
    const out = formatCompletionRecord(`Goal criteria: pass (evaluated ${hoursAgo(3)})`);
    expect(out).toBe('Goal criteria: pass · evaluated 3h ago');
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('formats the whole record line by line and leaves other lines alone', () => {
    const body = `Deliverables: cancelled: 9, completed: 12\nGoal criteria: pass (evaluated ${hoursAgo(26)})\nSignal: all deliverables merged`;
    expect(formatCompletionRecord(body)).toBe(
      '12 delivered · 9 cancelled\nGoal criteria: pass · evaluated 1d ago\nSignal: all deliverables merged',
    );
  });

  it('keeps a criteria line with no evaluation time, and an unparseable time, readable', () => {
    expect(formatCompletionRecord('Goal criteria: unavailable (no criteria)')).toBe('Goal criteria: unavailable (no criteria)');
    expect(formatCompletionRecord('Goal criteria: pass (evaluated soon)')).toBe('Goal criteria: pass (evaluated soon)');
  });

  it('leaves an unrecognised deliverables line as written', () => {
    expect(formatCompletionRecord('Deliverables: all of them')).toBe('Deliverables: all of them');
  });
});

describe('situationRepeatsCompletion', () => {
  it('is true for a complete mission that shows its completion summary', () => {
    expect(situationRepeatsCompletion('complete', true)).toBe(true);
  });

  it('keeps the situation block when there is no completion summary to carry the answer', () => {
    expect(situationRepeatsCompletion('complete', false)).toBe(false);
  });

  it('never hides the situation for a mission that is not complete', () => {
    for (const state of ['running', 'idle', 'waiting_decision', 'blocked', null, undefined]) {
      expect(situationRepeatsCompletion(state, true)).toBe(false);
    }
  });
});
