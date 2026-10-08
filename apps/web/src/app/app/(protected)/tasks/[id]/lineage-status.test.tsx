import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { lineageDisplayStatus, lineageWorkerHistory } from './lineage-status';
import { HeaderStatusPill } from './TaskSidePanel';

// Regression (demo reshoot, CI-retry step): the parent task finished its first
// attempt and opened the PR, CI went red, a CI-fix attempt was running on the
// same branch, and the header still read COMPLETED. The task's own row is
// terminal, but its work is not done while a CI-retry child is live.
describe('lineageDisplayStatus', () => {
  const base = { displayStatus: 'completed', taskStatus: 'completed', prMerged: false, prClosed: false };

  it('reads as fixing CI while a CI-retry attempt is in progress', () => {
    expect(lineageDisplayStatus({ ...base, attemptStatuses: ['in_progress'] })).toBe('fixing_ci');
  });

  it('reads as fixing CI while the retry is queued or claimed', () => {
    expect(lineageDisplayStatus({ ...base, attemptStatuses: ['pending'] })).toBe('fixing_ci');
    expect(lineageDisplayStatus({ ...base, attemptStatuses: ['assigned'] })).toBe('fixing_ci');
  });

  it('stays completed once every attempt has finished', () => {
    expect(lineageDisplayStatus({ ...base, attemptStatuses: ['completed', 'failed'] })).toBe('completed');
    expect(lineageDisplayStatus({ ...base, attemptStatuses: [] })).toBe('completed');
  });

  it('a merged or closed PR wins over a straggling attempt', () => {
    expect(lineageDisplayStatus({ ...base, prMerged: true, attemptStatuses: ['in_progress'] })).toBe('completed');
    expect(lineageDisplayStatus({ ...base, prClosed: true, attemptStatuses: ['in_progress'] })).toBe('completed');
  });

  it('never overrides a task that is not completed', () => {
    expect(lineageDisplayStatus({ ...base, displayStatus: 'running', taskStatus: 'in_progress', attemptStatuses: ['in_progress'] })).toBe('running');
    expect(lineageDisplayStatus({ ...base, displayStatus: 'failed', taskStatus: 'failed', attemptStatuses: ['in_progress'] })).toBe('failed');
  });
});

describe('HeaderStatusPill', () => {
  it('draws fixing_ci as live work, not as a finished task', () => {
    const html = renderToStaticMarkup(<HeaderStatusPill status="fixing_ci" merged={false} />);
    expect(html).toContain('Fixing CI');
    expect(html).not.toContain('Completed');
    expect(html).toContain('animate-status-pulse');
  });
});

// Source-level wiring: the page is a server component on the DB client, so the
// helpers above are what is unit-tested and these pin that the page uses them.
const src = await Bun.file(new URL('./page.tsx', import.meta.url)).text();
describe('tasks/[id]/page.tsx lineage wiring', () => {
  it('derives the header status from the lineage', () => {
    expect(src).toContain('lineageDisplayStatus({');
    expect(src).toContain('attemptStatuses: ciAttemptTasks.map(t => t.status)');
  });

  it('builds Worker history across the lineage and names rows by runner', () => {
    expect(src).toContain('lineageWorkerHistory(taskWorkers, ciAttemptTasks)');
    expect(src).toContain('{runnerLabel(worker) ?? worker.name}');
  });

  it('drops "Unblocked by this" tasks from "Also running"', () => {
    expect(src).toContain('excludeTaskIds: new Set(dependentTasks.map(d => d.id))');
  });
});

// Regression: Worker history listed only the task's own worker, so a PR that
// took two attempts (the retry ran on another runner) showed one row.
describe('lineageWorkerHistory', () => {
  const w = (id: string, minute: number) => ({ id, createdAt: new Date(`2026-09-26T10:${String(minute).padStart(2, '0')}:00Z`) });

  it("lists the CI-retry attempts' workers with the task's own, newest first", () => {
    const rows = lineageWorkerHistory([w('first', 0)], [{ workers: [w('retry', 20)] }]);
    expect(rows.map(r => r.worker.id)).toEqual(['retry', 'first']);
  });

  it('numbers each row by attempt once there is more than one', () => {
    const rows = lineageWorkerHistory([w('first', 0)], [{ workers: [w('retry1', 20)] }, { workers: [w('retry2', 40)] }]);
    expect(rows.map(r => [r.worker.id, r.attemptLabel])).toEqual([
      ['retry2', 'attempt 3 · CI fix'],
      ['retry1', 'attempt 2 · CI fix'],
      ['first', 'attempt 1'],
    ]);
  });

  it('adds no attempt label to a task with no retries', () => {
    const rows = lineageWorkerHistory([w('b', 5), w('a', 0)], []);
    expect(rows.map(r => r.attemptLabel)).toEqual([null, null]);
  });

  it('skips retry tasks that never got a worker, and dedupes by id', () => {
    const rows = lineageWorkerHistory([w('first', 0)], [{ workers: [] }, { workers: [w('first', 0)] }]);
    expect(rows.map(r => r.worker.id)).toEqual(['first']);
  });
});

describe('HeaderStatusPill — kernel DeliveryView', () => {
  const d = (o: Partial<{ headline: string; owner: string; needsYou: boolean; stage: string; detail: string | null; state: string | null }>) => ({ headline: 'Review queued', owner: 'reviewer', needsYou: false, stage: 'review', detail: null, state: 'WORKING', ...o });
  it('reads the kernel headline instead of the raw task status', () => {
    const html = renderToStaticMarkup(<HeaderStatusPill status="waiting_on_you" merged={false} delivery={d({ headline: 'Waiting for the fix to reach GitHub', owner: 'platform', stage: 'awaiting_push' })} />);
    expect(html).toContain('Waiting for the fix to reach GitHub');
    expect(html).not.toContain('Needs input');
    expect(html).not.toContain('bg-accent ');
  });
  it('is loud only for a human-owned state', () => {
    const html = renderToStaticMarkup(<HeaderStatusPill status="running" merged={false} delivery={d({ headline: 'The reviewer escalated this PR', owner: 'human', needsYou: true, stage: 'needs_you' })} />);
    expect(html).toContain('bg-accent');
    expect(html).toContain('data-owner="human"');
  });
  it('maps approved PRs owned by platform to live tone with label from deliveryReading', () => {
    const html = renderToStaticMarkup(<HeaderStatusPill status="completed" merged={false} delivery={d({ headline: 'APPROVED', owner: 'landing', stage: 'approved' })} />);
    expect(html).toContain('Approved · merging');
    expect(html).toContain('text-accent-text');
    expect(html).toContain('bg-accent-soft');
    expect(html).not.toContain('text-status-success');
  });
  it('shows approved PRs owned by human as needs tone with Ready to merge label', () => {
    const html = renderToStaticMarkup(<HeaderStatusPill status="completed" merged={false} delivery={d({ headline: 'APPROVED', owner: 'human', stage: 'approved' })} />);
    expect(html).toContain('Ready to merge');
    expect(html).toContain('text-[var(--on-accent)]');
    expect(html).toContain('bg-accent');
  });
  it('shows merged PRs in success tone', () => {
    const html = renderToStaticMarkup(<HeaderStatusPill status="completed" merged={false} delivery={d({ headline: 'MERGED', owner: 'landing', stage: 'merged' })} />);
    expect(html).toContain('Merged');
    expect(html).toContain('text-status-success');
  });
  it('wraps long headlines without truncation on normal widths', () => {
    const html = renderToStaticMarkup(<HeaderStatusPill status="running" merged={false} delivery={d({ headline: 'Waiting for the fix to reach GitHub and for all CI checks to pass' })} />);
    expect(html).not.toContain('whitespace-nowrap');
  });
});
