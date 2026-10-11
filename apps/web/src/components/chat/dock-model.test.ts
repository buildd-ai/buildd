/**
 * The desktop right panel's pure half (docs/design/chat-v3-desktop.md): which
 * thing it shows, what a task card in it says, and who is at work on a mission.
 */
import { describe, expect, it } from 'bun:test';
import { atWorkRows, dockChoice, dockToneForDelivery, needsDockRef, taskDockModel } from './dock-model';
import type { TaskObjectView } from './objects/object-views';
import type { BoardTask, MissionBoardModel } from '@/lib/mission-board';
import type { DeliveryDisplay } from '@/lib/workflow/delivery-display';

const mission = { kind: 'mission', id: 'm1', workspaceId: 'ws', fallbackText: 'Mission: M' } as const;
const needs = { kind: 'task', id: 't1', workspaceId: 'ws', fallbackText: 'Task: T' } as const;

describe('dockChoice', () => {
  it('history wins, then the object the chat is about, then the task that needs you', () => {
    expect(dockChoice({ historyOpen: true, focus: mission, needsRef: needs, needsClosedId: null })).toEqual({ mode: 'history', ref: null });
    expect(dockChoice({ historyOpen: false, focus: mission, needsRef: needs, needsClosedId: null })).toEqual({ mode: 'object', ref: mission });
    expect(dockChoice({ historyOpen: false, focus: null, needsRef: needs, needsClosedId: null })).toEqual({ mode: 'needs', ref: needs });
  });

  it('a closed needs-you dock stays closed for that task only; nothing to show is null', () => {
    expect(dockChoice({ historyOpen: false, focus: null, needsRef: needs, needsClosedId: 't1' })).toBeNull();
    expect(dockChoice({ historyOpen: false, focus: null, needsRef: needs, needsClosedId: 'other' })?.mode).toBe('needs');
    expect(dockChoice({ historyOpen: false, focus: null, needsRef: null, needsClosedId: null })).toBeNull();
  });
});

describe('needsDockRef', () => {
  it('the first waiting task as a task ref; none without a task id', () => {
    expect(needsDockRef([{ title: 'feat(fx): rounding', taskId: 't9', workspaceId: 'ws' }])).toEqual({ kind: 'task', id: 't9', workspaceId: 'ws', title: 'feat(fx): rounding', fallbackText: 'Task: feat(fx): rounding' });
    expect(needsDockRef([{ title: 'x' }])).toBeNull();
    expect(needsDockRef([])).toBeNull();
    expect(needsDockRef(undefined)).toBeNull();
  });
});

const view = (over: Partial<TaskObjectView> = {}, worker: Partial<NonNullable<TaskObjectView['worker']>> | null = {}): TaskObjectView => ({
  kind: 'task', id: 't1', workspaceId: 'ws', title: 'feat(receipts): totals in the buyer currency', scope: 'receipts', label: 'totals in the buyer currency',
  status: 'in_progress', roleName: 'Builder', roleColor: null, missionId: null, missionTitle: null,
  worker: worker === null ? null : {
    id: 'w1', status: 'running', runner: 'atlas', startedAt: 1, completedAt: null, currentAction: null, waiting: false,
    prNumber: null, prUrl: null, mergedAt: null, prLifecycleStatus: null, turns: 7, updatedAt: 2, ...worker,
  },
  now: null, renderedAt: 3, attempts: 2, happened: [{ ts: 1, text: 'Started the change' }], ...over,
});

describe('taskDockModel title: the sentence the needs-you pulse names the task by', () => {
  // The board's short label ("Stripe in currency") is a tile label, not a card title.
  const cases: Array<[string, string, string | null, string]> = [
    ['stored board label ignored', 'feat(checkout): pay in the presentment currency via Stripe', 'Stripe in currency', 'Pay in the presentment currency via Stripe'],
    ['conventional prefix stripped', 'fix(receipts): show totals in the buyer currency', null, 'Show totals in the buyer currency'],
    ['retry bracket stripped', '[builder · after CI #1] fix(billing): round currency per line', null, 'Round currency per line'],
    ['plain title kept', 'Round per line, or only the total?', null, 'Round per line, or only the total?'],
  ];
  for (const [name, title, label, want] of cases) {
    it(name, () => {
      expect(taskDockModel(view({ title, label: label ?? '' })).title).toBe(want);
    });
  }

  it('matches the pulse row\'s task name for the same task', async () => {
    const { pulseNeedsYou } = await import('./canvas-empty');
    const t = { title: 'feat(checkout): pay in the presentment currency via Stripe', label: 'Stripe in currency' };
    expect(taskDockModel(view(t)).title).toBe(pulseNeedsYou([t])[0].title);
  });

  it('actions name the task by that sentence too', () => {
    const m = taskDockModel(view({ title: 'feat(checkout): pay in the presentment currency via Stripe', label: 'Stripe in currency', status: 'failed' }, { status: 'failed' }));
    expect(m.actions[0].text).toBe('Try a fix for pay in the presentment currency via Stripe.');
  });
});

describe('taskDockModel', () => {
  it('a task waiting on a question: NEEDS YOU badge, the question as the insight, Answer it first', () => {
    const m = taskDockModel(view({ waitingPrompt: 'Round per line or on the total?' }, { status: 'waiting_input', waiting: true }));
    expect(m.badge).toEqual({ label: 'Needs you', tone: 'needs' });
    expect(m.insight).toEqual({ text: 'Round per line or on the total?', flag: true });
    expect(m.actions.map(a => a.label)).toEqual(['Answer it', 'Ask about it']);
    expect(m.actions[0]).toMatchObject({ kind: 'answer', primary: true });
    expect(m.happened.at(-1)).toEqual({ ts: null, text: 'Needs input.', needs: true });
  });

  it('a stopped task: STOPPED, its error as the insight, Try a fix and Show the error', () => {
    const m = taskDockModel(view({ status: 'failed', error: 'The rounding test fails for currencies with no cents.' }, { status: 'failed' }));
    expect(m.badge).toEqual({ label: 'Stopped', tone: 'needs' });
    expect(m.insight?.text).toBe('The rounding test fails for currencies with no cents.');
    expect(m.actions.map(a => a.label)).toEqual(['Try a fix', 'Show the error']);
    expect(m.actions[0]).toMatchObject({ kind: 'send', primary: true });
    expect(m.actions[0].text).toContain('totals in the buyer currency');
    expect(m.happened.at(-1)).toEqual({ ts: null, text: 'Stopped. Needs input.', needs: true });
  });

  it('tries: one segment per run, copper when it stopped, blue while live, green once landed', () => {
    expect(taskDockModel(view({ status: 'failed' }, { status: 'failed' })).tries).toEqual({ value: '2', segs: ['needs', 'needs'] });
    expect(taskDockModel(view({}, { status: 'running' })).tries.segs).toEqual(['needs', 'live']);
    expect(taskDockModel(view({ status: 'completed', attempts: 1 }, { status: 'completed', mergedAt: 5, prNumber: 4 })).tries.segs).toEqual(['landed']);
    expect(taskDockModel(view({ attempts: 0 }, null)).tries).toEqual({ value: '0', segs: [] });
    expect(taskDockModel(view({ attempts: 9 }, { status: 'running' })).tries.segs).toHaveLength(6);
  });

  it('running and landed tasks: no actions, no copper', () => {
    const live = taskDockModel(view({}, { status: 'running', currentAction: 'Editing receipts.ts' }));
    expect(live.badge.tone).toBe('live');
    expect(live.insight).toEqual({ text: 'Editing receipts.ts', flag: false });
    expect(live.actions).toEqual([]);
    const done = taskDockModel(view({ status: 'completed' }, { status: 'completed', mergedAt: 5, prNumber: 4 }));
    expect(done.badge).toEqual({ label: 'Landed', tone: 'landed' });
    expect(done.actions).toEqual([]);
  });

  it('a stalled delivery uses warning tone, not live', () => {
    const stalled = {
      stage: 'blocked' as const,
      state: 'BLOCKED_ON_TRUNK' as const,
      headline: 'Blocked on base',
      owner: 'kernel' as const,
    };
    const toned = dockToneForDelivery(stalled);
    expect(toned).not.toBeNull();
    expect(toned?.tone).not.toBe('live');
    expect(toned?.tone).toBe('needs');
  });
});

const task = (id: string, status: BoardTask['status'], label: string, endedAt: number | null = null) =>
  ({ id, status, label, scope: null, endedAt, currentAction: null }) as unknown as BoardTask;

describe('atWorkRows', () => {
  it('live and waiting work first, then the latest landed, capped', () => {
    const board = {
      phases: [{ taskIds: ['a', 'b', 'c', 'd', 'e'] }],
      tasks: { a: task('a', 'merged', 'refund retries', 5), b: task('b', 'running', 'queue for card payments'), c: task('c', 'ready', 'later'), d: task('d', 'review', 'slow provider alerts'), e: task('e', 'merged', 'old', 1) },
    } as unknown as MissionBoardModel;
    const rows = atWorkRows(board, 3);
    expect(rows.map(r => [r.label, r.state, r.tone])).toEqual([
      ['queue for card payments', 'working', 'live'],
      ['slow provider alerts', 'in review', 'live'],
      ['refund retries', 'landed', 'landed'],
    ]);
  });

  it('a task waiting on you reads copper', () => {
    const board = { phases: [{ taskIds: ['a'] }], tasks: { a: task('a', 'waiting', 'checkout') } } as unknown as MissionBoardModel;
    expect(atWorkRows(board)[0]).toMatchObject({ state: 'needs input', tone: 'needs' });
  });
});
