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

describe('a composition-covered release candidate', () => {
  const COVERED_STATUS = {
    state: 'composition_covered',
    terminal: true,
    verdict: null,
    confidence: null,
    reviewTaskId: null,
    prState: 'open',
    merged: false,
    mergeBlocked: null,
    coveredBy: { kind: 'composition', headSha: 'f6a70684a05', constituents: 2 },
  };
  const COVERED_REQUEST = {
    ok: true,
    reviewNotOwed: true,
    prNumber: 77,
    headSha: 'f6a70684a05',
    composition: { kind: 'composed', headSha: 'f6a70684a05', constituents: 2 },
    reviewTaskId: null,
    autoMergeExpected: true,
    status: COVERED_STATUS,
  };
  async function reply(action: string, params: Record<string, unknown>, data: unknown): Promise<string> {
    const { api } = recordingApi({ '/api/github/pr/review': data, '/api/github/pr': { pr: { number: 77, title: 't', url: 'u', state: 'open' } } });
    const result = await handleBuilddAction(api, action, params, context());
    return (result.content[0] as { text: string }).text;
  }

  describe('request_pr_review', () => {
    it('says no reviewer is owed, with no empty ids and no human-only or waiting instruction', async () => {
      const text = await reply('request_pr_review', { prNumber: 77 }, COVERED_REQUEST);
      expect(text).toContain('#77');
      expect(text).toContain('f6a7068');
      expect(text).toMatch(/composition/i);
      expect(text).toContain('2 ');
      expect(text).not.toContain('null');
      expect(text).not.toContain('undefined');
      expect(text).not.toContain('Review requested');
      expect(text).not.toContain('left to a human');
      expect(text).not.toContain('waitSeconds');
    });

    it('does not read as a reviewer approval or a person\'s sign-off, and keeps the merge gates in front of it', async () => {
      const text = await reply('request_pr_review', { prNumber: 77 }, COVERED_REQUEST);
      expect(text).toMatch(/not a reviewer approval/i);
      expect(text).toMatch(/human sign-off/i);
      expect(text).toMatch(/CI/);
      expect(text).toMatch(/open findings/i);
    });

    it('says a callback will not fire, because this reply is the outcome', async () => {
      const text = await reply('request_pr_review', { prNumber: 77, callbackUrl: 'https://example.test/hook' }, COVERED_REQUEST);
      expect(text).toMatch(/no callback/i);
    });

    it('a merge policy that keeps the merge for a person says exactly that', async () => {
      const text = await reply('request_pr_review', { prNumber: 77 }, {
        ...COVERED_REQUEST, autoMergeExpected: false, status: { ...COVERED_STATUS, mergeBlocked: 'awaiting_human' },
      });
      expect(text).toMatch(/merge policy leaves the merge to a person/i);
      expect(text).not.toMatch(/\bapproved, but\b/i);
    });

    it('an earlier verdict still on file is named rather than reported as covered', async () => {
      const text = await reply('request_pr_review', { prNumber: 77, force: true }, {
        ...COVERED_REQUEST, status: { state: 'changes_requested', terminal: true, verdict: 'request-changes', reviewTaskId: 'older-review' },
      });
      expect(text).toContain('changes_requested');
      expect(text).toContain('older-review');
      expect(text).not.toMatch(/\bcovered by composition, so\b/i);
    });

    it('an uncovered delta reads as a real scoped review with its task and the way to wait', async () => {
      const text = await reply('request_pr_review', { prNumber: 77 }, {
        ...REVIEW_RESPONSE, prNumber: 77, adopted: false,
        composition: { kind: 'delta', headSha: 'f6a70684a05', commits: 1, paths: 3 },
      });
      expect(text).toContain('Review requested');
      expect(text).toContain('review-1');
      expect(text).toMatch(/1 commit .*no earlier review covered/);
      expect(text).toContain('waitSeconds');
    });

    it('an ordinary request is unchanged', async () => {
      const text = await reply('request_pr_review', { prNumber: 42 }, { ...REVIEW_RESPONSE, adopted: false });
      expect(text).toContain('Review requested');
      expect(text).toContain('Mapped to existing task task-1');
      expect(text).not.toMatch(/composition/i);
    });

    it('a real person-only merge policy keeps its human-merge line', async () => {
      const text = await reply('request_pr_review', { prNumber: 42 }, { ...REVIEW_RESPONSE, adopted: false, autoMergeExpected: false });
      expect(text).toContain('On approval the merge is left to a human');
    });
  });

  describe('create_pr with requestReview', () => {
    it('reports the coverage rather than a review that was never requested', async () => {
      const text = await reply('create_pr', { title: 't', head: 'release/v1', lede: 'A release.', requestReview: true }, COVERED_REQUEST);
      expect(text).toContain('composition');
      expect(text).not.toContain('Review requested');
      expect(text).not.toContain('Wait for the verdict');
    });
  });

  describe('get_pr_review', () => {
    it('reads as a settled review by composition, never not_requested or a reviewer verdict', async () => {
      const text = await reply('get_pr_review', { prNumber: 77 }, { ok: true, prNumber: 77, timedOut: false, status: COVERED_STATUS, composition: COVERED_REQUEST.composition });
      expect(text).toContain('composition_covered');
      expect(text).toContain('terminal: yes');
      expect(text).toContain('f6a7068');
      expect(text).toMatch(/not a reviewer approval/i);
      expect(text).toMatch(/open findings/i);
      expect(text).not.toContain('Verdict:');
      expect(text).not.toContain('not_requested');
      expect(text).not.toContain('undefined');
    });

    it('tells a merge-waiter the review is done and the merge is what it is waiting on', async () => {
      const text = await reply('get_pr_review', { prNumber: 77, waitFor: 'merge' }, {
        ok: true, prNumber: 77, timedOut: true, status: { ...COVERED_STATUS, terminal: false }, composition: COVERED_REQUEST.composition,
      });
      expect(text).toContain('terminal: no');
      expect(text).toMatch(/call again/);
      expect(text).not.toContain('still composition_covered');
    });

    it('a person-held merge on a covered head does not claim an approval', async () => {
      const text = await reply('get_pr_review', { prNumber: 77 }, {
        ok: true, prNumber: 77, timedOut: false, status: { ...COVERED_STATUS, mergeBlocked: 'awaiting_human' }, composition: COVERED_REQUEST.composition,
      });
      expect(text).toMatch(/merge policy leaves the merge to a person/i);
      expect(text).not.toContain('Approved, but');
    });

    it('an uncovered delta says what is owed and how to file it, not to keep waiting', async () => {
      const text = await reply('get_pr_review', { prNumber: 77 }, {
        ok: true, prNumber: 77, timedOut: true,
        status: { state: 'not_requested', terminal: false, verdict: null, prState: 'open' },
        composition: { kind: 'delta', headSha: 'f6a70684a05', commits: 2, paths: 3 },
      });
      expect(text).toContain('not_requested');
      expect(text).toContain('terminal: no');
      expect(text).toMatch(/2 commits .*no earlier review covered/);
      expect(text).toContain('request_pr_review');
      expect(text).not.toContain('call again');
    });

    it('an ordinary not_requested read is unchanged', async () => {
      const text = await reply('get_pr_review', { prNumber: 42 }, {
        ok: true, prNumber: 42, timedOut: true, status: { state: 'not_requested', terminal: false, prState: 'open' }, composition: null,
      });
      expect(text).toContain('not_requested');
      expect(text).toContain('call again');
      expect(text).not.toMatch(/composition/i);
    });
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
      { title: 'feat: thing', head: 'buildd/thing', lede: 'The thing now works.', requestReview: true, reviewerRole: 'reviewer' },
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

    await handleBuilddAction(api, 'create_pr', { title: 'feat: thing', head: 'buildd/thing', lede: 'The thing now works.' }, context());
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
      { title: 'feat: thing', head: 'buildd/thing', lede: 'The thing now works.', requestReview: true },
      context(),
    );

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('#79');
    expect(text).toContain('review');
    expect(text).toContain('403 no reviewer role');
  });
});

describe('create_pr requestReview retries a transient 500', () => {
  it('retries once and reports the review, without printing undefined', async () => {
    let reviewCalls = 0;
    const api = (async (endpoint: string) => {
      if (endpoint === '/api/github/pr/review') {
        reviewCalls++;
        if (reviewCalls === 1) throw new Error('API error: 500 - {"error":"Could not create the reviewer task"}');
        return { ok: true, alreadyRequested: true, prNumber: 80, reviewTaskId: 'rt1', status: { state: 'queued' } };
      }
      return { pr: { number: 80, title: 't', url: 'https://github.com/o/r/pull/80', state: 'open' } };
    }) as unknown as ApiFn;
    const out = await handleBuilddAction(api, 'create_pr', { title: 't', head: 'b', lede: 'A change.', requestReview: true }, context());
    const text = out.content[0]!.text;
    expect(reviewCalls).toBe(2);
    expect(text).toContain('Review requested');
    expect(text).not.toContain('undefined');
  });
});

describe('1bd26ae7: a kernel round with no reviewer task is never "already under review"', () => {
  const queued = { ok: true, kernel: true, alreadyRequested: true, prNumber: 42, reviewTaskId: null, status: null, queued: { state: 'queued', headSha: 'abc', reason: 'no reviewer task exists for this head yet (review_in_flight)' } };
  it('request_pr_review says what is queued', async () => {
    const { api } = recordingApi({ '/api/github/pr/review': queued });
    const out = await handleBuilddAction(api, 'request_pr_review', { prNumber: 42 }, context());
    const text = out.content[0]!.text;
    expect(text).toContain('PR #42: no reviewer task exists for this head yet (review_in_flight).');
    expect(text).not.toContain('already under review');
    expect(text).not.toContain('undefined');
  });
  it('create_pr with requestReview says the same', async () => {
    const { api } = recordingApi({
      '/api/github/pr/review': queued,
      '/api/github/pr': { pr: { number: 42, title: 't', url: 'https://github.com/o/r/pull/42', state: 'open' } },
    });
    const out = await handleBuilddAction(api, 'create_pr', { title: 't', head: 'b', lede: 'A change.', requestReview: true }, context());
    const text = out.content[0]!.text;
    expect(text).toContain('**Review requested** — no reviewer task exists for this head yet (review_in_flight).');
    expect(text).not.toContain('review task null');
  });
});
