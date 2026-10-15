// Spec f7f67f1a r8 R-32 / R-33, AC-15 / AC-16: once the mission PR merged, the
// list card and Next name what is left, never "The mission PR merges to trunk";
// a waiting check names the claim gate's real hold.
import { describe, expect, it } from 'bun:test';
import { projectMissionDelivery as project, type MissionDeliveryInput, type MissionTaskRow } from './delivery-projection';
import * as missionHelpers from '@buildd/core/mission-helpers';

const projectMissionDelivery = (m: MissionDeliveryInput) => project(m, missionHelpers);
const PR = 'https://github.com/example/project/pull/1';
let seq = 0;
const task = (over: Partial<MissionTaskRow> = {}): MissionTaskRow => ({
  id: over.id ?? `t${++seq}`,
  title: over.title ?? `Task ${seq}`,
  status: 'pending',
  kind: 'engineering',
  mode: 'execution',
  workers: [],
  ...over,
});
const merged = (title: string): MissionTaskRow =>
  task({ title, status: 'completed', workers: [{ status: 'completed', prUrl: PR, mergedAt: '2026-10-01T00:00:00Z', prLifecycleStatus: 'merged' }] });
const shipTask = (mergedAt: string | null): MissionTaskRow =>
  task({
    title: 'Ship mission: Visual review',
    taskClass: 'bookkeeping',
    status: mergedAt ? 'completed' : 'pending',
    workers: [{ status: 'completed', prUrl: PR, mergedAt, prLifecycleStatus: mergedAt ? 'merged' : 'ci_green' }],
  });
const audit = (over: Partial<MissionTaskRow> = {}) => task({ id: 'audit1', title: '[surface audit] Visual review', status: 'pending', ...over });
const mission = (over: Partial<MissionDeliveryInput>): MissionDeliveryInput => ({
  id: 'm1', title: 'Mission', status: 'active', href: '/app/missions/m1', integrationBranch: true, tasks: [], ...over,
});

describe('R-32: a merged mission PR is on trunk', () => {
  it('unmerged mission PR still reads landing', () => {
    const m = projectMissionDelivery(mission({ tasks: [merged('One'), shipTask(null)] }));
    expect(m.kind).toBe('landing');
    expect(m.next).toBe('The mission PR merges to trunk');
  });

  it('merged mission PR with a queued audit: landed, Next names the visual review', () => {
    const m = projectMissionDelivery(mission({ missionPrMerged: true, tasks: [merged('One'), shipTask('2026-10-12T00:00:00Z'), audit()] }));
    expect(m.kind).toBe('landed');
    expect(m.milestones.onTrunk).toBe(true);
    expect(m.next).toBe('Visual review queued');
    expect(m.next).not.toContain('merges to trunk');
  });

  it('a running audit reads running', () => {
    const m = projectMissionDelivery(mission({
      missionPrMerged: true,
      tasks: [merged('One'), shipTask('2026-10-12T00:00:00Z'), audit({ status: 'in_progress', workers: [{ status: 'running' }] })],
    }));
    expect(m.next).toBe('Visual review running');
  });

  it('merged and released with nothing open: the mission completes', () => {
    const m = projectMissionDelivery(mission({ missionPrMerged: true, released: true, tasks: [merged('One'), shipTask('2026-10-12T00:00:00Z')] }));
    expect(m.kind).toBe('landed');
    expect(m.next).toBe('Mission completes');
  });

  it('merged but not released: Next is the release', () => {
    const m = projectMissionDelivery(mission({ missionPrMerged: true, released: false, tasks: [merged('One'), shipTask('2026-10-12T00:00:00Z')] }));
    expect(m.next).toBe('Release');
  });

  it('a merged PR on a direct (no mission branch) mission changes nothing', () => {
    const m = projectMissionDelivery(mission({ integrationBranch: false, missionPrMerged: true, tasks: [merged('One'), task({ title: 'Two' })] }));
    expect(m.kind).not.toBe('landed');
  });
});

describe('R-33: a queued audit names the claim gate hold', () => {
  it('budget paused is said on the card', () => {
    const m = projectMissionDelivery(mission({
      missionPrMerged: true,
      tasks: [merged('One'), shipTask('2026-10-12T00:00:00Z'), audit()],
      holdReasons: new Map([['audit1', 'budget_paused']]),
    }));
    expect(m.next).toBe('Visual review queued: runners paused new work until the model budget resets');
    expect(m.exception?.text).toBe('Visual review queued: runners paused new work until the model budget resets');
    expect(m.exception?.tone).toBe('muted');
  });

  it('an unknown reason says nothing more than queued', () => {
    const m = projectMissionDelivery(mission({
      missionPrMerged: true,
      tasks: [merged('One'), shipTask('2026-10-12T00:00:00Z'), audit()],
      holdReasons: new Map([['audit1', 'something_new']]),
    }));
    expect(m.exception).toBeNull();
  });

  it('a failed audit still outranks the queued state', () => {
    const m = projectMissionDelivery(mission({
      missionPrMerged: true,
      tasks: [merged('One'), shipTask('2026-10-12T00:00:00Z'), audit({ status: 'failed' })],
    }));
    expect(m.visual?.text).toBe('Visual audit could not run');
  });
});
