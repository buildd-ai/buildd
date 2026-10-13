/**
 * The sheet renders the task page's own sections (convergence step 3): its
 * header pill, its stored PR card, its fact rows and its summary card, from
 * the facts `/api/tasks/[id]/summary` decides with the page's helpers
 * (lib/task-sections.ts). Illustrative fixtures only.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import TaskPanelBody, { type TaskPanelData } from './TaskPanel';

const ID = '55555555-5555-4555-8555-555555555555';
const worker: NonNullable<TaskPanelData['worker']> = {
  id: 'w1', status: 'completed', currentAction: null, turns: 3,
  prUrl: 'https://github.com/org/repo/pull/9', prNumber: 9, prLifecycleStatus: 'ci_green', mergedAt: null,
  commitCount: 2, filesChanged: 2, linesAdded: 4, linesRemoved: 1, costUsd: '0.5', inputTokens: 10, outputTokens: 20,
  startedAt: null, completedAt: null, waitingFor: null, branch: 'buildd/abc-task', runner: 'quill-studio',
  milestones: [], account: null,
};
function data(over: Partial<TaskPanelData> = {}): TaskPanelData {
  return {
    id: ID, title: 'Add a column', status: 'completed', description: null, mode: null, roleSlug: null,
    createdAt: new Date().toISOString(), missionId: 'm1', backend: null, failover: null, worker,
    result: { summary: 'Shipped the column.', nextSuggestion: null }, lastError: null, blockedByCount: 0,
    pr: { prUrl: worker.prUrl!, prNumber: 9, prLifecycleStatus: 'ci_green', prState: 'ci_passed', linesAdded: 4, linesRemoved: 1, filesChanged: 2 },
    merged: false,
    ...over,
  };
}
const render = (d: TaskPanelData) => renderToStaticMarkup(<TaskPanelBody data={d} onChanged={() => {}} />);

describe('the sheet renders the task page sections', () => {
  it("heads with the page's status pill, reading Merged once the PR merged", () => {
    expect(render(data())).toContain('Completed');
    const merged = render(data({ merged: true }));
    expect(merged).toMatch(/data-testid="task-header-status"[^]*Merged/);
  });

  it('cards the PR the summary decided on, and none when it decided none', () => {
    expect(render(data())).toContain('#9');
    expect(render(data({ pr: null }))).not.toContain('pull/9');
  });

  it("lists the runner and branch in the page's fact sheet", () => {
    const html = render(data());
    expect(html).toContain('data-testid="task-fact-runner"');
    expect(html).toContain('quill-studio');
    expect(html).toContain('data-testid="task-fact-branch"');
    expect(html).toContain('buildd/abc-task');
  });

  it("marks a summary taken from the worker's last message, as the page does", () => {
    const html = render(data({ result: { summary: 'Last words.', nextSuggestion: null, fallback: true } }));
    expect(html).toContain('data-testid="task-summary-fallback"');
    expect(render(data())).not.toContain('task-summary-fallback');
  });
});

describe('one component per section', () => {
  const page = readFileSync(join(import.meta.dir, '../../tasks/[id]/page.tsx'), 'utf8');
  const panel = readFileSync(join(import.meta.dir, 'TaskPanel.tsx'), 'utf8');

  it('both decide the PR, the merged header and the fallback summary with lib/task-sections', () => {
    for (const src of [page]) {
      expect(src).toContain('taskPrFacts(');
      expect(src).toContain('taskHeaderMerged(');
      expect(src).toContain('isFallbackSummary(');
    }
  });

  it('both render the same header pill, PR card, fact rows and summary', () => {
    for (const src of [page, panel]) {
      expect(src).toContain('<HeaderStatusPill');
      expect(src).toContain('<StoredPrCard');
      expect(src).toContain('runnerFactRow(');
      expect(src).toContain('branchFactRow(');
      expect(src).toContain('<TaskSummary');
    }
    expect(panel).not.toContain('WorkerStats');
    expect(panel).not.toContain('<PrCard');
  });
});
