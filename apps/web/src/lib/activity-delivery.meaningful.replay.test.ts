/**
 * Replay (spec 9430a28f AC-3): claim → PR → CI failure → automatic repair →
 * new head → review → spec verification → merge → reopen, folded event by
 * event into the rows Activity, Home and Missions load. After every event:
 * the three surfaces read the same chip and landed n/m; Activity's History
 * and Mission History's Highlights tell the same steps for the delivery,
 * growing only at the end; and the verification shown is the recorded one,
 * never the merge.
 */
import { describe, expect, it } from 'bun:test';
import * as rules from '@buildd/core/mission-helpers';
import { projectMissionDelivery, selectHomeMilestones, type DeliveryKind, type MissionTaskRow } from './delivery-projection';
import { buildActivityEpisodes, buildActivityHistory, buildActivityNow, type ActivityTaskInput, type ActivityWorker } from './activity-delivery';
import { buildMissionHistory } from './mission-history-episodes';
import { boardFixture } from './mission-board.fixtures';
import { verificationClaim } from './activity-verification';

const PR = 'https://github.com/example/project/pull/34';
const H1 = 'a1b2c3d4e5f6';
const H2 = 'd4e5f60718293';
const T = (hhmm: string) => `2026-10-08T${hhmm}:00.000Z`;
const s7 = (sha: string) => sha.slice(0, 7);

interface World { rows: ActivityTaskInput[] }
const patch = (w: World, id: string, f: (r: ActivityTaskInput) => ActivityTaskInput): World => ({ rows: w.rows.map(r => (r.id === id ? f(r) : r)) });
const patchOwner = (w: World, f: (o: ActivityWorker) => ActivityWorker) => patch(w, 't34', r => ({ ...r, workers: [f(r.workers[0]), ...r.workers.slice(1)] }));

const verified = verificationClaim({
  specId: 'spec-1', revision: 1, outcome: 'verified', currentHeadSha: H2,
  criteria: [{ criterionId: 'R-1', text: 'Sends the export', verdict: 'pass', stale: false, headSha: H2 }],
}, { title: 'Billing exports', approvedRevision: 1 }, Date.parse(T('11:02')));

type Step = [label: string, apply: (w: World) => World];

const STORY: Step[] = [
  ['10:02 PR opened on H1', w => patchOwner(patch(w, 't34', r => ({ ...r, status: 'completed', updatedAt: T('10:02') })), o => ({ ...o, status: 'completed', completedAt: T('10:02'), updatedAt: T('10:02'), prUrl: PR, prNumber: 34, prLifecycleStatus: 'ci_running', lastCommitSha: H1 }))],
  ['10:08 CI fails on H1', w => patchOwner(w, o => ({ ...o, prLifecycleStatus: 'ci_failed', updatedAt: T('10:08') }))],
  ['10:10 automatic repair starts', w => ({ rows: [...w.rows, {
    id: 'fx1', title: '[builder · after CI #1] Export email', status: 'in_progress', taskClass: 'attempt', parentTaskId: 't34', missionId: 'm', missionTitle: 'Billing exports',
    createdAt: T('10:10'), updatedAt: T('10:10'), workers: [{ status: 'running', startedAt: T('10:10'), updatedAt: T('10:10') }],
  }] })],
  ['10:30 repair pushes H2', w => patchOwner(patch(w, 'fx1', r => ({ ...r, status: 'completed', updatedAt: T('10:30'), workers: [{ ...r.workers[0], status: 'completed', completedAt: T('10:30'), updatedAt: T('10:30'), lastCommitSha: H2 }] })), o => ({ ...o, prLifecycleStatus: 'ci_running' }))],
  ['10:40 CI green on H2', w => patchOwner(w, o => ({ ...o, prLifecycleStatus: 'ci_green' }))],
  ['10:58 review approves H2', w => ({ rows: [...w.rows, {
    id: 'rv1', title: '[reviewer #1] Export email', status: 'completed', taskClass: 'attempt', parentTaskId: 't34', missionId: 'm', missionTitle: 'Billing exports',
    createdAt: T('10:45'), updatedAt: T('10:58'), review: { verdict: 'approve', headSha: H2 },
    workers: [{ status: 'completed', startedAt: T('10:45'), completedAt: T('10:58'), updatedAt: T('10:58') }],
  }] })],
  ['11:02 spec verification passes on H2', w => patch(w, 't34', r => ({ ...r, verification: verified }))],
  ['11:04 merged', w => patchOwner(w, o => ({ ...o, mergedAt: T('11:04'), prLifecycleStatus: 'merged', updatedAt: T('11:04') }))],
  ['11:30 reopened', w => patch(w, 't34', r => ({ ...r, status: 'in_progress', updatedAt: T('11:30'), workers: [...r.workers, { status: 'running', startedAt: T('11:30'), updatedAt: T('11:30') }] }))],
];

const START: World = {
  rows: [
    { id: 't33', title: 'Export CSV', status: 'completed', taskClass: 'work', missionId: 'm', missionTitle: 'Billing exports', createdAt: T('08:00'), updatedAt: T('08:30'),
      workers: [{ status: 'completed', prUrl: `${PR}0`, prNumber: 33, mergedAt: T('08:30'), startedAt: T('08:00'), completedAt: T('08:20') }] },
    { id: 't34', title: 'Export email', status: 'in_progress', taskClass: 'work', missionId: 'm', missionTitle: 'Billing exports', createdAt: T('09:30'), updatedAt: T('09:30'),
      workers: [{ status: 'running', name: 'runner-a', startedAt: T('09:30'), updatedAt: T('09:30') }] },
  ],
};

function surfaces(w: World) {
  const mission = projectMissionDelivery({ id: 'm', title: 'Billing exports', status: 'active', href: '/app/missions/m', tasks: w.rows as MissionTaskRow[] }, rules);
  const now = buildActivityNow({ tasks: w.rows, missions: [mission], rules, now: Date.parse(T('12:00')) });
  const episodes = buildActivityEpisodes({ tasks: w.rows, missions: [mission], rules });
  const history = buildActivityHistory({ tasks: w.rows, missions: [mission], rules });
  const missionHistory = buildMissionHistory({ model: boardFixture('long-open'), feed: [], episodes, lens: 'highlights', timeZone: 'UTC' });
  return { mission, now, episodes, history, missionHistory, home: selectHomeMilestones([mission]) };
}

describe('AC-3: claim, CI failure, repair, verification, merge and reopen replay alike everywhere', () => {
  it('Activity, Home and Missions read the same chip and landed n/m after every event', () => {
    let w = START;
    const seen: DeliveryKind[] = [];
    for (const [label, apply] of STORY) {
      w = apply(w);
      const { mission, now, home } = surfaces(w);
      const kind = mission.tasks.find(t => t.id === 't34')!.delivery.kind;
      seen.push(kind);
      const row = now.groups.flatMap(g => g.rows).find(r => r.id === 't34');
      // Finished work leaves Now for History; in flight, Now's chip is the mission's.
      if (kind === 'landed') expect(row).toBeUndefined();
      else expect(`${label}: ${row?.delivery.kind}`).toBe(`${label}: ${kind}`);
      const group = now.groups.find(g => g.missionId === 'm');
      if (group) expect([group.kind, group.landed, group.total]).toEqual([mission.kind, mission.landed, mission.total]);
      const onHome = home.find(m => m.id === 'm');
      if (onHome) expect(onHome.kind).toBe(mission.kind);
    }
    expect(seen).toContain('repair');
    expect(seen.at(-1)).toBe('landed');
  });

  it('Activity History and Mission History Highlights tell the same steps, only ever growing at the end', () => {
    let w = START;
    let prev: string[] = [];
    for (const [label, apply] of STORY) {
      w = apply(w);
      const { episodes, missionHistory } = surfaces(w);
      const ep = episodes.find(e => e.id === 't34')!;
      const steps = ep.steps.map(s => s.text);
      const item = missionHistory.days.flatMap(d => d.items).find(i => i.type === 'episode' && i.taskId === 't34');
      expect(item?.type === 'episode' ? item.steps.map(s => s.text) : null).toEqual(steps);
      expect(`${label}: ${steps.slice(0, prev.length).join(' | ')}`).toBe(`${label}: ${prev.join(' | ')}`);
      prev = steps;
    }
    expect(prev).toEqual([
      'Build started',
      `Built; PR #34 opened at ${s7(H1)}`,
      `CI failed on ${s7(H1)}`,
      'Automatic repair 1: CI failed',
      `New head ${s7(H2)}; earlier verdicts superseded`,
      `Review approved on ${s7(H2)}`,
      `Verified against spec revision 1 on ${s7(H2)}`,
      'Merged',
      'Reopened',
    ]);
  });

  it('the merge alone never reads as verified; the recorded verdict does', () => {
    let w = START;
    for (const [label, apply] of STORY) {
      w = apply(w);
      const { now, history } = surfaces(w);
      const claim = now.groups.flatMap(g => g.rows).find(r => r.id === 't34')?.verification ?? history.find(e => e.id === 't34')?.verification ?? null;
      if (label < '11:02') expect(claim).toBeNull();
      else expect(claim?.state).toBe('passed');
    }
  });

  it('History Highlights leave detail out; the full chronology keeps it', () => {
    let w = START;
    for (const [, apply] of STORY) w = apply(w);
    const ep = surfaces(w).history.find(e => e.id === 't34')!;
    const highlights = ep.steps.filter(s => !s.detail).map(s => s.text);
    expect(highlights).not.toContain(`New head ${s7(H2)}; earlier verdicts superseded`);
    for (const k of ['Build started', `CI failed on ${s7(H1)}`, 'Automatic repair 1: CI failed', `Verified against spec revision 1 on ${s7(H2)}`, 'Merged', 'Reopened']) expect(highlights).toContain(k);
  });
});
