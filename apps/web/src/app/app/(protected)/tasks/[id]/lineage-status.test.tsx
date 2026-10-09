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

  // C-2: workers inserted in the same instant (reclaim, retry dispatch) came back
  // in whatever order the database returned them, so rows swapped between renders.
  it('returns one order for equal timestamps across 100 shuffled inputs', () => {
    const tie = new Date('2026-09-26T10:30:00Z');
    const own = [{ id: 'own-b', createdAt: tie }, { id: 'own-a', createdAt: tie }];
    const attempts = [{ workers: [{ id: 'retry-z', createdAt: tie }, { id: 'retry-y', createdAt: tie }] }];
    const key = (rows: ReturnType<typeof lineageWorkerHistory>) => rows.map(r => `${r.worker.id}|${r.attemptLabel}`);
    const expected = key(lineageWorkerHistory(own, attempts));
    expect(expected).toEqual([
      'retry-z|attempt 2 · CI fix',
      'retry-y|attempt 2 · CI fix',
      'own-b|attempt 1',
      'own-a|attempt 1',
    ]);
    let seed = 7;
    const shuffle = <T,>(xs: readonly T[]) => {
      const out = xs.slice();
      for (let i = out.length - 1; i > 0; i--) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const j = seed % (i + 1);
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    };
    for (let i = 0; i < 100; i++) {
      expect(key(lineageWorkerHistory(shuffle(own), [{ workers: shuffle(attempts[0].workers) }]))).toEqual(expected);
    }
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

  it('success green (text-status-success) is only for landed states (MERGED, SUPERSEDED), not for APPROVED', () => {
    // APPROVED should use live tone, not success
    const approvedHtml = renderToStaticMarkup(<HeaderStatusPill status="completed" merged={false} delivery={d({ headline: 'APPROVED', owner: 'landing', stage: 'approved', state: 'APPROVED' })} />);
    expect(approvedHtml).not.toContain('text-status-success');
    expect(approvedHtml).toContain('bg-accent-soft');

    // MERGED should be success green
    const mergedHtml = renderToStaticMarkup(<HeaderStatusPill status="completed" merged={false} delivery={d({ headline: 'MERGED', owner: 'landing', stage: 'merged', state: 'MERGED' })} />);
    expect(mergedHtml).toContain('text-status-success');
    expect(mergedHtml).toContain('bg-status-success/10');

    // SUPERSEDED should also be success green (landed tone)
    const supersededHtml = renderToStaticMarkup(<HeaderStatusPill status="completed" merged={false} delivery={d({ headline: 'Shipped elsewhere', owner: 'platform', stage: 'superseded', state: 'SUPERSEDED' })} />);
    expect(supersededHtml).toContain('text-status-success');
    expect(supersededHtml).toContain('bg-status-success/10');
  });

  it('covers all delivery states with correct tone and label mapping', () => {
    const states: Array<{ stage: string; state: string; owner: string; headline: string; expectedLabel: string; shouldBeSuccess: boolean; shouldBeLive: boolean; shouldBeStalled: boolean; shouldBeClosed: boolean; shouldBeFailed: boolean }> = [
      { stage: 'awaiting_push', state: 'AWAITING_PUSH', owner: 'worker', headline: 'Waiting for push', expectedLabel: 'Waiting for push', shouldBeSuccess: false, shouldBeLive: true, shouldBeStalled: false, shouldBeClosed: false, shouldBeFailed: false },
      { stage: 'review', state: 'AWAITING_REVIEW', owner: 'reviewer', headline: 'In review', expectedLabel: 'In review', shouldBeSuccess: false, shouldBeLive: true, shouldBeStalled: false, shouldBeClosed: false, shouldBeFailed: false },
      { stage: 'fixing', state: 'FIXING', owner: 'worker', headline: 'Fixing', expectedLabel: 'Fixing', shouldBeSuccess: false, shouldBeLive: true, shouldBeStalled: false, shouldBeClosed: false, shouldBeFailed: false },
      { stage: 'repairing', state: 'REPAIRING', owner: 'platform', headline: 'Fixing CI', expectedLabel: 'Fixing CI', shouldBeSuccess: false, shouldBeLive: true, shouldBeStalled: false, shouldBeClosed: false, shouldBeFailed: false },
      { stage: 'approved', state: 'APPROVED', owner: 'landing', headline: 'APPROVED', expectedLabel: 'Approved · merging', shouldBeSuccess: false, shouldBeLive: true, shouldBeStalled: false, shouldBeClosed: false, shouldBeFailed: false },
      { stage: 'approved', state: 'APPROVED', owner: 'human', headline: 'APPROVED', expectedLabel: 'Ready to merge', shouldBeSuccess: false, shouldBeLive: false, shouldBeStalled: false, shouldBeClosed: false, shouldBeFailed: false },
      { stage: 'landing', state: 'LANDING', owner: 'platform', headline: 'Merging', expectedLabel: 'Merging', shouldBeSuccess: false, shouldBeLive: true, shouldBeStalled: false, shouldBeClosed: false, shouldBeFailed: false },
      { stage: 'merged', state: 'MERGED', owner: 'landing', headline: 'MERGED', expectedLabel: 'Merged', shouldBeSuccess: true, shouldBeLive: false, shouldBeStalled: false, shouldBeClosed: false, shouldBeFailed: false },
      { stage: 'superseded', state: 'SUPERSEDED', owner: 'platform', headline: 'Shipped elsewhere', expectedLabel: 'Shipped elsewhere', shouldBeSuccess: true, shouldBeLive: false, shouldBeStalled: false, shouldBeClosed: false, shouldBeFailed: false },
      { stage: 'closed', state: 'CLOSED_UNMERGED', owner: 'worker', headline: 'Closed', expectedLabel: 'Closed', shouldBeSuccess: false, shouldBeLive: false, shouldBeStalled: false, shouldBeClosed: true, shouldBeFailed: false },
      { stage: 'failed', state: 'FAILED', owner: 'platform', headline: 'Failed', expectedLabel: 'Failed', shouldBeSuccess: false, shouldBeLive: false, shouldBeStalled: false, shouldBeClosed: false, shouldBeFailed: true },
      { stage: 'blocked', state: 'BLOCKED_ON_TRUNK', owner: 'platform', headline: 'Blocked on base', expectedLabel: 'Blocked on base', shouldBeSuccess: false, shouldBeLive: false, shouldBeStalled: true, shouldBeClosed: false, shouldBeFailed: false },
    ];

    for (const state of states) {
      const html = renderToStaticMarkup(<HeaderStatusPill status="running" merged={false} delivery={d({ headline: state.headline, owner: state.owner as never, stage: state.stage as never, state: state.state })} />);
      expect(html).toContain(state.expectedLabel, `${state.state}: should contain label "${state.expectedLabel}"`);

      if (state.shouldBeSuccess) {
        expect(html).toContain('text-status-success', `${state.state}: should be success green`);
      } else {
        expect(html).not.toContain('text-status-success', `${state.state}: should NOT be success green`);
      }

      if (state.shouldBeLive) {
        expect(html).toContain('bg-accent-soft', `${state.state}: should be live tone`);
      }

      if (state.shouldBeStalled) {
        expect(html).toContain('bg-accent-soft', `${state.state}: should be stalled tone`);
      }

      if (state.shouldBeClosed) {
        expect(html).toContain('text-status-error', `${state.state}: should be closed tone`);
      }

      if (state.shouldBeFailed) {
        expect(html).toContain('text-status-error', `${state.state}: should be failed tone`);
      }
    }
  });
});
