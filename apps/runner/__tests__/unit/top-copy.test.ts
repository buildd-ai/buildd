/**
 * The words the Missions view says for each state (spec c7410e76 R-18, R-24,
 * R-51 to R-56, AC-34 to AC-39): a mission's status line, an empty pane, a local session's
 * mission, work another runner runs, and queued work the task list left out.
 */
import { describe, expect, test } from 'bun:test';
import { LOCAL_CLAIM_WORDS, handleKey } from '../../src/top/keys';
import { queueRowList, type QueueRow } from '../../src/top/queue';
import {
  NO_MISSION, emptyMissionWords, missionRowStage, missionStageLine, missionStatusLine, queueRowReason, reduce, taskRows,
  type MissionRow, type TopState,
} from '../../src/top/state';
import { NOW, fixtureState } from './top-fixture';
import { queueState } from './top-queue-fixture';

const row = (over: Partial<MissionRow> = {}): MissionRow => ({ key: 'm-1', title: 'M', done: 0, total: 0, running: 0, planning: false, team: null, local: false, held: false, ...over });
const stage = (step: any, waitingOn: string | null = null) => ({ stage: { step, waitingOn } });
const key = (ch: string) => ({ name: 'char' as const, ch });

describe('the status line under a mission\'s title', () => {
  test('the stage, then what it waits on, in the server\'s words ("landed" is merged)', () => {
    expect(missionStatusLine(row(stage('building', '5 of 6 landed')))).toBe('Building · 5 of 6 landed');
    expect(missionStatusLine(row(stage('delivering', 'approve the mission PR')))).toBe('Delivering · approve the mission PR');
    expect(missionStatusLine(row(stage('on_hold')))).toBe('On hold');
  });

  test('a finished visual review says what happened, not where to look', () => {
    expect(missionStatusLine(row(stage('verifying', 'see the mission page')))).toBe('Verifying · visual review finished, results on buildd');
    expect(missionStageLine(row(stage('verifying', 'see the mission page')))).toBe('verifying: visual review finished, results on buildd');
  });

  test('without a stage it counts tasks in words; a local session\'s mission says who runs it', () => {
    expect(missionStatusLine(row({ done: 2, total: 8 }))).toBe('2 of 8 tasks done');
    expect(missionStatusLine(row({ ...stage('building', '1 of 2 landed'), local: true }))).toBe('Building · 1 of 2 landed · Managed from a local session');
    expect(missionStatusLine(row({ planning: true }))).toBe('Planning');
    expect(missionStatusLine(row({ deliveredAt: NOW }))).toMatch(/^Delivered [A-Z][a-z]{2} \d{1,2}$/);
  });

  test('loose tasks, and the fold row, which has no status line', () => {
    expect(missionStatusLine(row({ key: NO_MISSION, done: 2, total: 5 }))).toBe('Tasks outside any mission · 3 open');
    expect(missionStatusLine(row({ key: NO_MISSION }))).toBeNull();
    expect(missionStatusLine(row({ key: 'fold:Acme', fold: { count: 4, open: false } }))).toBeNull();
  });
});

describe('an empty pane says what is empty', () => {
  test('a mission with finished work has no activity today; it is not empty', () => {
    expect(emptyMissionWords(row({ done: 11, total: 11 }), '')).toBe('No activity today. o opens the mission on buildd.');
    expect(emptyMissionWords(row({ stage: { step: 'verifying', waitingOn: null, progress: [{ state: 'landed', group: 'done' }] } }), '')).toBe('No activity today. o opens the mission on buildd.');
  });

  test('nothing at all; a filter; a delivered mission; loose tasks', () => {
    expect(emptyMissionWords(row(), '')).toBe('No activity yet.');
    expect(emptyMissionWords(row({ done: 3, total: 3 }), 'zzz')).toBe('Nothing matches the filter.');
    expect(emptyMissionWords(row({ deliveredAt: NOW }), '')).toBe('Its work is finished. o opens it on buildd.');
    expect(emptyMissionWords(row({ key: NO_MISSION }), '')).toBe('No tasks outside a mission.');
  });

  test('never the old sentences', () => {
    for (const r of [row(), row({ local: true }), row({ done: 4, total: 6 })]) {
      expect(emptyMissionWords(r, '')).not.toMatch(/Nothing here yet|shows up as it happens|A person runs/);
    }
  });
});

describe('a mission managed from a local session', () => {
  test('its row says so in its stage words, not on a detached line', () => {
    expect(missionRowStage(row({ ...stage('building'), local: true }))).toBe('building locally');
    expect(missionRowStage(row({ local: true }))).toBe('local');
    expect(missionRowStage(row(stage('building')))).toBe('building');
  });

  test('its tasks are listed, waiting for the session; c says where that changes and claims nothing', () => {
    const s: TopState = { ...fixtureState(), selectedMission: 'm-local-000-0000' };
    const rows = taskRows(s, NOW);
    expect(rows.map(r => [r.title, r.reason, r.elsewhere])).toEqual([['person session work', 'for the local session to pick up', 'local']]);
    const r = handleKey(s, key('c'), NOW);
    expect(r.effects).toEqual([]);
    expect(r.state.status).toEqual({ text: LOCAL_CLAIM_WORDS, tone: 'error' });
  });

  test('a task its session runs is listed as running there; p and x say they cannot reach it', () => {
    const s0 = fixtureState();
    const s = reduce(s0, { type: 'tasks', tasks: s0.tasks.map(t => t.id === 't-local' ? { ...t, status: 'in_progress' } : t) });
    const sel: TopState = { ...s, selectedMission: 'm-local-000-0000' };
    expect(taskRows(sel, NOW)[0]).toMatchObject({ group: 'running', kind: 'running', action: 'running in a local session', elsewhere: 'local' });
    for (const ch of ['p', 'x', 'm', 'a']) {
      const r = handleKey(sel, key(ch), NOW);
      expect(r.effects).toEqual([]);
      expect(r.state.status?.text).toBe('"person session work" runs in a local session; top acts only on this runner\'s agents. o opens it on buildd.');
    }
  });
});

describe('o with no task picked opens the mission', () => {
  test('from the missions pane, the selected mission\'s page', () => {
    const s: TopState = { ...fixtureState(), focus: 'missions' };
    expect(handleKey(s, key('o'), NOW).effects).toEqual([{ type: 'openMission', missionId: 'm-tui-0000-0000' }]);
  });

  test('not for loose tasks', () => {
    const s: TopState = { ...fixtureState(), focus: 'missions', selectedMission: NO_MISSION };
    expect(handleKey(s, key('o'), NOW).effects).toEqual([]);
  });
});

describe('queued work the task list left out', () => {
  const q = (over: Partial<QueueRow>): QueueRow => ({ taskId: 'q', position: 3, title: 'T', missionId: 'm', workspace: 'w', mission: 'M', est: null, starts: 'now', ...over });

  test('its wait says where it is in the Queue view', () => {
    expect(queueRowReason(q({}))).toBe('#3 in queue · starts on the next claim');
    expect(queueRowReason(q({ starts: 'after its dependency' }))).toBe('#3 in queue · after its dependency');
    expect(queueRowReason(q({ position: null, held: true, reason: 'retries after failures, 18:26', starts: '18:26 · retries after failures' }))).toBe('retries after failures, 18:26');
  });

  test('the Missions view lists a mission\'s queued tasks the task list did not send', () => {
    const s0 = queueState();
    const qt = s0.queue!.teams[0].queue.find(t => t.missionId)!;
    const missionId = qt.missionId!;
    // The server lists every open mission (GET /api/missions/recent), with or without tasks in the list.
    const s = reduce(s0, { type: 'missions', missions: [{ id: missionId, title: qt.missionTitle ?? 'M', workspaceId: qt.workspaceId, status: 'active', isHeld: false, executor: 'runner', completedAt: null, stage: null }] });
    const listed = new Set(s.tasks.map(t => t.id));
    // What the Queue view draws (the organizer's planning run is not work there either).
    const queued = queueRowList(s, NOW).filter(t => t.missionId === missionId && !listed.has(t.taskId)).map(t => ({ id: t.taskId }));
    expect(queued.length).toBeGreaterThan(0);
    const rows = taskRows({ ...s, view: 'missions', selectedMission: missionId }, NOW);
    for (const t of queued) expect(rows.map(r => r.taskId)).toContain(t.id);
    expect(rows.filter(r => queued.some(t => t.id === r.taskId)).every(r => r.group === 'waiting' && !!r.reason)).toBe(true);
  });
});
