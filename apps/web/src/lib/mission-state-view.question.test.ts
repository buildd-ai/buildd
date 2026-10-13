/**
 * A worker parked on a question (`waiting_input`) is the person's move, on
 * every mission surface that reads the shared accessor.
 *
 * Regression: a local-executor mission whose one task was claimed from a
 * person's own session and parked on `ask_human` read "Running in a local
 * session (1 agent). 1 task is still open." with the cause "A worker is
 * running it." The page banner said the task needed input; the accessor
 * counted the waiting worker as live work and never saw the question.
 */
import { describe, it, expect } from 'bun:test';
import { deriveMissionStateView, missionNeedsYou, type MissionStateInput } from './mission-state-view';
import { buildStateBecause } from './explain-because';
import { missionOpenQuestions } from './open-ask';
import { buildMissionBoard, boardNeedsYouCount, toBoardTaskInput } from './mission-board';
import { affordanceFor } from '@/components/missions/MissionSituationBlock';

const base: MissionStateInput = { status: 'active', isHeld: false, activeAgents: 0, health: 'NOMINAL' };
const PROMPT = 'Which database should the import write to?';
const ask = { taskId: 't1', title: 'Import the fixtures', prompt: PROMPT };

describe('deriveMissionStateView — an open question', () => {
  const local: MissionStateInput = {
    ...base,
    executor: 'local',
    activeAgents: 1,
    openTasks: [{ id: 't1', status: 'assigned', title: 'Import the fixtures' }],
    openQuestions: [ask],
  };

  it('a local session parked on ask_human needs the person, not "a worker is running it"', () => {
    const view = deriveMissionStateView(local);
    expect(view.kind).toBe('awaiting_decision');
    expect(missionNeedsYou(view)).toBe(true);
    // The question itself is the headline: no "Needs input" label in front.
    expect(view.situation.headline).toBe(PROMPT);
    expect(view.situation.headline).not.toMatch(/Running|agent|still open|Needs/);
    expect(view.situation.focus).toMatchObject({ kind: 'human_decision', question: { taskIds: ['t1'] } });
    expect(view.situation.nextAction).toBe('Answer it on the task page to continue.');
    // The chip still says who runs the work.
    expect(view.chip.label).toBe('LOCAL');
  });

  it('the same question on a runner mission needs the person too', () => {
    const view = deriveMissionStateView({ ...local, executor: 'runner' });
    expect(view.kind).toBe('awaiting_decision');
    expect(missionNeedsYou(view)).toBe(true);
    expect(view.situation.headline).toBe(PROMPT);
  });

  it('several questions are counted, not quoted', () => {
    const view = deriveMissionStateView({ ...local, openQuestions: [ask, { taskId: 't2', title: 'Write docs', prompt: 'Which tone?' }] });
    expect(view.situation.headline).toBe('2 questions for you.');
    expect(view.situation.nextAction).toBe('Answer them on each task page to continue.');
  });

  it('a question with no prompt still says what is needed', () => {
    const view = deriveMissionStateView({ ...local, openQuestions: [{ ...ask, prompt: null }] });
    expect(view.situation.headline).toBe('An agent is waiting for your answer.');
  });

  it('held still outranks it, and a failure still leads', () => {
    expect(deriveMissionStateView({ ...local, isHeld: true }).kind).toBe('held');
    const failing = deriveMissionStateView({ ...local, completion: { code: 'infra_stalled', infraStalledTitles: ['Broke'] } as never });
    expect(failing.outstanding.map(f => f.kind)).toContain('human_decision');
  });

  it('its one action opens the asking task page to answer it, never the in-page strip anchor', () => {
    const view = deriveMissionStateView(local);
    expect(affordanceFor(view.situation.focus, { missionId: 'm' })).toMatchObject({
      kind: 'internal', label: 'Answer the question', taskId: 't1', navigate: true,
      href: '/app/tasks/t1?from=mission&missionId=m&respond=1',
    });
  });

  it('the cause line names the question, never a running worker', () => {
    const view = deriveMissionStateView(local);
    const chain = buildStateBecause(view, { missionId: 'm', workspaceId: 'ws' }, {
      openTasks: [{ id: 't1', title: 'Import the fixtures', status: 'assigned', live: true, waiting: true }],
    });
    const text = chain.map(l => l.claim).join('\n');
    expect(chain[0].claim).toBe(`"Import the fixtures" asks: ${PROMPT}`);
    expect(chain[0].refs.taskId).toBe('t1');
    expect(text).not.toMatch(/worker|is assigned/);
  });
});

describe('missionOpenQuestions', () => {
  it('reads an open ask off any worker of a task that can still continue', () => {
    const rows = [
      { id: 't1', title: 'Import the fixtures', status: 'assigned', workers: [{ status: 'waiting_input', waitingFor: { prompt: PROMPT } }] },
      { id: 't2', title: 'Done', status: 'completed', workers: [{ status: 'waiting_input', waitingFor: { prompt: 'stale' } }] },
      { id: 't3', title: 'Running', status: 'in_progress', workers: [{ status: 'running', waitingFor: null }] },
    ];
    expect(missionOpenQuestions(rows)).toEqual([ask]);
  });
});

describe('buildMissionBoard — an interactive session parked on a question', () => {
  it('counts it in Needs you, as the banner does', () => {
    const now = Date.UTC(2026, 0, 1, 12);
    const t = toBoardTaskInput({
      id: 't1', title: 'Import the fixtures', status: 'assigned', taskClass: 'work', createdAt: new Date(now - 120_000),
      workers: [{ id: 'w1', status: 'waiting_input', runner: 'mcp', startedAt: null, createdAt: new Date(now - 90_000), updatedAt: new Date(now - 30_000), waitingFor: { type: 'question', prompt: PROMPT } }],
    });
    const m = buildMissionBoard({ tasks: [t], now, missionCreatedAt: now - 200_000, missionCompletedAt: null, missionStatus: 'active' } as never);
    expect(m.tasks.t1.status).toBe('waiting');
    expect(m.needsYou).toEqual(['t1']);
    expect(boardNeedsYouCount(m, null)).toBe(1);
  });

  // Regression: the page reads workers ordered by startedAt DESC, where
  // Postgres puts NULLs first, so a worker that never started (a reaped claim)
  // sorted ahead of the session parked on the question. The situation block
  // (missionOpenQuestions: any worker) said "Needs input", the rail said
  // "Needs you 0". The asking worker is the task's worker, whatever the order.
  it('counts it when a never-started worker sorts ahead of the asking one', () => {
    const now = Date.UTC(2026, 0, 1, 12);
    const row = {
      id: 'c1', title: 'Continue: Import the fixtures', status: 'assigned', taskClass: 'work', parentTaskId: 'p1', createdAt: new Date(now - 120_000),
      workers: [
        { id: 'w0', status: 'failed', runner: 'mcp', startedAt: null, createdAt: new Date(now - 100_000), updatedAt: new Date(now - 95_000), waitingFor: null },
        { id: 'w1', status: 'waiting_input', runner: 'mcp', startedAt: new Date(now - 90_000), createdAt: new Date(now - 90_000), updatedAt: new Date(now - 30_000), waitingFor: { type: 'question', prompt: PROMPT } },
      ],
    };
    const parent = toBoardTaskInput({ id: 'p1', title: 'Import the fixtures', status: 'completed', taskClass: 'work', createdAt: new Date(now - 300_000), workers: [] });
    const m = buildMissionBoard({ tasks: [parent, toBoardTaskInput(row)], now, missionCreatedAt: now - 400_000, missionCompletedAt: null, missionStatus: 'active' } as never);
    expect(missionOpenQuestions([row]).map(q => q.taskId)).toEqual(['c1']);
    expect(m.tasks.c1.status).toBe('waiting');
    expect(m.tasks.c1.waitingFor?.prompt).toBe(PROMPT);
    expect(boardNeedsYouCount(m, null)).toBe(1);
  });
});
