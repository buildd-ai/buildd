import { describe, it, expect } from 'bun:test';
import { sortInitiatives, initiativeStatusChip, motionLabel, deriveInitiativeDisplayStatus } from './initiative-presentation';

// Helper that satisfies the Sortable type (both status + progress.status required).
const item = (
  status: string,
  rollupStatus: string,
  lastMotionAt: string | null,
  id = `${status}-${rollupStatus}`,
) => ({ id, status, progress: { status: rollupStatus }, lastMotionAt });

describe('deriveInitiativeDisplayStatus', () => {
  it('completed DB status always wins', () => {
    expect(deriveInitiativeDisplayStatus({ status: 'completed', rollupStatus: 'active' })).toBe('completed');
    expect(deriveInitiativeDisplayStatus({ status: 'completed', rollupStatus: 'completed' })).toBe('completed');
    expect(deriveInitiativeDisplayStatus({ status: 'completed', rollupStatus: 'blocked' })).toBe('completed');
  });

  it('paused DB status always wins', () => {
    expect(deriveInitiativeDisplayStatus({ status: 'paused', rollupStatus: 'active' })).toBe('paused');
    expect(deriveInitiativeDisplayStatus({ status: 'paused', rollupStatus: 'completed' })).toBe('paused');
  });

  it('archived DB status always wins', () => {
    expect(deriveInitiativeDisplayStatus({ status: 'archived', rollupStatus: 'active' })).toBe('archived');
  });

  it('active DB + blocked rollup → blocked', () => {
    expect(deriveInitiativeDisplayStatus({ status: 'active', rollupStatus: 'blocked' })).toBe('blocked');
  });

  it('active DB + all missions done → awaiting_verification (not completed)', () => {
    expect(deriveInitiativeDisplayStatus({ status: 'active', rollupStatus: 'completed' })).toBe('awaiting_verification');
  });

  it('active DB + missions still running → active', () => {
    expect(deriveInitiativeDisplayStatus({ status: 'active', rollupStatus: 'active' })).toBe('active');
  });

  it('active DB + no missions → empty', () => {
    expect(deriveInitiativeDisplayStatus({ status: 'active', rollupStatus: 'empty' })).toBe('empty');
  });
});

describe('sortInitiatives', () => {
  it('floats blocked to the top regardless of motion', () => {
    const out = sortInitiatives([
      item('active', 'active', '2026-07-26T10:00:00.000Z', 'a'),
      item('active', 'blocked', '2026-07-01T00:00:00.000Z', 'b'),
    ]);
    expect(out.map((i) => i.id)).toEqual(['b', 'a']);
  });

  it('orders the status bands blocked > active > awaiting_verification > paused > archived > completed > empty', () => {
    const out = sortInitiatives([
      item('active', 'empty', null, 'empty'),
      item('completed', 'completed', '2026-07-26T00:00:00.000Z', 'completed'),
      item('paused', 'paused', '2026-07-26T00:00:00.000Z', 'paused'),
      item('active', 'active', '2026-07-26T00:00:00.000Z', 'active'),
      item('active', 'blocked', '2026-07-26T00:00:00.000Z', 'blocked'),
      item('active', 'completed', '2026-07-26T00:00:00.000Z', 'awaiting'),
      item('archived', 'completed', '2026-07-26T00:00:00.000Z', 'archived'),
    ]);
    expect(out.map((i) => i.id)).toEqual(['blocked', 'active', 'awaiting', 'paused', 'archived', 'completed', 'empty']);
  });

  it('within a band, newest motion first and no-motion sinks', () => {
    const out = sortInitiatives([
      item('active', 'active', null, 'none'),
      item('active', 'active', '2026-07-20T00:00:00.000Z', 'older'),
      item('active', 'active', '2026-07-26T00:00:00.000Z', 'newer'),
    ]);
    expect(out.map((i) => i.id)).toEqual(['newer', 'older', 'none']);
  });

  it('does not mutate the input', () => {
    const input = [item('active', 'active', '2026-07-26T00:00:00.000Z', 'a'), item('active', 'blocked', null, 'b')];
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
    expect(initiativeStatusChip('paused').label).toBe('PAUSED');
    expect(initiativeStatusChip('awaiting_verification').label).toBe('AWAITING');
    expect(initiativeStatusChip('archived').label).toBe('ARCHIVED');
    expect(initiativeStatusChip('empty').label).toBe('EMPTY');
    expect(initiativeStatusChip('weird').label).toBe('EMPTY'); // unknown → empty
    for (const s of ['blocked', 'active', 'paused', 'completed', 'empty', 'awaiting_verification', 'archived']) {
      expect(initiativeStatusChip(s).className).not.toMatch(/#[0-9a-f]{3,6}/i); // no raw hex
    }
  });
});

describe('motionLabel', () => {
  it('returns "no activity yet" when there is no motion', () => {
    expect(motionLabel({ status: 'active', progress: { status: 'empty' }, lastMotionAt: null })).toBe('no activity yet');
  });

  it('picks the verb from derived display status so it cannot contradict the chip', () => {
    const at = '2026-01-01T00:00:00.000Z';
    // completed DB status → shipped
    expect(motionLabel({ status: 'completed', progress: { status: 'completed' }, lastMotionAt: at }).startsWith('shipped ')).toBe(true);
    // blocked rollup → blocked
    expect(motionLabel({ status: 'active', progress: { status: 'blocked' }, lastMotionAt: at }).startsWith('blocked ')).toBe(true);
    // paused DB status → paused
    expect(motionLabel({ status: 'paused', progress: { status: 'paused' }, lastMotionAt: at }).startsWith('paused ')).toBe(true);
    // active initiative, missions still running → moved
    expect(motionLabel({ status: 'active', progress: { status: 'active' }, lastMotionAt: at }).startsWith('moved ')).toBe(true);
    // all missions done but initiative still active → moved (not "shipped")
    expect(motionLabel({ status: 'active', progress: { status: 'completed' }, lastMotionAt: at }).startsWith('moved ')).toBe(true);
  });
});
