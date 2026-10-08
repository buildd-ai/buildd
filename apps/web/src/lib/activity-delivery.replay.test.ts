/**
 * Replay: one delivery's canonical events (build → PR → review asks for
 * changes → automatic repair → new head → late stale approval → renewed
 * approval → merge), folded into the rows Activity, Missions and Home load.
 * After every event the three surfaces must read the same chip, the same
 * landed n/m and the same Home membership; Activity's evidence must never
 * count a verdict for a superseded head; History must keep one episode whose
 * steps only ever grow at the end.
 */
import { describe, expect, it } from 'bun:test';
import * as rules from '@buildd/core/mission-helpers';
import { projectMissionDelivery, selectHomeMilestones, type DeliveryKind, type MissionTaskRow } from './delivery-projection';
import { buildActivityHistory, buildActivityNow, type ActivityTaskInput, type ActivityWorker } from './activity-delivery';

const PR = 'https://github.com/example/project/pull/34';
const H1 = 'a1b2c3d4e5f6';
const H2 = 'd4e5f60718293';
const T = (hhmm: string) => `2026-10-08T${hhmm}:00.000Z`;

const landed = (n: number): ActivityTaskInput => ({
  id: `t${String(n).padStart(2, '0')}`, title: `Task ${n}`, status: 'completed', taskClass: 'work', missionId: 'm', missionTitle: 'Billing exports',
  createdAt: T('08:00'), updatedAt: T('08:30'),
  workers: [{ status: 'completed', prUrl: `${PR}${n}`, prNumber: 100 + n, mergedAt: T('08:30'), startedAt: T('08:00'), completedAt: T('08:20') }],
});

interface World { rows: ActivityTaskInput[] }
const subject = (w: World) => w.rows.find(r => r.id === 't34')!;
const patch = (w: World, id: string, f: (r: ActivityTaskInput) => ActivityTaskInput): World => ({ rows: w.rows.map(r => (r.id === id ? f(r) : r)) });
const patchOwner = (w: World, f: (o: ActivityWorker) => ActivityWorker) => patch(w, 't34', r => ({ ...r, workers: [f(r.workers[0])] }));
const attempt = (id: string, title: string, at: string, extra: Partial<ActivityTaskInput> = {}): ActivityTaskInput => ({
  id, title, status: 'in_progress', taskClass: 'attempt', parentTaskId: 't34', missionId: 'm', missionTitle: 'Billing exports',
  createdAt: T(at), updatedAt: T(at), workers: [{ status: 'running', startedAt: T(at), updatedAt: T(at) }], ...extra,
});
const finish = (w: World, id: string, at: string, extra: Partial<ActivityTaskInput> = {}, worker: Partial<ActivityWorker> = {}) =>
  patch(w, id, r => ({ ...r, status: 'completed', updatedAt: T(at), ...extra, workers: [{ ...r.workers[0], status: 'completed', completedAt: T(at), updatedAt: T(at), ...worker }] }));

type Step = [label: string, apply: (w: World) => World, expected: DeliveryKind];

/**
 * The chip comes from today's worker/PR fields only, on every surface alike —
 * none of them feeds review verdicts to the projection yet, so a review's
 * verdict shows in Activity's evidence, never as a chip only Activity has.
 */
const STORY: Step[] = [
  ['10:02 PR opened on H1', w => patchOwner(patch(w, 't34', r => ({ ...r, status: 'completed', updatedAt: T('10:02') })), o => ({ ...o, status: 'completed', completedAt: T('10:02'), updatedAt: T('10:02'), prUrl: PR, prNumber: 34, prLifecycleStatus: 'ci_running', lastCommitSha: H1 })), 'audit'],
  ['10:05 CI green on H1', w => patchOwner(w, o => ({ ...o, prLifecycleStatus: 'ci_green' })), 'audit'],
  ['10:10 review starts on H1', w => ({ rows: [...w.rows, attempt('rv1', '[reviewer #1] Export email', '10:10', { review: { verdict: null, headSha: H1 } })] }), 'audit'],
  ['10:20 review asks for changes on H1', w => finish(w, 'rv1', '10:20', { review: { verdict: 'request-changes', headSha: H1 } }), 'audit'],
  ['10:21 automatic repair starts', w => ({ rows: [...w.rows, attempt('fx1', '[builder · after review #1] Export email', '10:21')] }), 'repair'],
  ['10:48 repair pushes H2', w => patchOwner(finish(w, 'fx1', '10:48', {}, { lastCommitSha: H2 }), o => ({ ...o, prLifecycleStatus: 'ci_running' })), 'audit'],
  ['10:51 late approval for H1 arrives', w => finish({ rows: [...w.rows, attempt('rv2', '[reviewer #2] Export email', '10:49')] }, 'rv2', '10:51', { review: { verdict: 'approve', headSha: H1 } }), 'audit'],
  ['10:55 CI green on H2', w => patchOwner(w, o => ({ ...o, prLifecycleStatus: 'ci_green' })), 'audit'],
  ['11:03 review approves H2', w => finish({ rows: [...w.rows, attempt('rv3', '[reviewer #3] Export email', '10:56')] }, 'rv3', '11:03', { review: { verdict: 'approve', headSha: H2 } }), 'audit'],
  ['11:04 merged', w => patchOwner(w, o => ({ ...o, mergedAt: T('11:04'), prLifecycleStatus: 'merged', updatedAt: T('11:04') })), 'landed'],
];

const START: World = {
  rows: [
    ...Array.from({ length: 33 }, (_, i) => landed(i + 1)),
    { id: 't34', title: 'Export email', status: 'in_progress', taskClass: 'work', missionId: 'm', missionTitle: 'Billing exports', createdAt: T('09:30'), updatedAt: T('09:30'), workers: [{ status: 'running', name: 'runner-a', startedAt: T('09:30'), updatedAt: T('09:30') }] },
    { id: 't35', title: 'Settings UI', status: 'pending', taskClass: 'work', missionId: 'm', missionTitle: 'Billing exports', createdAt: T('09:00'), updatedAt: T('09:00'), workers: [] },
  ],
};
const deps: Record<string, string[]> = { t35: ['t34'] };

/** What the Missions page and Home read: the shared projection over the mission's task rows. */
function missionsView(w: World) {
  const tasks: MissionTaskRow[] = w.rows.map(r => ({ ...r, dependsOn: deps[r.id] ?? null }));
  return projectMissionDelivery({ id: 'm', title: 'Billing exports', status: 'active', href: '/app/missions/m', tasks }, rules);
}

function surfaces(w: World) {
  const mission = missionsView(w);
  const now = buildActivityNow({ tasks: w.rows, missions: [mission], rules, now: Date.parse(T('12:00')) });
  const history = buildActivityHistory({ tasks: w.rows, missions: [mission], rules });
  return { mission, now, history, home: selectHomeMilestones([mission]) };
}

describe('replay: audit fails → repair → re-audit → land, on every surface', () => {
  it('Activity, Missions and Home read the same chip, count and membership after every event', () => {
    let w = START;
    const first = surfaces(w);
    expect(first.now.groups[0].rows[0].delivery.kind).toBe('build');
    for (const [label, apply, expected] of STORY) {
      w = apply(w);
      const { mission, now, home } = surfaces(w);
      const missionTask = mission.tasks.find(t => t.id === 't34')!.delivery;
      expect(`${label}: ${missionTask.kind}`).toBe(`${label}: ${expected}`);

      const group = now.groups.find(g => g.missionId === 'm');
      const row = group?.rows.find(r => r.id === 't34');
      if (expected === 'landed') {
        // Landed leaves Now; it lives in History.
        expect(row).toBeUndefined();
      } else {
        expect(`${label}: ${row?.delivery.kind}`).toBe(`${label}: ${missionTask.kind}`);
        expect(row?.delivery.repairRounds).toBe(missionTask.repairRounds);
      }
      if (group) {
        expect(group.kind).toBe(mission.kind);
        expect([group.landed, group.total]).toEqual([mission.landed, mission.total]);
        expect(group.next).toBe(mission.next);
      }
      // Home lists the mission exactly when it is moving, with the same chip.
      const onHome = home.find(m => m.id === 'm');
      if (onHome) expect(onHome.kind).toBe(mission.kind);
      // Auto-repair and audit never ask a person.
      expect(missionTask.needsHuman).toBe(false);
    }
  });

  it('landed n/m moves only on the merge', () => {
    let w = START;
    for (const [, apply, expected] of STORY) {
      w = apply(w);
      expect(missionsView(w).landed).toBe(expected === 'landed' ? 34 : 33);
    }
  });

  it('a stale approval is shown struck through and never counted; the current head leads', () => {
    let w = START;
    for (const [label, apply] of STORY) {
      w = apply(w);
      if (label.startsWith('10:51')) break;
    }
    const row = surfaces(w).now.groups[0].rows.find(r => r.id === 't34')!;
    const [current, repair, older] = row.evidence;
    expect(current).toMatchObject({ type: 'revision', current: true, sha: H2.slice(0, 7) });
    expect(repair).toMatchObject({ type: 'repair', round: 1, reason: 'review', status: 'pushed' });
    expect(older).toMatchObject({ type: 'revision', current: false, sha: H1.slice(0, 7) });
    if (current.type !== 'revision' || older.type !== 'revision') throw new Error('unreachable');
    // Nothing on the current head has passed review yet.
    expect(current.gates.find(g => g.name.startsWith('Code review'))?.result).not.toBe('passed');
    const late = older.gates.find(g => g.result === 'approved')!;
    expect(late.void).toBe(true);
    expect(late.why).toContain('Stale head');
    expect(older.gates.find(g => g.result === 'changes requested')?.void).toBe(false);
  });

  it('after the renewed approval the current head shows review passed and CI passed', () => {
    let w = START;
    for (const [label, apply] of STORY) {
      w = apply(w);
      if (label.startsWith('11:03')) break;
    }
    const row = surfaces(w).now.groups[0].rows.find(r => r.id === 't34')!;
    const current = row.evidence[0];
    if (current.type !== 'revision') throw new Error('expected a revision first');
    expect(current.gates.filter(g => !g.void).map(g => `${g.name.replace(/ \d+$/, '')}:${g.result}`)).toEqual(['Code review:passed', 'CI:passed']);
  });

  it('History keeps one episode for the delivery; its steps only grow at the end', () => {
    let w = START;
    let prev: string[] = [];
    for (const [label, apply] of STORY) {
      w = apply(w);
      const eps = surfaces(w).history;
      // Reviewer and repair attempts fold into the deliverable: no rows of their own.
      expect(eps.map(e => e.id)).not.toContainAnyValues(['rv1', 'rv2', 'rv3', 'fx1']);
      const ep = eps.find(e => e.id === 't34')!;
      const steps = ep.steps.map(s => s.text);
      expect(`${label}: ${steps.slice(0, prev.length).join(' | ')}`).toBe(`${label}: ${prev.join(' | ')}`);
      prev = steps;
    }
    const final = surfaces(w).history.find(e => e.id === 't34')!;
    expect(final.kind).toBe('landed');
    expect(final.repairRounds).toBe(1);
    expect(final.steps.map(s => s.text)).toEqual([
      'Build started',
      `Built; PR #34 opened at ${H1.slice(0, 7)}`,
      `Review requested changes on ${H1.slice(0, 7)}`,
      'Automatic repair 1: review notes',
      `New head ${H2.slice(0, 7)}; earlier verdicts superseded`,
      `Late approval on ${H1.slice(0, 7)}: stale head, not counted`,
      `Review approved on ${H2.slice(0, 7)}`,
      'Landed',
    ]);
    expect(final.steps.find(s => s.text.startsWith('Late approval'))?.void).toBe(true);
    // The landed episode is now the newest in History.
    expect(surfaces(w).history[0].id).toBe('t34');
  });
});
