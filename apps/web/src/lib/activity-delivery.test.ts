import { describe, expect, it } from 'bun:test';
import * as rules from '@buildd/core/mission-helpers';
import { projectMissionDelivery, type MissionTaskRow } from './delivery-projection';
import {
  NOT_LANDED_NOW_WINDOW_MS, WAITING_ROWS_PER_GROUP,
  buildActivityHistory, buildActivityNow, filterEpisodes, filterNow, latestTask, repairReasonOf, reviewOf,
  type ActivityTaskInput,
} from './activity-delivery';

const NOW = Date.parse('2026-10-08T12:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const PR = 'https://github.com/example/project/pull/';

let seq = 0;
function task(over: Partial<ActivityTaskInput> = {}): ActivityTaskInput {
  seq += 1;
  return { id: `t${String(seq).padStart(3, '0')}`, title: `Task ${seq}`, status: 'pending', taskClass: 'work', missionId: null, createdAt: ago(60), updatedAt: ago(60), workers: [], ...over };
}
const running = (over: Partial<ActivityTaskInput> = {}) => task({ status: 'in_progress', workers: [{ status: 'running', name: 'runner-a', startedAt: ago(5), updatedAt: ago(1) }], updatedAt: ago(1), ...over });
const inAudit = (over: Partial<ActivityTaskInput> = {}) => task({ status: 'completed', workers: [{ status: 'completed', prUrl: `${PR}1`, prNumber: 1, prLifecycleStatus: 'ci_running', completedAt: ago(10), updatedAt: ago(10) }], updatedAt: ago(10), ...over });
const merged = (over: Partial<ActivityTaskInput> = {}) => task({ status: 'completed', workers: [{ status: 'completed', prUrl: `${PR}2`, prNumber: 2, mergedAt: ago(30), completedAt: ago(40), startedAt: ago(50) }], updatedAt: ago(30), ...over });

function missionOf(id: string, title: string, rows: ActivityTaskInput[]) {
  const tasks: MissionTaskRow[] = rows.filter(r => r.missionId === id);
  return projectMissionDelivery({ id, title, status: 'active', href: `/app/missions/${id}`, tasks }, rules);
}
function now(rows: ActivityTaskInput[], missions = [] as ReturnType<typeof missionOf>[]) {
  return buildActivityNow({ tasks: rows, missions, rules, now: NOW });
}

describe('Activity Now: grouped by mission, standalone last', () => {
  it('groups live work by mission and puts standalone work in its own group at the end', () => {
    const rows = [running({ missionId: 'mb', missionTitle: 'B' }), running(), inAudit({ missionId: 'ma', missionTitle: 'A' })];
    const n = now(rows, [missionOf('ma', 'A', rows), missionOf('mb', 'B', rows)]);
    expect(n.groups.map(g => g.title)).toEqual(['A', 'B', 'Standalone']);
    expect(n.groups[2].missionId).toBeNull();
    expect(n.groups[2].href).toBeNull();
  });

  it('orders missions by their chip, then id, so equal states never swap between renders', () => {
    const rows = [running({ missionId: 'm2', missionTitle: 'Two' }), running({ missionId: 'm1', missionTitle: 'One' })];
    const ms = [missionOf('m2', 'Two', rows), missionOf('m1', 'One', rows)];
    const a = now(rows, ms).groups.map(g => g.missionId);
    const b = now([...rows].reverse(), [...ms].reverse()).groups.map(g => g.missionId);
    expect(a).toEqual(['m1', 'm2']);
    expect(b).toEqual(a);
  });

  it('a mission group carries the mission projection: chip, landed n/m and next milestone', () => {
    const rows = [merged({ missionId: 'm', missionTitle: 'M' }), inAudit({ missionId: 'm', missionTitle: 'M' })];
    const m = missionOf('m', 'M', rows);
    const g = now(rows, [m]).groups[0];
    expect([g.kind, g.landed, g.total, g.next]).toEqual([m.kind, 1, 2, m.next]);
  });

  it('landed work leaves Now; a not-landed delivery stays 48 h, then lives only in History', () => {
    const fresh = task({ status: 'failed', updatedAt: ago(60) });
    const stale = task({ status: 'failed', updatedAt: new Date(NOW - NOT_LANDED_NOW_WINDOW_MS - 60_000).toISOString() });
    const n = now([merged(), fresh, stale]);
    expect(n.groups.flatMap(g => g.rows.map(r => r.id))).toEqual([fresh.id]);
    expect(buildActivityHistory({ tasks: [merged(), fresh, stale], missions: [], rules }).map(e => e.id)).toContain(stale.id);
  });

  it('cancelled work is not in Now', () => {
    expect(now([task({ status: 'cancelled' })]).groups).toEqual([]);
  });

  it('waiting rows fold into a count past the cap, after the rows in motion', () => {
    const rows = [running({ missionId: 'm', missionTitle: 'M' }), ...Array.from({ length: 5 }, () => task({ missionId: 'm', missionTitle: 'M' }))];
    const g = now(rows, [missionOf('m', 'M', rows)]).groups[0];
    expect(g.rows[0].delivery.kind).toBe('build');
    expect(g.rows.slice(1).every(r => r.delivery.kind === 'waiting')).toBe(true);
    expect(g.rows.length).toBe(1 + WAITING_ROWS_PER_GROUP);
    expect(g.moreWaiting).toBe(5 - WAITING_ROWS_PER_GROUP);
  });

  it('counts deliveries in motion apart from agents working', () => {
    const rows = [running(), inAudit(), inAudit(), task()];
    const n = now(rows);
    expect(n.inMotion).toBe(3);
    expect(n.liveAgents).toBe(1);
  });

  it('a mission task reads the mission projection, not a second derivation', () => {
    const rows = [inAudit({ missionId: 'm', missionTitle: 'M' })];
    const m = missionOf('m', 'M', rows);
    const row = now(rows, [m]).groups[0].rows[0];
    expect(row.delivery).toBe(m.tasks[0].delivery);
  });

  it('open tasks of a completed mission with no non-landed tasks are regrouped as standalone', () => {
    const completed1 = merged({ missionId: 'm1', missionTitle: 'Completed' });
    const completed2 = merged({ missionId: 'm1', missionTitle: 'Completed' });
    // A new open task with no parent, added after mission completion
    const newOpen = task({ missionId: 'm1', missionTitle: 'Completed', status: 'pending', createdAt: ago(5) });
    const rows = [completed1, completed2, newOpen];
    // Create mission with only the landed tasks
    const m1 = projectMissionDelivery({
      id: 'm1', title: 'Completed', status: 'active', href: '/app/missions/m1',
      tasks: [completed1, completed2].map((t): MissionTaskRow => ({ ...t, dependsOn: null })),
    }, rules);
    const n = now(rows, [m1]);
    const groups = n.groups.map(g => ({ title: g.title, rows: g.rows.length }));
    // The new open task is not included in the mission projection, so it appears standalone
    // But when grouped, if the mission is landed, the task should be regrouped
    expect(n.groups.map(g => g.missionId)).toContain(null);
  });

  it('standalone group has no href so waiting tasks are folded but not linkable', () => {
    const standaloneWaiting = [...Array.from({ length: 5 }, () => task())];
    const g = now(standaloneWaiting).groups[0];
    expect(g.missionId).toBeNull();
    expect(g.href).toBeNull();
    expect(g.rows.length).toBe(WAITING_ROWS_PER_GROUP);
    expect(g.moreWaiting).toBe(5 - WAITING_ROWS_PER_GROUP);
  });

  it('retries and reviews fold into their deliverable; an orphaned attempt still shows', () => {
    const parent = inAudit();
    const retry = task({ title: '[builder · after CI #1] x', taskClass: 'attempt', parentTaskId: parent.id, status: 'in_progress', workers: [{ status: 'running' }] });
    const orphan = task({ title: '[reviewer #1] y', taskClass: 'attempt', parentTaskId: 'not-loaded', status: 'in_progress', workers: [{ status: 'running' }] });
    const ids = now([parent, retry, orphan]).groups.flatMap(g => g.rows.map(r => r.id));
    expect(ids).toContain(parent.id);
    expect(ids).not.toContain(retry.id);
    expect(ids).toContain(orphan.id);
    const row = now([parent, retry]).groups[0].rows[0];
    expect(row.delivery.kind).toBe('repair');
    expect(row.delivery.repairRounds).toBe(1);
    expect(row.line).toContain('round 1');
  });
});

describe('repairReasonOf', () => {
  it('reads what a repair attempt was dispatched for from its title', () => {
    expect(repairReasonOf('[builder · after CI #1] feat: x')).toBe('ci');
    expect(repairReasonOf('[builder · after conflict #2] feat: x')).toBe('conflict');
    expect(repairReasonOf('[builder · after review #1] feat: x')).toBe('review');
    expect(repairReasonOf('[CI Retry #1] feat: x')).toBe('ci');
    expect(repairReasonOf('plain retry')).toBeNull();
  });
});

describe('Activity History', () => {
  it('newest episode first, tiebreak id; steps stay chronological', () => {
    const a = merged();
    const b = inAudit();
    const eps = buildActivityHistory({ tasks: [a, b], missions: [], rules });
    expect(eps.map(e => e.id)).toEqual([b.id, a.id]);
    for (const e of eps) expect(e.steps.map(s => s.at)).toEqual([...e.steps.map(s => s.at)].sort((x, y) => x - y));
  });

  it('a task that finished with no PR is finished, not landed via a merge', () => {
    const e = buildActivityHistory({ tasks: [task({ status: 'completed', updatedAt: ago(5), workers: [{ status: 'completed', startedAt: ago(9) }] })], missions: [], rules })[0];
    expect(e.steps.map(s => s.text)).toEqual(['Build started', 'Finished; nothing to merge']);
  });

  it('filters by missions vs standalone tasks, retries, landed and exceptions', () => {
    const inMission = merged({ missionId: 'm', missionTitle: 'M' });
    const standalone = inAudit();
    const retry = task({ title: '[builder · after CI #1] x', taskClass: 'attempt', parentTaskId: standalone.id, status: 'completed', workers: [{ status: 'completed' }] });
    const failed = task({ status: 'failed', updatedAt: ago(3) });
    const eps = buildActivityHistory({ tasks: [inMission, standalone, retry, failed], missions: [], rules });
    const ids = (f: Parameters<typeof filterEpisodes>[1]) => filterEpisodes(eps, f).map(e => e.id).sort();
    expect(ids({ scope: 'missions', outcome: 'any' })).toEqual([inMission.id]);
    expect(ids({ scope: 'tasks', outcome: 'any' })).toEqual([standalone.id, failed.id].sort());
    expect(ids({ scope: 'all', outcome: 'retries' })).toEqual([standalone.id]);
    expect(ids({ scope: 'all', outcome: 'landed' })).toEqual([inMission.id]);
    expect(ids({ scope: 'all', outcome: 'exceptions' })).toEqual([failed.id]);
    expect(ids({ scope: 'all', outcome: 'any', missionId: 'm' })).toEqual([inMission.id]);
  });
});

describe('filterNow', () => {
  it('scope and retries filters drop empty groups', () => {
    const parent = inAudit({ missionId: 'm', missionTitle: 'M' });
    const fix = task({ title: '[builder · after CI #1] x', taskClass: 'attempt', parentTaskId: parent.id, missionId: 'm', status: 'completed', workers: [{ status: 'completed' }] });
    const rows = [parent, fix, running()];
    const n = now(rows, [missionOf('m', 'M', rows)]);
    expect(filterNow(n, { scope: 'tasks', outcome: 'any' }).map(g => g.title)).toEqual(['Standalone']);
    expect(filterNow(n, { scope: 'all', outcome: 'retries' }).map(g => g.title)).toEqual(['M']);
  });
});

describe('latestTask: the two-tap path', () => {
  it('is the root touched most recently, counting its attempts', () => {
    const old = inAudit({ updatedAt: ago(100) });
    const kid = task({ taskClass: 'attempt', parentTaskId: old.id, updatedAt: ago(0), title: '[builder · after CI #1] x' });
    const other = running({ updatedAt: ago(2) });
    expect(latestTask([old, kid, other], rules)?.id).toBe(old.id);
    expect(latestTask([], rules)).toBeNull();
  });
});

describe('reviewOf: a reviewer run read like derivePrReviewStatus reads it', () => {
  it('the server effective verdict wins over the model output; the head comes from context', () => {
    expect(reviewOf({ effectiveVerdict: 'escalate', structuredOutput: { verdict: 'approve' } }, { headSha: 'abc1234' })).toEqual({ verdict: 'escalate', headSha: 'abc1234' });
    expect(reviewOf({ structuredOutput: { verdict: 'request-changes' } }, {})).toEqual({ verdict: 'request-changes', headSha: null });
  });
  it('anything else is no verdict', () => {
    expect(reviewOf({ structuredOutput: { verdict: 'lgtm' } }, null)).toEqual({ verdict: null, headSha: null });
    expect(reviewOf(null, { headSha: '' })).toEqual({ verdict: null, headSha: null });
  });
});
