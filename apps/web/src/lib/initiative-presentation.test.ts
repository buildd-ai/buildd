import { describe, it, expect } from 'bun:test';
import { sortInitiatives, initiativeStatusChip, motionLabel } from './initiative-presentation';

const item = (status: string, lastMotionAt: string | null, id = status) => ({ id, progress: { status }, lastMotionAt });

describe('sortInitiatives', () => {
  it('floats blocked to the top regardless of motion', () => {
    const out = sortInitiatives([
      item('active', '2026-07-26T10:00:00.000Z', 'a'),
      item('blocked', '2026-07-01T00:00:00.000Z', 'b'),
    ]);
    expect(out.map((i) => i.id)).toEqual(['b', 'a']);
  });

  it('orders the status bands blocked > active > paused > completed > empty', () => {
    const out = sortInitiatives([
      item('empty', null, 'e'),
      item('completed', '2026-07-26T00:00:00.000Z', 'c'),
      item('paused', '2026-07-26T00:00:00.000Z', 'p'),
      item('active', '2026-07-26T00:00:00.000Z', 'a'),
      item('blocked', '2026-07-26T00:00:00.000Z', 'b'),
    ]);
    expect(out.map((i) => i.id)).toEqual(['b', 'a', 'p', 'c', 'e']);
  });

  it('within a band, newest motion first and no-motion sinks', () => {
    const out = sortInitiatives([
      item('active', null, 'none'),
      item('active', '2026-07-20T00:00:00.000Z', 'older'),
      item('active', '2026-07-26T00:00:00.000Z', 'newer'),
    ]);
    expect(out.map((i) => i.id)).toEqual(['newer', 'older', 'none']);
  });

  it('does not mutate the input', () => {
    const input = [item('active', '2026-07-26T00:00:00.000Z', 'a'), item('blocked', null, 'b')];
    const copy = [...input];
    sortInitiatives(input);
    expect(input).toEqual(copy);
  });
});

describe('initiativeStatusChip', () => {
  it('labels each status and stays on token classes', () => {
    expect(initiativeStatusChip('blocked').label).toBe('BLOCKED');
    expect(initiativeStatusChip('active').label).toBe('ACTIVE');
    expect(initiativeStatusChip('completed').label).toBe('COMPLETED');
    expect(initiativeStatusChip('empty').label).toBe('EMPTY');
    expect(initiativeStatusChip('weird').label).toBe('EMPTY'); // unknown → empty
    for (const s of ['blocked', 'active', 'paused', 'completed', 'empty']) {
      expect(initiativeStatusChip(s).className).not.toMatch(/#[0-9a-f]{3,6}/i); // no raw hex
    }
  });
});

describe('motionLabel', () => {
  it('returns "no activity yet" when there is no motion', () => {
    expect(motionLabel({ progress: { status: 'empty' }, lastMotionAt: null })).toBe('no activity yet');
  });

  it('picks the verb from rollup status so it cannot contradict the chip', () => {
    const at = '2026-01-01T00:00:00.000Z';
    expect(motionLabel({ progress: { status: 'completed' }, lastMotionAt: at }).startsWith('shipped ')).toBe(true);
    expect(motionLabel({ progress: { status: 'blocked' }, lastMotionAt: at }).startsWith('blocked ')).toBe(true);
    expect(motionLabel({ progress: { status: 'paused' }, lastMotionAt: at }).startsWith('paused ')).toBe(true);
    expect(motionLabel({ progress: { status: 'active' }, lastMotionAt: at }).startsWith('moved ')).toBe(true);
  });
});
