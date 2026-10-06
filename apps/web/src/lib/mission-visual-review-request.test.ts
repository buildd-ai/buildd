import { describe, expect, it } from 'bun:test';
import {
  browserRunnerNote,
  captureSourceText,
  loadVisualReviewPreview,
  requestMissionVisualReview,
  visualReviewOutcomeText,
} from './mission-visual-review-request';

/**
 * The one client path for "Run visual review" / "Run visual audit": always the
 * mission's surface-audit endpoint, never the task composer.
 */

type Call = { url: string; method?: string };
function fakeFetch(reply: { ok?: boolean; status?: number; json?: unknown; throws?: boolean }) {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method });
    if (reply.throws) throw new Error('offline');
    const ok = reply.ok ?? true;
    return { ok, status: reply.status ?? (ok ? 200 : 500), json: async () => reply.json ?? {} } as Response;
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('requestMissionVisualReview', () => {
  it('POSTs the mission surface-audit endpoint and nothing else', async () => {
    const { f, calls } = fakeFetch({ json: { created: true, taskId: 't-1', status: 'pending' } });
    const out = await requestMissionVisualReview('m-1', f);
    expect(out).toEqual({ kind: 'created', taskId: 't-1', status: 'pending' });
    expect(calls).toEqual([{ url: '/api/missions/m-1/surface-audit', method: 'POST' }]);
    expect(calls.some(c => c.url.includes('/tasks/new') || c.url === '/api/tasks')).toBe(false);
  });

  it('an existing audit is returned, not duplicated', async () => {
    const { f } = fakeFetch({ json: { created: false, taskId: 't-0', status: 'in_progress' } });
    const out = await requestMissionVisualReview('m-1', f);
    expect(out).toEqual({ kind: 'existing', taskId: 't-0', status: 'in_progress' });
    expect(visualReviewOutcomeText(out)).toContain('already on this mission');
    expect(visualReviewOutcomeText(out)).toContain('Nothing was duplicated');
  });

  it('a finished audit says to open it', async () => {
    const { f } = fakeFetch({ json: { created: false, taskId: 't-0', status: 'completed' } });
    expect(visualReviewOutcomeText(await requestMissionVisualReview('m-1', f))).toContain('already has a finished visual review');
  });

  it('a refusal carries the server words and code', async () => {
    const { f } = fakeFetch({ ok: false, status: 409, json: { error: 'This mission is already closed, so a visual review cannot be added.', code: 'mission_closed' } });
    const out = await requestMissionVisualReview('m-1', f);
    expect(out).toEqual({ kind: 'refused', code: 'mission_closed', message: 'This mission is already closed, so a visual review cannot be added.' });
  });

  it('a network failure never throws', async () => {
    const { f } = fakeFetch({ throws: true });
    const out = await requestMissionVisualReview('m-1', f);
    expect(out.kind).toBe('error');
    expect(visualReviewOutcomeText(out)).toContain('was not added');
  });
});

describe('loadVisualReviewPreview', () => {
  it('GETs the same endpoint', async () => {
    const preview = { existing: null, routes: ['/app/home'], viewports: ['mobile', 'desktop'], capture: null, browserRunnerOnline: true, executorLocal: false };
    const { f, calls } = fakeFetch({ json: { preview } });
    expect(await loadVisualReviewPreview('m-1', f)).toEqual(preview as any);
    expect(calls).toEqual([{ url: '/api/missions/m-1/surface-audit', method: 'GET' }]);
  });

  it('is null on failure, so the action stands bare', async () => {
    expect(await loadVisualReviewPreview('m-1', fakeFetch({ ok: false }).f)).toBeNull();
    expect(await loadVisualReviewPreview('m-1', fakeFetch({ throws: true }).f)).toBeNull();
  });
});

describe('the browser constraint and capture source, in words', () => {
  it('names the missing browser runner and the next step', () => {
    const note = browserRunnerNote({ browserRunnerOnline: false, executorLocal: false })!;
    expect(note).toContain('No runner with a browser is online');
    expect(note).toContain('start a runner');
  });

  it('a local mission says buildd\'s runners will not pick it up', () => {
    expect(browserRunnerNote({ browserRunnerOnline: true, executorLocal: true })).toContain('will not pick the review up');
  });

  it('says nothing when a browser runner is online or unknown', () => {
    expect(browserRunnerNote({ browserRunnerOnline: true, executorLocal: false })).toBeNull();
    expect(browserRunnerNote({ browserRunnerOnline: null, executorLocal: false })).toBeNull();
  });

  it('capture source', () => {
    expect(captureSourceText({ branch: 'mission', ref: 'buildd/m-x', pageSource: 'sandbox' })).toBe('A local build of the mission branch (buildd/m-x)');
    expect(captureSourceText({ branch: 'trunk', ref: 'dev', pageSource: 'vercel-preview' })).toBe('The preview deployment of trunk (dev)');
  });
});
