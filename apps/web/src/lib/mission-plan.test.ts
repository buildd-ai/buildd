import { describe, expect, it } from 'bun:test';
import {
  planMissions, projectReleaseCuts, releaseFit, planLede, planAxis, planRowLabel, cutVersion,
  type PlanMissionInput, type PlanTask, type ReleasePlan,
} from './mission-plan';
import { FLOW_AUDIT_WAIT_MS } from './flow-timeline';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
// Wednesday 2026-10-07 12:00 UTC.
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);

const task = (id: string, p: Partial<PlanTask> = {}): PlanTask => ({
  id, status: 'pending', dependsOn: [], startedAt: null, endedAt: null, p50Minutes: 60, p80Minutes: 120, ...p,
});
const mission = (id: string, tasks: PlanTask[], p: Partial<PlanMissionInput> = {}): PlanMissionInput => ({
  id, title: `Mission ${id}`, href: `/app/missions/${id}`, workspaceId: 'w1', blocked: null, dependsOnMissionId: null, tasks, ...p,
});

describe('planMissions: a mission\'s own estimate', () => {
  it('finishes at the end of the critical path through its tasks', () => {
    const [row] = planMissions([mission('a', [task('t1'), task('t2', { dependsOn: ['t1'] })])], NOW);
    // 60m, audit wait, 60m.
    expect(row.p50).toBe(NOW + 120 * MIN + FLOW_AUDIT_WAIT_MS);
    expect(row.p80).toBe(NOW + 240 * MIN + FLOW_AUDIT_WAIT_MS);
    expect(row.noEstimate).toBeNull();
  });

  it('parallel tasks finish with the longer one', () => {
    const [row] = planMissions([mission('a', [task('t1', { p50Minutes: 30 }), task('t2', { p50Minutes: 90 })])], NOW);
    expect(row.p50).toBe(NOW + 90 * MIN);
  });

  it('a running task only has its remaining time left, never under a quarter of it', () => {
    const run = (startedAgo: number) => planMissions([mission('a', [task('t1', { status: 'in_progress', startedAt: NOW - startedAgo * MIN })])], NOW)[0];
    expect(run(40).p50).toBe(NOW + 20 * MIN);
    expect(run(300).p50).toBe(NOW + 15 * MIN);
    expect(run(40).soFarEnd).toBe(NOW);
    expect(run(40).start).toBe(NOW - 40 * MIN);
  });

  it('landed tasks add nothing; a mission with every task landed has no finish to give', () => {
    const rows = planMissions([
      mission('a', [task('t1', { status: 'completed', endedAt: NOW - DAY }), task('t2', { dependsOn: ['t1'], p50Minutes: 30 })]),
      mission('b', [task('t1', { status: 'completed', endedAt: NOW - DAY })]),
    ], NOW);
    expect(rows.map(r => r.id)).toEqual(['a', 'b']);
    expect(rows[0].p50).toBe(NOW + 30 * MIN);
    expect(rows[1]).toMatchObject({ p50: null, noEstimate: 'landed' });
  });

  it('no estimate on any unfinished task means no finish, not a default', () => {
    const [row] = planMissions([mission('a', [task('t1', { p50Minutes: null, p80Minutes: null })])], NOW);
    expect(row.p50).toBeNull();
    expect(row.p80).toBeNull();
    expect(row.noEstimate).toBe('no_estimate');
  });
});

describe('planMissions: person-blocked missions', () => {
  it('a mission waiting on you gets no finish estimate', () => {
    const [row] = planMissions([mission('a', [task('t1')], { blocked: 'you' })], NOW);
    expect(row.p50).toBeNull();
    expect(row.p80).toBeNull();
    expect(row.noEstimate).toBe('waiting_on_you');
    expect(planRowLabel(row, NOW)).toBe('waiting on you');
  });

  it('a held mission gets none either', () => {
    const [row] = planMissions([mission('a', [task('t1')], { blocked: 'held' })], NOW);
    expect(row.p50).toBeNull();
    expect(row.noEstimate).toBe('held');
    expect(planRowLabel(row, NOW)).toBe('held');
  });
});

describe('planMissions: waiting on another mission', () => {
  it('starts after its dependency\'s p50 and finishes its own length later', () => {
    const rows = planMissions([
      mission('up', [task('t1', { p50Minutes: 120, p80Minutes: 240 })]),
      mission('down', [task('t1', { p50Minutes: 60, p80Minutes: 90 })], { dependsOnMissionId: 'up' }),
    ], NOW);
    const up = rows.find(r => r.id === 'up')!;
    const down = rows.find(r => r.id === 'down')!;
    expect(down.start).toBe(up.p50! + FLOW_AUDIT_WAIT_MS);
    expect(down.p50).toBe(down.start + 60 * MIN);
    expect(down.p80).toBe(up.p80! + FLOW_AUDIT_WAIT_MS + 90 * MIN);
    expect(down.afterId).toBe('up');
    expect(planRowLabel(down, NOW)).toBe('after Mission up');
  });

  it('inherits "no estimate" when the dependency has none', () => {
    const rows = planMissions([
      mission('up', [task('t1')], { blocked: 'you' }),
      mission('down', [task('t1')], { dependsOnMissionId: 'up' }),
    ], NOW);
    const down = rows.find(r => r.id === 'down')!;
    expect(down.p50).toBeNull();
    expect(down.noEstimate).toBe('after_unknown');
  });

  it('a dependency that is no longer open does not delay anything', () => {
    const [row] = planMissions([mission('down', [task('t1')], { dependsOnMissionId: 'gone' })], NOW);
    expect(row.afterId).toBeNull();
    expect(row.p50).toBe(NOW + 60 * MIN);
  });

  it('a dependency cycle does not hang', () => {
    const rows = planMissions([
      mission('a', [task('t1')], { dependsOnMissionId: 'b' }),
      mission('b', [task('t1')], { dependsOnMissionId: 'a' }),
    ], NOW);
    expect(rows).toHaveLength(2);
  });
});

describe('planMissions: ordering', () => {
  it('orders by estimated finish, no-estimate rows last', () => {
    const rows = planMissions([
      mission('blocked', [task('t1')], { blocked: 'you' }),
      mission('slow', [task('t1', { p50Minutes: 300 })]),
      mission('fast', [task('t1', { p50Minutes: 30 })]),
    ], NOW);
    expect(rows.map(r => r.id)).toEqual(['fast', 'slow', 'blocked']);
  });
});

describe('projectReleaseCuts', () => {
  // Fridays at 15:00 UTC: Oct 2, Sep 25, Sep 18, Sep 11.
  const fri = (d: number) => Date.UTC(2026, 8, d, 15, 0, 0);
  const weekly = [fri(11), fri(18), fri(25), Date.UTC(2026, 9, 2, 15)];

  it('projects the weekday the workspace releases on', () => {
    const plan = projectReleaseCuts({ config: { enabled: true }, releaseTimes: weekly, latestVersion: 'v0.301.0', now: NOW });
    expect(plan.mode).toBe('cuts');
    if (plan.mode !== 'cuts') return;
    expect(plan.cuts[0]).toBe(Date.UTC(2026, 9, 9, 15));
    expect(new Date(plan.cuts[1]).getUTCDay()).toBe(5);
    expect(plan.cuts[1] - plan.cuts[0]).toBe(7 * DAY);
    expect(plan.latestVersion).toBe('v0.301.0');
  });

  it('says so, and predicts no cuts, when the workspace releases on mission completion', () => {
    const plan = projectReleaseCuts({ config: { enabled: true, trigger: 'on_mission_complete' }, releaseTimes: weekly, now: NOW });
    expect(plan.mode).toBe('on_completion');
  });

  it('no release config, or too little history, predicts nothing', () => {
    expect(projectReleaseCuts({ config: null, releaseTimes: weekly, now: NOW }).mode).toBe('none');
    expect(projectReleaseCuts({ config: { enabled: false }, releaseTimes: weekly, now: NOW }).mode).toBe('none');
    expect(projectReleaseCuts({ config: { enabled: true }, releaseTimes: weekly.slice(0, 2), now: NOW }).mode).toBe('none');
  });

  it('falls back to the median interval when releases do not share a weekday', () => {
    const times = [0, 2, 4, 6].map(d => Date.UTC(2026, 9, 1 + d, 9));
    const plan = projectReleaseCuts({ config: { enabled: true }, releaseTimes: times, now: NOW });
    expect(plan.mode).toBe('cuts');
    if (plan.mode !== 'cuts') return;
    expect(plan.cuts[0]).toBe(Date.UTC(2026, 9, 9, 9));
    expect(plan.cuts[1] - plan.cuts[0]).toBe(2 * DAY);
  });
});

describe('releaseFit', () => {
  const FRI = Date.UTC(2026, 9, 9, 15);
  const NEXT_FRI = FRI + 7 * DAY;
  const plan: ReleasePlan = { mode: 'cuts', cuts: [FRI, NEXT_FRI], latestVersion: 'v0.301.0' };

  it('names the first cut after the p50', () => {
    const fit = releaseFit(NOW + 1 * DAY, NOW + 2 * DAY, plan)!;
    expect(fit).toMatchObject({ kind: 'cut', cutAt: FRI, index: 0, atRisk: false, version: 'v0.302' });
  });

  it('is at risk when the p80 falls after that cut, and names the cut it would probably make', () => {
    const fit = releaseFit(NOW + 1 * DAY, FRI + 2 * DAY, plan)!;
    expect(fit).toMatchObject({ kind: 'cut', cutAt: FRI, atRisk: true, laterCutAt: NEXT_FRI });
  });

  it('a p50 past a cut moves to the next one', () => {
    const fit = releaseFit(FRI + 60 * MIN, FRI + 2 * DAY, plan)!;
    expect(fit).toMatchObject({ cutAt: NEXT_FRI, index: 1, atRisk: false, version: 'v0.303' });
  });

  it('on completion says that instead of a cut', () => {
    expect(releaseFit(NOW, NOW + DAY, { mode: 'on_completion' })).toEqual({ kind: 'on_completion' });
  });

  it('no plan or no estimate gives no fit', () => {
    expect(releaseFit(NOW, NOW, { mode: 'none' })).toBeNull();
    expect(releaseFit(null, null, plan)).toBeNull();
  });

  it('cutVersion bumps the minor and survives odd input', () => {
    expect(cutVersion('v0.312.1', 0)).toBe('v0.313');
    expect(cutVersion('banana', 0)).toBeNull();
    expect(cutVersion(null, 0)).toBeNull();
  });
});

describe('planLede', () => {
  const FRI = Date.UTC(2026, 9, 9, 15);
  const plans = new Map<string, ReleasePlan>([['w1', { mode: 'cuts', cuts: [FRI, FRI + 7 * DAY], latestVersion: 'v0.301.0' }]]);

  it('counts the missions that should make the next release', () => {
    const rows = planMissions([
      mission('a', [task('t1', { p50Minutes: 60 })]),
      mission('b', [task('t1', { p50Minutes: 120 })]),
    ], NOW, plans);
    expect(planLede(rows, plans, NOW)).toMatchObject({ headline: '2 missions should make Friday\'s release.' });
  });

  it('names an at-risk mission and the release it will probably land in', () => {
    const rows = planMissions([
      mission('a', [task('t1', { p50Minutes: 60 })]),
      mission('b', [task('t1', { p50Minutes: 2 * 24 * 60, p80Minutes: 4 * 24 * 60 })]),
    ], NOW, plans);
    const lede = planLede(rows, plans, NOW);
    expect(lede.headline).toBe('1 mission should make Friday\'s release.');
    expect(lede.detail).toBe('Mission b should finish before Friday\'s cut but may run past it, and would probably land in the Friday after.');
  });

  it('mentions missions waiting on you when nothing is at risk', () => {
    const rows = planMissions([
      mission('a', [task('t1')]),
      mission('b', [task('t1')], { blocked: 'you' }),
    ], NOW, plans);
    expect(planLede(rows, plans, NOW).detail).toBe('1 mission is waiting on you and has no estimate.');
  });

  it('under release-on-completion it says each mission ships when it finishes', () => {
    const p = new Map<string, ReleasePlan>([['w1', { mode: 'on_completion' }]]);
    const rows = planMissions([mission('a', [task('t1')])], NOW, p);
    expect(planLede(rows, p, NOW).headline).toBe('This workspace releases when a mission completes, so each one ships as it finishes.');
  });

  it('says so when nothing is open', () => {
    expect(planLede([], plans, NOW).headline).toBe('No open missions.');
  });

  it('never says late', () => {
    const rows = planMissions([mission('b', [task('t1', { p50Minutes: 2 * 24 * 60, p80Minutes: 4 * 24 * 60 })])], NOW, plans);
    const l = planLede(rows, plans, NOW);
    expect(`${l.headline} ${l.detail}`).not.toMatch(/\blate\b/i);
  });
});

describe('planAxis', () => {
  it('shades weekends and places times as fractions of the window', () => {
    const rows = planMissions([mission('a', [task('t1', { p50Minutes: 3 * 24 * 60, p80Minutes: 4 * 24 * 60 })])], NOW);
    const axis = planAxis(rows, [], NOW);
    expect(axis.days[0].label).toBe('Wed');
    const weekend = axis.days.filter(d => d.weekend);
    expect(weekend.length).toBeGreaterThan(0);
    expect(weekend.every(d => ['Sat', 'Sun'].includes(d.label))).toBe(true);
    expect(axis.at(NOW)).toBeGreaterThanOrEqual(0);
    expect(axis.at(axis.to)).toBeCloseTo(1, 5);
    expect(axis.at(axis.from)).toBe(0);
  });
});
