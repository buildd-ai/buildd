/**
 * The mission page's decisions and the raised History line (Navigation
 * d25d923d R-6, R-16, AC-8, AC-10), over illustrative rows through the real
 * `buildMissionBoard`.
 */
import { describe, expect, it } from 'bun:test';
import { buildMissionBoard, type BoardTaskInput, type BoardWorkerInput } from './mission-board';
import { historyRaised, missionDecisions, type OpenQuestionNote } from './mission-decisions';
import type { QuestionWaits } from '@buildd/core/question-waits';

const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
const min = (n: number) => T0 + n * 60_000;
const NOW = min(120);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function worker(over: Partial<BoardWorkerInput> = {}): BoardWorkerInput {
  return {
    id: `w-${Math.random().toString(36).slice(2, 8)}`, status: 'completed', runner: 'atlas', startedAt: min(1), completedAt: min(8), updatedAt: min(8),
    mergedAt: null, prNumber: null, prUrl: null, prLifecycleStatus: null, currentAction: null, waitingFor: null, milestones: [], linesAdded: null, linesRemoved: null,
    ...over,
  };
}

function task(n: number, title: string, over: Partial<BoardTaskInput> = {}): BoardTaskInput {
  const workers = over.workers ?? [];
  const w = workers[0];
  return {
    id: id(n), title, status: 'pending', taskClass: 'work', createdAt: new Date(T0 + n * 1000), missionPhaseIndex: 1, missionPhaseLabel: 'Build',
    roleSlug: 'builder', outputRequirement: 'pr_required', workers,
    worker: w ? { status: w.status, startedAt: w.startedAt ? new Date(w.startedAt) : null, updatedAt: w.updatedAt ? new Date(w.updatedAt) : null, prNumber: w.prNumber, prUrl: w.prUrl, prLifecycleStatus: w.prLifecycleStatus, mergedAt: w.mergedAt ? new Date(w.mergedAt) : null } : null,
    ...over,
  };
}

const board = (tasks: BoardTaskInput[]) => buildMissionBoard({ tasks, now: NOW, missionCreatedAt: T0, missionStatus: 'active' });
const hrefFor = (taskId: string) => `/app/tasks/${taskId}`;
const mission = { id: 'm1', title: 'One-click cloud runner deploy', href: '/app/missions/m1' };

const asking = task(1, 'Mirror the runner image to Docker Hub', {
  status: 'in_progress',
  workers: [worker({
    id: 'w-ask', status: 'waiting_input', startedAt: min(100), completedAt: null, updatedAt: min(116),
    waitingFor: {
      prompt: 'How should Docker Hub credentials be set up?',
      options: ['Provide a token', "I'll set them myself"],
      full: {
        type: 'question', prompt: 'How should Docker Hub credentials be set up?',
        context: 'CI has no Docker Hub secrets, so every release skips the image mirror',
        options: [
          { label: 'Provide a token', consequence: 'Stored as a team secret, revocable', recommended: true },
          { label: "I'll set them myself", consequence: 'Resumes when CI sees them' },
        ],
      },
    },
  })],
});
const digest = task(2, 'The release publishes an image digest', { dependsOn: [id(1)] });
const bundle = task(3, 'A runner bundle on every release', { dependsOn: [id(1)] });

/** The projection's answer for the asking task (lib/question-waits.ts); the page passes it in by task. */
const projected: QuestionWaits = {
  taskId: id(1), mission: null, hiddenCount: 0, beyondCount: 0, lanes: [], criteria: null,
  waiting: [
    { id: id(2), title: 'The release publishes an image digest', depth: 1, missionId: null, missionTitle: null, workspaceName: null, after: null, alsoWaitsOnOther: false },
    { id: id(3), title: 'A runner bundle on every release', depth: 1, missionId: null, missionTitle: null, workspaceName: null, after: null, alsoWaitsOnOther: false },
  ],
  askedAt: null, expiresAt: null, onExpiry: { action: 'restart', option: null }, options: [],
};

describe('missionDecisions (R-16, AC-10)', () => {
  const model = board([asking, digest, bundle]);
  const views = missionDecisions({ model, notes: [], mission, hrefFor, waitsByTask: new Map([[id(1), projected]]) });

  it('a parked worker’s question is one card: its task, the brief, both options, and what waits on it from the projection', () => {
    expect(views).toHaveLength(1);
    const v = views[0];
    expect(v.kind).toBe('decision');
    expect(v.task).toEqual({ id: id(1), title: 'Mirror the runner image to Docker Hub', href: `/app/tasks/${id(1)}` });
    expect(v.question).toBe('How should Docker Hub credentials be set up?');
    expect(v.summary).toBe('CI has no Docker Hub secrets, so every release skips the image mirror.');
    expect(v.waits).toBe(projected);
    expect(v.options.map(o => `${o.label}: ${o.effect}`)).toEqual(['Provide a token: Stored as a team secret, revocable', "I'll set them myself: Resumes when CI sees them"]);
    expect(v.answer).toEqual({ kind: 'worker', workerId: 'w-ask', taskId: id(1), noteId: null });
    expect(v.askedAt).toBe(min(116));
  });

  it('the note recording the same ask is folded into the worker card, not shown twice', () => {
    const note: OpenQuestionNote = { id: 'n1', workerId: 'w-ask', type: 'question', status: 'open', title: 'Docker Hub credentials for the runner image', body: null, defaultChoice: 'Provide a token', createdAt: min(116) };
    const withNote = missionDecisions({ model, notes: [note], mission, hrefFor });
    expect(withNote).toHaveLength(1);
    expect(withNote[0].question).toBe('Docker Hub credentials for the runner image');
    expect(withNote[0].answer).toMatchObject({ kind: 'worker', noteId: 'n1' });
  });

  it('an organizer question names its subject task when it has one, else the mission', () => {
    const notes: OpenQuestionNote[] = [
      { id: 'n2', type: 'question', status: 'open', title: 'Keep the legacy export?', body: 'Keep: the old CSV stays. Drop: it goes in this release.', defaultChoice: 'Keep', taskId: 'organizer-task', subjectTaskId: id(2), createdAt: min(90) },
      { id: 'n3', type: 'question', status: 'open', title: 'Which region first?', body: null, defaultChoice: null, taskId: 'organizer-task', createdAt: min(95) },
    ];
    const views = missionDecisions({ model, notes, mission, hrefFor });
    expect(views.map(v => v.key)).toEqual([`question:${id(1)}`, 'note:n2', 'note:n3']);
    const [, subject, fallback] = views;
    expect(subject.task?.title).toBe('The release publishes an image digest');
    expect(subject.options.map(o => `${o.label}: ${o.effect}`)).toEqual(['Keep: The old CSV stays.']);
    expect(subject.answer).toEqual({ kind: 'note', missionId: 'm1', noteId: 'n2' });
    expect(fallback.task).toBeNull();
    expect(fallback.mission).toEqual(mission);
  });

  it('the criteria escalation note is not a card here (its exits are the completion sheet)', () => {
    const notes: OpenQuestionNote[] = [{ id: 'n4', type: 'question', status: 'open', title: 'Goal criteria blocked — owner decision needed', body: null, createdAt: min(1) }];
    expect(missionDecisions({ model: board([digest]), notes, mission, hrefFor })).toEqual([]);
  });

  it('never derives its own list: without the projection a card names no waiting work (spec 1b257609 R-5)', () => {
    const bare = missionDecisions({ model, notes: [], mission, hrefFor });
    expect(bare[0].waits).toBeNull();
    expect(bare[0].summary).toBe('CI has no Docker Hub secrets, so every release skips the image mirror.');
  });
});

describe('historyRaised (R-6, AC-8)', () => {
  it('an open organizer decision raises History and names it', () => {
    const model = board([digest]);
    const r = historyRaised(model, [{ id: 'n1', type: 'question', status: 'open', title: 'Keep the legacy export?', subjectTaskId: id(2) }]);
    expect(r).toEqual({ kind: 'decision', text: 'Decision open: Keep the legacy export?', taskId: id(2), noteId: 'n1' });
  });

  it('a failure a person must fix raises it; a dependency failure does not', () => {
    const failed = task(5, 'Mirror the runner image', { status: 'failed', workers: [worker({ status: 'failed', completedAt: min(5), updatedAt: min(5) })] });
    expect(historyRaised(board([failed]), [])).toEqual({ kind: 'failed', text: 'Failed: Mirror the runner image', taskId: id(5), noteId: null });
  });

  it('a reopened task raises it; a quiet mission raises nothing', () => {
    const reopened = task(6, 'feat: reopened', {
      status: 'in_progress',
      workers: [
        worker({ status: 'running', startedAt: min(110), completedAt: null, updatedAt: min(119) }),
        worker({ startedAt: min(1), completedAt: min(3), updatedAt: min(3), mergedAt: min(3), prNumber: 401, prLifecycleStatus: 'merged' }),
      ],
    });
    expect(historyRaised(board([reopened]), [])).toEqual({ kind: 'reopened', text: 'Reopened: feat: reopened', taskId: id(6), noteId: null });
    expect(historyRaised(board([digest]), [{ type: 'question', status: 'answered', title: 'Old' }])).toBeNull();
  });
});
