import { describe, it, expect } from 'bun:test';
import { deliverableRole, isBuildDeliverable, computeMissionProgress, DELIVERABLE_ROLE_CONTEXT_KEYS } from '../mission-helpers';

// Illustrative fixtures only. Spec f7f67f1a P-2 / R-14: verification, repair and
// maintenance work is listed but never enters the build count.
describe('deliverableRole', () => {
  it('a plain work task is build', () => {
    expect(deliverableRole({ title: 'feat(x): add a report' })).toBe('build');
  });

  it('the auto-appended surface audit is verification, by title or by the auditor role', () => {
    expect(deliverableRole({ title: '[surface audit] Ship the report' })).toBe('verification');
    expect(deliverableRole({ title: '[surface audit] round 2: Ship the report' })).toBe('verification');
    expect(deliverableRole({ title: 'Audit the report page', roleSlug: 'visual-auditor' })).toBe('verification');
  });

  it('a surface fix is repair, by title or by its context', () => {
    expect(deliverableRole({ title: '[surface fix] /app/reports: chart overflows' })).toBe('repair');
    expect(deliverableRole({ title: '[Surface Fix] /app/reports: chart overflows' })).toBe('repair');
    expect(deliverableRole({ title: 'Fix the chart', context: { surfaceFix: { origin: 'human', route: '/app/reports' } } })).toBe('repair');
  });

  it('a trunk refresh is maintenance, by its context or the generated title', () => {
    expect(deliverableRole({ title: 'chore(mission): merge dev into the Report integration branch', context: { requireMergeCommit: true } })).toBe('maintenance');
    expect(deliverableRole({ title: 'anything', context: { refreshTrunk: 'dev' } })).toBe('maintenance');
    expect(deliverableRole({ title: 'chore(mission): merge dev into the Report integration branch' })).toBe('maintenance');
  });

  it('isBuildDeliverable is a deliverable whose role is build', () => {
    expect(isBuildDeliverable({ taskClass: 'work', title: 'feat: a' })).toBe(true);
    expect(isBuildDeliverable({ taskClass: 'work', title: '[surface audit] M' })).toBe(false);
    expect(isBuildDeliverable({ taskClass: 'attempt', title: 'feat: a' })).toBe(false);
    expect(isBuildDeliverable({ taskClass: 'bookkeeping', title: 'feat: a' })).toBe(false);
  });
});

describe('computeMissionProgress counts build work only (R-14)', () => {
  it('audit, fix and refresh tasks are not in the denominator or the segments', () => {
    const tasks = [
      { id: 'b1', status: 'completed', taskClass: 'work', title: 'feat: one' },
      { id: 'b2', status: 'pending', taskClass: 'work', title: 'feat: two' },
      { id: 'a1', status: 'pending', taskClass: 'work', title: '[surface audit] Mission' },
      { id: 'f1', status: 'completed', taskClass: 'work', title: '[surface fix] /app: fix it' },
      { id: 'r1', status: 'completed', taskClass: 'work', title: 'chore(mission): merge dev into the Mission integration branch', context: { requireMergeCommit: true } },
    ];
    const p = computeMissionProgress(tasks);
    expect(p.totalTasks).toBe(2);
    expect(p.completedTasks).toBe(1);
    expect(p.segments.map(s => s.taskId)).toEqual(['b1', 'b2']);
  });
});

// A list (`buildd top`'s mission stages) cannot afford whole `tasks.context`
// blobs, so it projects only the keys `deliverableRole` reads
// (DELIVERABLE_ROLE_CONTEXT_KEYS). A new key read here must join that list, or
// the list silently stops seeing it.
describe('DELIVERABLE_ROLE_CONTEXT_KEYS', () => {
  function keysRead(context: Record<string, unknown>): Set<string> {
    const read = new Set<string>();
    const proxy = new Proxy(context, { get(target, key, recv) { if (typeof key === 'string') read.add(key); return Reflect.get(target, key, recv); } });
    deliverableRole({ title: 'feat(x): plain work', roleSlug: 'builder', context: proxy });
    return read;
  }

  it('names every context key deliverableRole reads', () => {
    const allowed = new Set<string>([...DELIVERABLE_ROLE_CONTEXT_KEYS.objectMarkers, ...DELIVERABLE_ROLE_CONTEXT_KEYS.values]);
    // A context with none of the markers walks every branch.
    for (const k of keysRead({})) expect(allowed.has(k)).toBe(true);
    expect([...keysRead({})].sort()).toEqual([...allowed].sort());
  });

  it('an object marker reduced to {} reads the same role as the full object', () => {
    for (const k of DELIVERABLE_ROLE_CONTEXT_KEYS.objectMarkers) {
      const full = deliverableRole({ title: 'feat(x): work', context: { [k]: { a: 1, nested: { b: 'x'.repeat(100) } }, other: 'big' } });
      expect(deliverableRole({ title: 'feat(x): work', context: { [k]: {} } })).toBe(full);
    }
  });
});

describe('acceptance tests (spec 1dc6cc39 R-76)', () => {
  it('the acceptance-tests task is verification, not build', () => {
    expect(deliverableRole({ title: '[acceptance tests] X', context: { acceptanceTests: { missionId: 'm', specId: 's' } } })).toBe('verification');
  });
});

describe('verifyHostOf / isHelperRun (spec d25d923d R-11, R-12)', () => {
  const { verifyHostOf, isHelperRun } = require('../mission-helpers');
  it('a criterion check hosts under its subject task', () => {
    const t = { taskClass: 'bookkeeping', title: 'Check spec criterion R-1', context: { specCriterionCheck: { subjectTaskId: 'T1' } } };
    expect(verifyHostOf(t)).toEqual({ kind: 'task', taskId: 'T1' });
    expect(isHelperRun(t)).toBe(true);
    expect(deliverableRole(t)).toBe('verification');
  });
  it('final verification and the surface audit host under their mission', () => {
    const fv = { taskClass: 'bookkeeping', context: { finalVerification: { missionId: 'M1' } } };
    expect(verifyHostOf(fv)).toEqual({ kind: 'mission', missionId: 'M1' });
    expect(isHelperRun(fv)).toBe(true);
    const audit = { taskClass: 'work', title: '[surface audit] M' };
    expect(verifyHostOf(audit)).toEqual({ kind: 'mission', missionId: null });
    expect(isHelperRun(audit)).toBe(true);
  });
  it('an attempt hosts under its parent; a spec repair under its filer', () => {
    expect(verifyHostOf({ taskClass: 'attempt', parentTaskId: 'P' })).toEqual({ kind: 'task', taskId: 'P' });
    expect(verifyHostOf({ taskClass: 'work', context: { specRepair: { filedBy: 'F' } } })).toEqual({ kind: 'task', taskId: 'F' });
  });
  it('build work is not a helper', () => {
    const t = { taskClass: 'work', title: 'feat: x' };
    expect(verifyHostOf(t)).toBeNull();
    expect(isHelperRun(t)).toBe(false);
  });
});
