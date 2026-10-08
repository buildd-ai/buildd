import { describe, it, expect } from 'bun:test';
import {
  evaluateSoftOverlaps,
  readSoftOverlaps,
  softOverlapHolderIds,
  type SoftHolderRow,
} from './soft-overlap-gate';
import { describeExplicitDeferral } from './explicit-deferral';

/**
 * Claim-time soft overlap (prefix-only declared overlap, and pre-v2 inferred
 * edges reclassified against the current manifests). Pure: no DB.
 */

const holder = (over: Partial<SoftHolderRow> = {}): SoftHolderRow => ({
  id: 'h1', status: 'in_progress', pathManifest: ['scripts/run-unit-tests.ts'], workerStatus: 'running', title: 'Other', ...over,
});
const task = (softOverlaps: unknown, pathManifest: string[] = ['scripts/']) => ({
  id: 'cand', pathManifest, pathDeclaration: { declared: pathManifest, source: 'creation', snapshotAt: 'x', overlapPolicy: 'v2', softOverlaps },
});
const none = () => false;

describe('readSoftOverlaps', () => {
  it('reads well-formed entries and drops malformed ones', () => {
    expect(readSoftOverlaps(task([
      { taskId: 'h1', paths: ['scripts'], kind: 'prefix' },
      { taskId: 42 },
      'junk',
      { taskId: 'h2', kind: 'legacy_inferred' },
    ]).pathDeclaration)).toEqual([
      { taskId: 'h1', paths: ['scripts'], kind: 'prefix' },
      { taskId: 'h2', paths: [], kind: 'legacy_inferred' },
    ]);
    expect(readSoftOverlaps(null)).toEqual([]);
    expect(readSoftOverlaps({ softOverlaps: 'x' })).toEqual([]);
  });

  it('softOverlapHolderIds collects every holder across candidates, minus self', () => {
    const ids = softOverlapHolderIds([task([{ taskId: 'h1' }, { taskId: 'cand' }]), task([{ taskId: 'h2' }])]);
    expect([...ids].sort()).toEqual(['h1', 'h2']);
  });
});

describe('evaluateSoftOverlaps', () => {
  it('a prefix-only overlap with an in-flight holder is advisory (Jev decides)', () => {
    const v = evaluateSoftOverlaps(task([{ taskId: 'h1', paths: [], kind: 'prefix' }]), new Map([['h1', holder()]]), { isSerialized: none });
    expect(v).toEqual([{ kind: 'advisory', holderTaskId: 'h1', paths: ['scripts', 'scripts/run-unit-tests.ts'], workerStatus: 'running', holderTitle: 'Other' }]);
  });

  it('a terminal holder, a missing holder, or an overlap that no longer exists releases', () => {
    expect(evaluateSoftOverlaps(task([{ taskId: 'h1' }]), new Map([['h1', holder({ status: 'completed' })]]), { isSerialized: none })).toEqual([]);
    expect(evaluateSoftOverlaps(task([{ taskId: 'h1' }]), new Map(), { isSerialized: none })).toEqual([]);
    expect(evaluateSoftOverlaps(task([{ taskId: 'h1' }]), new Map([['h1', holder({ pathManifest: ['docs/x.md'] })]]), { isSerialized: none })).toEqual([]);
  });

  it('a legacy inferred edge that is really the same file still holds deterministically', () => {
    const v = evaluateSoftOverlaps(
      task([{ taskId: 'h1', paths: [], kind: 'legacy_inferred' }], ['scripts/run-unit-tests.ts']),
      new Map([['h1', holder({ status: 'pending', workerStatus: null })]]),
      { isSerialized: none },
    );
    expect(v).toEqual([{ kind: 'deterministic', holderTaskId: 'h1', paths: ['scripts/run-unit-tests.ts'], overlapKind: 'exact_file', holderTitle: 'Other' }]);
  });

  it('migration paths and serialized surfaces stay deterministic', () => {
    const mig = evaluateSoftOverlaps(task([{ taskId: 'h1' }], ['packages/core/']), new Map([['h1', holder({ pathManifest: ['packages/core/drizzle/0001.sql'] })]]), { isSerialized: none });
    expect(mig[0]).toMatchObject({ kind: 'deterministic', overlapKind: 'migration' });
    const ser = evaluateSoftOverlaps(task([{ taskId: 'h1' }]), new Map([['h1', holder()]]), { isSerialized: () => true });
    expect(ser[0]).toMatchObject({ kind: 'deterministic', overlapKind: 'serialized' });
  });

  it('an unreadable holder set fails closed: every soft entry holds as unknown state', () => {
    const v = evaluateSoftOverlaps(task([{ taskId: 'h1' }]), null, { isSerialized: none });
    expect(v).toEqual([{ kind: 'deterministic', holderTaskId: 'h1', paths: [], overlapKind: 'state_unresolved', holderTitle: null }]);
  });

  it('a throwing serialized-surface check fails closed to deterministic', () => {
    const v = evaluateSoftOverlaps(task([{ taskId: 'h1' }]), new Map([['h1', holder()]]), { isSerialized: () => { throw new Error('bad config'); } });
    expect(v[0]).toMatchObject({ kind: 'deterministic', overlapKind: 'serialized' });
  });

  it('a task never soft-holds behind itself', () => {
    expect(evaluateSoftOverlaps(task([{ taskId: 'cand' }]), new Map([['cand', holder({ id: 'cand' })]]), { isSerialized: none })).toEqual([]);
  });
});

describe('describeExplicitDeferral: soft_overlap names who holds what and why', () => {
  it('names the holder, the paths and the verdict', () => {
    const d = describeExplicitDeferral('soft_overlap', { holderTaskId: 'h1', paths: ['scripts'], verdict: 'HOLD' });
    expect(d.code).toBe('soft_overlap');
    expect(d.detail).toContain('h1');
    expect(d.detail).toContain('scripts');
    expect(d.detail).toContain('HOLD');
  });
});
