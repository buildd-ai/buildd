/**
 * Living Spec 1b257609 revision 2, AC-9 (first half): given one projection,
 * the card on Home, the mission page's card, get_task and explain all list
 * the same waiting work. The other half (no surface computes its own list) is
 * scripts/question-waits-single-source.test.ts.
 */
import { describe, expect, it, mock } from 'bun:test';
import { optionOutcomes, partsText, waitsSummary, type QuestionWaits } from '@buildd/core/question-waits';
import { handleBuilddAction, type ApiFn } from '@buildd/core/mcp-tools';
import { questionDecisionView } from '@/app/app/(protected)/home/NeedsYouCards';
import { missionDecisions } from './mission-decisions';
import { buildMissionBoard } from './mission-board';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T0 = Date.UTC(2026, 9, 24, 12, 0, 0);

const base: QuestionWaits = {
  taskId: id(1), mission: null, hiddenCount: 1, beyondCount: 0, lanes: [{ lane: 'schema', queued: [{ id: id(9), title: 'Add index', position: 2 }], hiddenCount: 0 }], criteria: null,
  waiting: [
    { id: id(2), title: 'Autostart repair', depth: 1, missionId: null, missionTitle: null, workspaceName: null, after: null, alsoWaitsOnOther: false },
    { id: id(3), title: 'Real-machine check', depth: 2, missionId: null, missionTitle: null, workspaceName: null, after: { id: id(2), title: 'Autostart repair' }, alsoWaitsOnOther: false },
  ],
  askedAt: null, expiresAt: null, onExpiry: { action: 'restart', option: null }, options: [],
};
const projection: QuestionWaits = { ...base, options: optionOutcomes([{ label: 'Accept', outcome: 'finishes', recommended: true }, { label: 'Keep testing', outcome: 'continues' }], base) };
const expected = partsText(waitsSummary(projection));

const question = {
  headline: 'Accept the acceptance results?', body: null, noteId: null, context: 'Two checks failed on the real machine',
  options: [{ label: 'Accept', description: 'Ships as is', recommended: true }, { label: 'Keep testing', description: 'More runs first', recommended: false }],
};

describe('one projection, the same waiting work everywhere (AC-9)', () => {
  it('reads the same on Home, the mission page, get_task and explain', async () => {
    const home = questionDecisionView({ workerId: 'w1', taskId: id(1), href: `/app/tasks/${id(1)}`, label: 'Acceptance tests', runnerName: null, askedAt: null, question }, projection);

    const model = buildMissionBoard({
      tasks: [{
        id: id(1), title: 'Acceptance tests', status: 'in_progress', taskClass: 'work', createdAt: new Date(T0), missionPhaseIndex: 1, missionPhaseLabel: 'Build',
        roleSlug: 'tester', outputRequirement: 'pr_required',
        workers: [{ id: 'w1', status: 'waiting_input', runner: 'atlas', startedAt: T0, completedAt: null, updatedAt: T0, mergedAt: null, prNumber: null, prUrl: null, prLifecycleStatus: null, currentAction: null, milestones: [], linesAdded: null, linesRemoved: null,
          waitingFor: { prompt: question.headline, options: ['Accept', 'Keep testing'], full: { type: 'question', prompt: question.headline, options: [{ label: 'Accept', recommended: true }, { label: 'Keep testing' }] } } }],
        worker: { status: 'waiting_input', startedAt: new Date(T0), updatedAt: new Date(T0), prNumber: null, prUrl: null, prLifecycleStatus: null, mergedAt: null },
      }],
      now: T0 + 60_000, missionCreatedAt: T0, missionStatus: 'active',
    });
    const [mission] = missionDecisions({ model, notes: [], mission: { id: 'm', title: 'M', href: '/app/missions/m' }, hrefFor: t => `/app/tasks/${t}`, waitsByTask: new Map([[id(1), projection]]) });

    const api = mock(async () => ({ id: id(1), title: 'Acceptance tests', status: 'in_progress', priority: 0, workspace: { name: 'w' }, workers: [], artifacts: [], questionWaits: projection }));
    const getTask = ((await handleBuilddAction(api as unknown as ApiFn, 'get_task', { taskId: id(1) }, { workspaceId: 'ws', getWorkspaceId: async () => 'ws', getLevel: async () => 'worker' })) as any).content[0].text as string;

    expect(expected).toBe("Blocks Autostart repair, then Real-machine check and 1 task you can't see. Holds the schema lane: 1 queued.");
    expect(partsText(waitsSummary(home.waits!))).toBe(expected);
    expect(partsText(waitsSummary(mission.waits!))).toBe(expected);
    expect(getTask).toContain(`- ${expected}`);
    // explain returns the projection itself (lib/explain.ts); the same object, so the same list.
    expect(home.options.map(o => o.downstream)).toEqual(mission.options.map(o => o.downstream));
    expect(home.options[0].downstream).toBe("Finishes the task: Autostart repair and 1 task you can't see start; frees the schema lane");
  });
});
