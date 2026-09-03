import { describe, expect, it, mock } from 'bun:test';
import {
  handleBuilddAction,
  workerActions,
  buildParamsDescription,
  type ActionContext,
  type ApiFn,
} from '../mcp-tools';

function context(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workerId: 'worker-1',
    getWorkspaceId: async () => 'workspace-1',
    getLevel: async () => 'worker',
    ...overrides,
  };
}

type Call = { endpoint: string; init?: { method?: string; body?: string } };

function recordingApi(responses: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const api = (async (endpoint: string, init?: { method?: string; body?: string }) => {
    calls.push({ endpoint, init });
    const key = Object.keys(responses).find((k) => endpoint.startsWith(k));
    return key ? responses[key] : {};
  }) as unknown as ApiFn;
  return { api, calls };
}

function bodyOf(call: Call): Record<string, unknown> {
  return JSON.parse(call.init?.body ?? '{}');
}

const REVIEW_RESPONSE = {
  ok: true,
  adopted: true,
  prNumber: 42,
  taskId: 'task-1',
  reviewTaskId: 'review-1',
  reviewerRole: 'reviewer',
  autoMergeExpected: true,
  status: { state: 'queued', terminal: false },
};

describe('request_pr_review', () => {
  it('is advertised as a worker-level action with a documented params contract', () => {
    expect(workerActions).toContain('request_pr_review');
    expect(workerActions).toContain('get_pr_review');
    const description = buildParamsDescription(workerActions);
    expect(description).toContain('request_pr_review');
    expect(description).toContain('get_pr_review');
    // The waiting contract is the point of these actions — it must be stated.
    expect(description).toContain('waitSeconds');
    expect(description).toContain('callbackUrl');
  });

  it('requires a prNumber', async () => {
    const { api } = recordingApi();
    let error: Error | undefined;
    try {
      await handleBuilddAction(api, 'request_pr_review', {}, context());
    } catch (e) {
      error = e as Error;
    }
    expect(error?.message).toContain('prNumber');
  });

  it('POSTs the review request and reports what was dispatched', async () => {
    const { api, calls } = recordingApi({ '/api/github/pr/review': REVIEW_RESPONSE });

    const result = await handleBuilddAction(
      api,
      'request_pr_review',
      { prNumber: 42, workspaceId: 'buildd', reviewerRole: 'reviewer' },
      context(),
    );

    expect(calls[0]!.endpoint).toBe('/api/github/pr/review');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(bodyOf(calls[0]!)).toMatchObject({
      prNumber: 42,
      workspaceId: 'buildd',
      reviewerRole: 'reviewer',
    });

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('#42');
    expect(text).toContain('reviewer');
    expect(text).toContain('review-1');
    // The agent must be told how to wait, not left to invent a loop.
    expect(text).toContain('get_pr_review');
  });

  it('passes a callback through and echoes it back', async () => {
    const { api, calls } = recordingApi({
      '/api/github/pr/review': {
        ...REVIEW_RESPONSE,
        callback: { url: 'https://example.test/hook', on: 'merge' },
      },
    });

    const result = await handleBuilddAction(
      api,
      'request_pr_review',
      { prNumber: 42, callbackUrl: 'https://example.test/hook', callbackOn: 'merge' },
      context(),
    );

    expect(bodyOf(calls[0]!)).toMatchObject({
      callbackUrl: 'https://example.test/hook',
      callbackOn: 'merge',
    });
    expect((result.content[0] as { text: string }).text).toContain('example.test/hook');
  });

  it('says plainly when a review was already requested rather than implying a new one', async () => {
    const { api } = recordingApi({
      '/api/github/pr/review': {
        ok: true,
        alreadyRequested: true,
        prNumber: 42,
        reviewTaskId: 'review-1',
        status: { state: 'reviewing', terminal: false },
      },
    });

    const result = await handleBuilddAction(api, 'request_pr_review', { prNumber: 42 }, context());
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('already');
    expect(text).toContain('reviewing');
  });
});

describe('get_pr_review', () => {
  it('requires a prNumber', async () => {
    const { api } = recordingApi();
    let error: Error | undefined;
    try {
      await handleBuilddAction(api, 'get_pr_review', {}, context());
    } catch (e) {
      error = e as Error;
    }
    expect(error?.message).toContain('prNumber');
  });

  it('reads the status with a single call by default', async () => {
    const { api, calls } = recordingApi({
      '/api/github/pr/review': {
        ok: true,
        prNumber: 42,
        timedOut: false,
        autoMergeExpected: true,
        status: {
          state: 'approved',
          terminal: true,
          verdict: 'approve',
          confidence: 0.94,
          summary: 'Scoped and tested.',
          merged: false,
          prState: 'open',
        },
      },
    });

    const result = await handleBuilddAction(api, 'get_pr_review', { prNumber: 42 }, context());

    expect(calls[0]!.endpoint).toContain('prNumber=42');
    expect(calls[0]!.init?.method).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('approved');
    expect(text).toContain('0.94');
    expect(text).toContain('Scoped and tested.');
    expect(text).toContain('terminal');
  });

  it('forwards waitFor and waitSeconds so a caller can block in one call', async () => {
    const { api, calls } = recordingApi({
      '/api/github/pr/review': {
        ok: true,
        prNumber: 42,
        timedOut: true,
        status: { state: 'reviewing', terminal: false },
      },
    });

    const result = await handleBuilddAction(
      api,
      'get_pr_review',
      { prNumber: 42, waitFor: 'merge', waitSeconds: 45, workspaceId: 'buildd' },
      context(),
    );

    expect(calls[0]!.endpoint).toContain('waitFor=merge');
    expect(calls[0]!.endpoint).toContain('waitSeconds=45');
    expect(calls[0]!.endpoint).toContain('workspaceId=buildd');
    // A timed-out long-poll must tell the agent to call again, not look final.
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('still');
    expect(text).toContain('call again');
  });
});

describe('create_pr requestReview', () => {
  it('requests a review on the PR it just opened', async () => {
    const { api, calls } = recordingApi({
      '/api/github/pr': {
        pr: { number: 77, title: 'feat: thing', url: 'https://github.com/o/r/pull/77', state: 'open' },
      },
      '/api/github/pr/review': REVIEW_RESPONSE,
    });

    const result = await handleBuilddAction(
      api,
      'create_pr',
      { title: 'feat: thing', head: 'buildd/thing', requestReview: true, reviewerRole: 'reviewer' },
      context(),
    );

    const reviewCall = calls.find((c) => c.endpoint === '/api/github/pr/review')!;
    expect(reviewCall).toBeDefined();
    expect(bodyOf(reviewCall)).toMatchObject({ prNumber: 77, reviewerRole: 'reviewer' });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('#77');
    expect(text).toContain('Review requested');
  });

  it('does not request a review unless asked', async () => {
    const { api, calls } = recordingApi({
      '/api/github/pr': {
        pr: { number: 78, title: 'feat: thing', url: 'https://github.com/o/r/pull/78', state: 'open' },
      },
    });

    await handleBuilddAction(api, 'create_pr', { title: 'feat: thing', head: 'buildd/thing' }, context());
    expect(calls.some((c) => c.endpoint === '/api/github/pr/review')).toBe(false);
  });

  it('still reports the PR when the review request fails', async () => {
    const calls: Call[] = [];
    const api = (async (endpoint: string, init?: any) => {
      calls.push({ endpoint, init });
      if (endpoint === '/api/github/pr/review') throw new Error('403 no reviewer role');
      return { pr: { number: 79, title: 'feat: thing', url: 'https://github.com/o/r/pull/79', state: 'open' } };
    }) as unknown as ApiFn;

    const result = await handleBuilddAction(
      api,
      'create_pr',
      { title: 'feat: thing', head: 'buildd/thing', requestReview: true },
      context(),
    );

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('#79');
    expect(text).toContain('review');
    expect(text).toContain('403 no reviewer role');
  });
});
