/**
 * The selected task's status line, mounted (happy-dom): a live task's ticking
 * clock and activity, a red PR's backoff with `Retry now`, and a closed PR's
 * `Closed → #N` or `Link replacement`.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/mission-1' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let refreshed = 0;
mock.module('next/navigation', () => ({
  useRouter: () => ({ refresh: () => { refreshed++; }, push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/app/missions/mission-1',
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: OverviewTaskStatus } = await import('./OverviewTaskStatus');
const { buildMissionBoard } = await import('@/lib/mission-board');
const { overviewWavesInput } = await import('@/app/app/dev/fixtures/mission-task-strip-fixtures');

const { tasks, gateFacts, kinds } = overviewWavesInput(10);
const board = (rows: unknown[], now: number) => buildMissionBoard({ now, missionCreatedAt: 0, missionStatus: 'active', tasks: rows as never, gateFacts });
const BACKOFF = (3 * 60 + 52) * 60_000;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let calls: Array<{ url: string; body: unknown }>;
let answer: { status: number; body: unknown };
const realFetch = globalThis.fetch;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  calls = [];
  refreshed = 0;
  answer = { status: 200, body: { ok: true } };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
});

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);
const render = (model: ReturnType<typeof board>, id: string) => act(() => root.render(<OverviewTaskStatus model={model} id={id} />));
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

describe('a running task', () => {
  it('reads Running 12m 04s · Updated 14s ago, with its latest step', () => {
    const now = Date.now();
    const runId = tasks.find(t => t.status === 'in_progress')!.id;
    const rows = tasks.map(t => (t.id === runId
      ? { ...t, workers: [{ ...t.workers![0], startedAt: now - 724_000, updatedAt: now - 60_000, milestones: [{ ts: now - 14_000, label: 'Running unit tests' }] }] }
      : t));
    render(board(rows, now), runId);
    expect(q('overview-task-word')?.textContent).toBe('Running · Running unit tests');
    expect(q('overview-live-line')?.textContent).toMatch(/^Running 12m 0[45]s · Updated 1[45]s ago$/);
    expect(q('overview-activity')?.getAttribute('data-quiet')).toBeNull();
    expect(q('overview-retry-now')).toBeNull();
  });

  it('with no event for 12m reads No activity for 12m, in the warning tone', () => {
    const now = Date.now();
    const runId = tasks.find(t => t.status === 'in_progress')!.id;
    const rows = tasks.map(t => (t.id === runId
      ? { ...t, workers: [{ ...t.workers![0], startedAt: now - 30 * 60_000, updatedAt: now - 12 * 60_000 - 5_000, milestones: [] }] }
      : t));
    render(board(rows, now), runId);
    const activity = q('overview-activity')!;
    expect(activity.textContent).toBe('No activity for 12m');
    expect(activity.getAttribute('data-quiet')).toBe('true');
    expect(activity.className).toContain('text-status-warning');
  });
});

describe('a red PR in a retry backoff', () => {
  const pendingId = Object.entries(kinds).find(([, k]) => k === 'slot')![0];
  const redRows = (now: number) => tasks.map(t => {
    if (t.id !== pendingId) return t;
    const w = { id: 'w-red', status: 'completed', runner: 'alpha', startedAt: now - 3_600_000, completedAt: now - 3_000_000, updatedAt: now - 3_000_000, mergedAt: null, prNumber: 777, prUrl: 'https://github.com/example/app/pull/777', prLifecycleStatus: 'ci_failed', currentAction: null, waitingFor: null, milestones: [], linesAdded: null, linesRemoved: null };
    return { ...t, startAt: now + BACKOFF, workers: [w], worker: { status: 'completed', startedAt: new Date(w.startedAt), updatedAt: new Date(w.updatedAt), prNumber: 777, prUrl: w.prUrl, prLifecycleStatus: 'ci_failed', mergedAt: null } };
  });

  it('reads Fixing · CI failed beside Retry in 3h 52m and Retry now', () => {
    render(board(redRows(Date.now()), Date.now()), pendingId);
    expect(q('overview-task-word')?.textContent).toBe('Fixing · CI failed');
    expect(q('overview-retry')?.textContent).toBe('Retry in 3h 52m');
    expect(q('overview-retry-now')?.textContent).toBe('Retry now');
    expect(q('overview-live-line')).toBeNull();
  });

  it('Retry now asks the start route to bring the retry forward, then refreshes', async () => {
    render(board(redRows(Date.now()), Date.now()), pendingId);
    await act(async () => { (q('overview-retry-now') as HTMLButtonElement).click(); });
    await flush();
    expect(calls).toEqual([{ url: `/api/tasks/${pendingId}/start`, body: { retryNow: true } }]);
    expect(refreshed).toBe(1);
  });

  it('a refused retry says why and does not refresh', async () => {
    answer = { status: 422, body: { error: 'Waiting on a dependency' } };
    render(board(redRows(Date.now()), Date.now()), pendingId);
    await act(async () => { (q('overview-retry-now') as HTMLButtonElement).click(); });
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Waiting on a dependency');
    expect(refreshed).toBe(0);
  });
});

describe('a PR closed without merging', () => {
  const closedId = tasks[0].id;
  const closed = (worker: Record<string, unknown>) => tasks.map(t => (t.id === closedId
    ? { ...t, delivery: { stage: 'closed', state: 'CLOSED_UNMERGED', headline: 'Closed', owner: 'system' }, workers: [{ ...t.workers![0], prNumber: 401, ...worker }] }
    : t));

  it('with a named replacement reads Closed → #812, linking it, and offers no action', () => {
    const m = board(closed({ namedReplacementPrNumber: 812, namedReplacementPrUrl: 'https://github.com/example/app/pull/812' }), 0);
    render(m, closedId);
    expect(q('overview-task-word')?.textContent).toBe('Closed → #812');
    expect(q('overview-task-word')?.querySelector('a')?.getAttribute('href')).toBe('https://github.com/example/app/pull/812');
    expect(q('overview-link-replacement')).toBeNull();
  });

  it('with none known reads Closed and Link replacement posts the PR number to its worker', async () => {
    const m = board(closed({}), 0);
    render(m, closedId);
    expect(q('overview-task-word')?.textContent).toBe('Closed');
    await act(async () => { (q('overview-link-replacement') as HTMLButtonElement).click(); });
    const input = container.querySelector('input[aria-label="Replacement PR number"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '#812');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { (q('overview-link-replacement-form') as HTMLFormElement).requestSubmit(); });
    await flush();
    expect(calls).toEqual([{ url: `/api/workers/${m.tasks[closedId].prWorkerId}/replacement`, body: { prNumber: 812 } }]);
    expect(refreshed).toBe(1);
  });
});
