import { describe, it, expect } from 'bun:test';
import { deliverableRole, isBuildDeliverable, computeMissionProgress } from '../mission-helpers';

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
