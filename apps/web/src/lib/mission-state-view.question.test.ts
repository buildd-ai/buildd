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
    expect(view.situation.headline).toBe(`Needs input: ${PROMPT}`);
    expect(view.situation.headline).not.toMatch(/Running|agent|still open/);
    expect(view.situation.focus).toMatchObject({ kind: 'human_decision', question: { taskIds: ['t1'] } });
    expect(view.situation.nextAction).toBe('Answer it on the task page to continue.');
    // The chip still says who runs the work.
    expect(view.chip.label).toBe('LOCAL');
  });

  it('the same question on a runner mission needs the person too', () => {
    const view = deriveMissionStateView({ ...local, executor: 'runner' });
    expect(view.kind).toBe('awaiting_decision');
    expect(missionNeedsYou(view)).toBe(true);
    expect(view.situation.headline).toBe(`Needs input: ${PROMPT}`);
  });

  it('several questions are counted, not quoted', () => {
    const view = deriveMissionStateView({ ...local, openQuestions: [ask, { taskId: 't2', title: 'Write docs', prompt: 'Which tone?' }] });
    expect(view.situation.headline).toBe('2 tasks need input.');
    expect(view.situation.nextAction).toBe('Answer them on each task page to continue.');
  });

  it('a question with no prompt still says what is needed', () => {
    const view = deriveMissionStateView({ ...local, openQuestions: [{ ...ask, prompt: null }] });
    expect(view.situation.headline).toBe('A task needs input.');
  });

  it('held still outranks it, and a failure still leads', () => {
    expect(deriveMissionStateView({ ...local, isHeld: true }).kind).toBe('held');
    const failing = deriveMissionStateView({ ...local, completion: { code: 'infra_stalled', infraStalledTitles: ['Broke'] } as never });
    expect(failing.outstanding.map(f => f.kind)).toContain('human_decision');
  });

  it('its one action opens the asking task to answer it', () => {
    const view = deriveMissionStateView(local);
    expect(affordanceFor(view.situation.focus, { missionId: 'm' })).toMatchObject({ kind: 'internal', label: 'Answer the question', taskId: 't1' });
  });

  it('the cause line names the question, never a running worker', () => {
    const view = deriveMissionStateView(local);
    const chain = buildStateBecause(view, { missionId: 'm', workspaceId: 'ws' }, {
      openTasks: [{ id: 't1', title: 'Import the fixtures', status: 'assigned', live: true, waiting: true }],
    });
    const text = chain.map(l => l.claim).join('\n');
    expect(chain[0].claim).toBe(`"Import the fixtures" needs input: ${PROMPT}`);
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
});
