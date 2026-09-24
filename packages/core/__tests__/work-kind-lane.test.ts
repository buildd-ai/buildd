/**
 * Rule L-1 (docs/design/mission-flight-strip.md): the flight strip's lane comes
 * from the ONE work-kind precedence chain (`resolveWorkKind`, which the web
 * `deriveWorkKind` glyph helper also reads), through a kind → lane table. No
 * title parsing, no `taskClass` rung — that was `deriveWorkLane`'s second
 * derivation, which Rule L-4 retires.
 */
import { describe, expect, it } from 'bun:test';
import {
  computeMissionFlightStrip,
  resolveWorkKind,
  workKindLane,
  WORK_KIND_LANE,
  type WorkKind,
} from '../mission-helpers';

describe('WORK_KIND_LANE (Rule L-1 table)', () => {
  it('maps every kind to the lane the spec names', () => {
    const expected: Record<WorkKind, 'think' | 'build' | 'check'> = {
      engineering: 'build',
      analysis: 'check',
      observation: 'check',
      research: 'think',
      design: 'think',
      writing: 'think',
      coordination: 'think',
    };
    expect(WORK_KIND_LANE).toEqual(expected);
  });
});

describe('resolveWorkKind', () => {
  it('kind outranks role outranks derived review type', () => {
    expect(resolveWorkKind({ kind: 'engineering', roleSlug: 'reviewer', taskType: 'review' })).toEqual({ kind: 'engineering', source: 'kind' });
    expect(resolveWorkKind({ roleSlug: 'reviewer', taskType: 'review' })).toEqual({ kind: 'analysis', source: 'role' });
    expect(resolveWorkKind({ taskType: 'review-retry' })).toEqual({ kind: 'analysis', source: 'type' });
  });

  it('an unknown kind or role falls through; a plain retry resolves to nothing', () => {
    expect(resolveWorkKind({ kind: 'refactoring', roleSlug: 'custom-bot' })).toBeNull();
    expect(resolveWorkKind({ taskType: 'retry' })).toBeNull();
  });
});

describe('workKindLane (the adapter computeMissionFlightStrip reads)', () => {
  it('derives the review type from the platform-written title prefix only', () => {
    expect(workKindLane({ title: '[reviewer #2] Add lease column' })).toBe('check');
  });

  it('never reads free-text titles: "Verify …" with no kind stays unclassified', () => {
    expect(workKindLane({ title: 'Verify the migration ran cleanly' })).toBeNull();
  });

  it('writing is THINK under Rule L-1 (it was BUILD under deriveWorkLane)', () => {
    expect(workKindLane({ kind: 'writing' })).toBe('think');
  });

  it('role builder → build even on an attempt row (no taskClass rung)', () => {
    expect(workKindLane({ taskClass: 'attempt', roleSlug: 'builder' })).toBe('build');
  });
});

describe('computeMissionFlightStrip lane source (AC-15)', () => {
  const w = (id: string, taskId: string) => ({ id, taskId, status: 'completed', startedAt: new Date(0), completedAt: new Date(100) });

  it('lanes come from the work-kind adapter, not title shape', () => {
    const strip = computeMissionFlightStrip(
      [
        { id: 'a', status: 'completed', kind: 'research' },
        { id: 'b', status: 'completed', title: 'Review the auth module' },
        { id: 'c', status: 'completed', roleSlug: 'reviewer' },
      ],
      [w('wa', 'a'), w('wb', 'b'), w('wc', 'c')],
    );
    const laneByTask = Object.fromEntries(strip.bars.map(b => [b.taskId, b.lane]));
    expect(laneByTask).toEqual({ a: 'think', b: null, c: 'check' });
    expect(strip.hasLaneData).toBe(true);
  });

  it('a mission with no resolvable kind renders one uncaptioned track', () => {
    const strip = computeMissionFlightStrip([{ id: 'a', status: 'completed', title: 'Verify deploy' }], [w('wa', 'a')]);
    expect(strip.lanes).toEqual([null]);
    expect(strip.hasLaneData).toBe(false);
  });
});
