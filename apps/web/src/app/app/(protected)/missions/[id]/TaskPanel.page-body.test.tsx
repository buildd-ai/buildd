/**
 * Convergence step 4: the sheet renders the rest of the task page's body with
 * the page's own components, from props `/api/tasks/[id]/summary` builds with
 * the page's helpers: the delivery's header reading, the checks list, the
 * live run view and steer panel, Deliverables and Access. Illustrative
 * fixtures only.
 */
import { describe, expect, it, mock } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => '/app/missions/m1',
  useSearchParams: () => new URLSearchParams(),
}));
mock.module('@/lib/pusher-client', () => ({
  subscribeToChannel: () => null,
  unsubscribeFromChannel: () => {},
  getSubscribedChannel: () => null,
  getPusherClient: () => null,
  CHANNEL_PREFIX: 'buildd-',
}));

const { default: TaskPanelBody } = await import('./TaskPanel');
type TaskPanelData = import('./TaskPanel').TaskPanelData;
const { liveWorkerViewProps, workerSteerProps } = await import('@/lib/task-live-view');
const { taskDeliverySections } = await import('@/lib/task-sections');

const ID = '66666666-6666-4666-8666-666666666666';
const T = '2026-01-01T12:00:00Z';
const row = {
  id: 'w1', name: 'builder', branch: 'buildd/abc-task', status: 'running', currentAction: 'Editing the schema', milestones: [],
  turns: 3, costUsd: '0.2', inputTokens: 10, outputTokens: 20, createdAt: T, startedAt: T, updatedAt: T,
  prUrl: null, prNumber: null, commitCount: 0, filesChanged: 0, linesAdded: 0, linesRemoved: 0, lastCommitSha: null,
  waitingFor: null as unknown, instructionHistory: [], pendingInstructions: null,
};
const sheetWorker = (status: string, waitingFor: unknown = null): NonNullable<TaskPanelData['worker']> => ({
  id: 'w1', status, currentAction: null, turns: 3, prUrl: null, prNumber: null, prLifecycleStatus: null, mergedAt: null,
  commitCount: 0, filesChanged: 0, linesAdded: 0, linesRemoved: 0, costUsd: '0.2', inputTokens: 10, outputTokens: 20,
  startedAt: T, completedAt: null, waitingFor: waitingFor as never, branch: 'buildd/abc-task', runner: null, milestones: [], account: null,
});
function data(over: Partial<TaskPanelData> = {}): TaskPanelData {
  return {
    id: ID, title: 'Add a column', status: 'in_progress', description: null, mode: null, roleSlug: 'builder',
    createdAt: T, missionId: 'm1', backend: null, failover: null, worker: sheetWorker('running'),
    result: null, lastError: null, blockedByCount: 0, pr: null, merged: false,
    ...over,
  };
}
const render = (d: TaskPanelData) => renderToStaticMarkup(<TaskPanelBody data={d} onChanged={() => {}} />);
const view = {
  state: 'AWAITING_REVIEW', stateReason: null, prNumber: 9, headSha: 'HEADB000', prState: 'awaiting_ci',
  rounds: [{ id: 'r1', round: 1, headSha: 'HEADB000', kind: 'full', status: 'queued', verdict: null, effectiveVerdict: null, failureCount: 0, reviewerTaskId: 'rev1' }],
  ledger: [], approvedCurrentHead: false, approvalBasis: null,
  headline: 'Waiting for review', owner: 'reviewer', needsYou: false, stage: 'review', detail: null, repoFullName: 'org/repo',
} as never;
const sections = taskDeliverySections({ view, findings: new Map(), findingsUnavailable: false }, null);
const live = (waitingFor: unknown = null) => liveWorkerViewProps({
  task: { id: ID, status: 'in_progress', outputRequirement: 'pr_required' },
  worker: { ...row, status: waitingFor ? 'waiting_input' : 'running', waitingFor } as never,
  delivery: null, deliverableArtifactCount: 0, usesReviewer: false,
});

describe("the sheet renders the page's body", () => {
  it("reads the header pill from the delivery, as the page's does", () => {
    const html = render(data({ delivery: sections.delivery }));
    expect(html).toMatch(/data-testid="task-header-status"[^]*data-owner="reviewer"/);
  });

  it("lists the delivery's checks with the page's checks list", () => {
    expect(render(data({ checks: sections.checks }))).toContain('data-testid="task-checks"');
    expect(render(data())).not.toContain('data-testid="task-checks"');
  });

  it("shows a live worker in the page's live run view, with its steer panel", () => {
    const html = render(data({ live: live(), steer: workerSteerProps({ ...row, createdAt: T } as never, [], false) }));
    expect(html).toContain('data-testid="worker-view"');
    expect(html).toContain('Editing the schema');
  });

  it("asks a waiting worker's question once, in the live view, as the page does", () => {
    const waitingFor = { type: 'question', prompt: 'Which database should the import write to?' };
    const html = render(data({ status: 'waiting_input', worker: sheetWorker('waiting_input', waitingFor), live: live(waitingFor) }));
    expect(html).toContain('data-testid="worker-needs-input-banner"');
    expect(html).not.toContain('data-testid="task-sheet-question"');
    expect(html.split('Which database should the import write to?').length - 1).toBe(1);
  });

  it('renders Deliverables with the shared block', () => {
    const html = render(data({ status: 'completed', worker: sheetWorker('completed'), deliverables: { summary: 'Shipped the column.', branch: 'buildd/x', commits: 2 } }));
    expect(html).toContain('data-testid="task-deliverables"');
    expect(html).toContain('2 commits');
    expect(html).toContain('Shipped the column.');
  });

  it('lists what the runs were given and refused', () => {
    const html = render(data({ access: [{ at: T, lastAt: T, count: 1, capability: 'github.repo_grant', label: 'Repo access', decision: 'allowed', reason: null, target: null, expiresAt: null }] }));
    expect(html).toContain('data-testid="task-access"');
  });
});

describe('one component tree', () => {
  const page = readFileSync(join(import.meta.dir, '../../tasks/[id]/page.tsx'), 'utf8');
  const panel = readFileSync(join(import.meta.dir, 'TaskPanel.tsx'), 'utf8');

  it('page and sheet render the same sections from the same helpers', () => {
    for (const src of [page, panel]) {
      for (const needle of ['<TaskChecksSection', '<RealTimeWorkerView', '<WorkerSteerPanel', '<TaskDeliverables', '<TaskAccessSection']) {
        expect(src).toContain(needle);
      }
    }
    for (const needle of ['taskDeliverySections(', 'liveWorkerViewProps(', 'workerSteerProps(']) expect(page).toContain(needle);
  });

  it('the sheet has no live view of its own', () => {
    expect(panel).not.toContain('LiveWorkerActivity');
    expect(existsSync(join(import.meta.dir, 'LiveWorkerActivity.tsx'))).toBe(false);
  });
});
