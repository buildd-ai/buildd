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

describe('visual review round 1: what is left reads the waiver, criteria and a local strand', () => {
  const on = (over: Partial<MissionDeliveryInput>) => projectMissionDelivery(mission({ missionPrMerged: true, ...over }));
  it('a waived visual review is not what is left', () => {
    const m = on({ visualReview: { status: 'waived', blockedDetail: null, holdReason: null }, released: true, tasks: [merged('One'), shipTask('2026-10-12T00:00:00Z'), audit()], holdReasons: new Map([['audit1', 'budget_paused']]) });
    expect(m.next).toBe('Mission completes');
    expect(m.exception).toBeNull();
    expect(m.remaining).toBe('completion');
  });
  it('unpassed goal criteria come before completion', () => {
    const m = on({ criteriaPending: 1, tasks: [merged('One'), shipTask('2026-10-12T00:00:00Z')] });
    expect(m.next).toBe('A goal criterion passes');
    expect(m.remaining).toBe('criteria');
    expect(on({ criteriaPending: 3, tasks: [merged('One')] }).next).toBe('3 goal criteria pass');
  });
  it('an open visual review leads, then criteria', () => {
    expect(on({ criteriaPending: 1, tasks: [merged('One'), audit()] }).remaining).toBe('visual');
  });
  it('a direct mission with every task landed also waits on its criteria', () => {
    const m = projectMissionDelivery(mission({ integrationBranch: false, criteriaPending: 1, tasks: [merged('One')] }));
    expect(m.kind).toBe('landed');
    expect(m.next).toBe('A goal criterion passes');
  });
  it('a stranded local mission says so instead of "a slot frees up"', () => {
    const m = projectMissionDelivery(mission({ integrationBranch: false, localStrand: { stranded: true, quietMs: 33 * 3_600_000 }, tasks: [merged('One'), task({ title: 'Two' })] }));
    expect(m.kind).toBe('waiting');
    expect(m.next).toBe('Waiting for a local session (none for 33h)');
    expect(m.next).not.toContain('slot');
  });
  it('a local mission that is not stranded starts from a local session', () => {
    const m = projectMissionDelivery(mission({ integrationBranch: false, localStrand: { stranded: false, quietMs: 0 }, tasks: [merged('One'), task({ title: 'Two' })] }));
    expect(m.next).toBe('Waiting for a local session');
  });
});


describe('visual review round 2: the card names the review state\'s one cause', () => {
  const on = (over: Partial<MissionDeliveryInput>) => projectMissionDelivery(mission({ missionPrMerged: true, ...over }));
  const tasks = [merged('One'), shipTask('2026-10-12T00:00:00Z'), audit()];
  it('blocked on a browser: the card says what the page says, not the budget record', () => {
    const m = on({ tasks, holdReasons: new Map([['audit1', 'budget_paused']]), visualReview: { status: 'blocked', blockedDetail: 'it needs a runner with a browser', holdReason: null } });
    expect(m.next).toBe('Visual review unable to run: it needs a runner with a browser');
    expect(m.next).not.toContain('budget');
  });
  it('queued: the hold comes from the review state', () => {
    const m = on({ tasks, visualReview: { status: 'queued', blockedDetail: null, holdReason: 'budget_paused' } });
    expect(m.next).toBe('Visual review queued: runners paused new work until the model budget resets');
  });
  it('a task with no hold is next in line for a runner, never "a slot frees up"', () => {
    const m = projectMissionDelivery(mission({ integrationBranch: false, tasks: [merged('One'), task({ title: 'Two' })] }));
    expect(m.next).toBe('Next in line for a runner');
  });
});
