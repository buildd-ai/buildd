import { describe, it, expect, afterAll, mock } from 'bun:test';

const _realFetch = globalThis.fetch;
afterAll(() => { globalThis.fetch = _realFetch; });

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      githubInstallations: {
        findFirst: mock(() => Promise.resolve({
          installationId: 5000,
          accessToken: 'cached-token',
          tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        })),
      },
    },
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  },
}));

mock.module('@buildd/core/db/schema', () => ({
  githubInstallations: { installationId: 'installationId' },
}));

import { postPrReview, OWN_PR_REVIEW_NOTE, mergePullRequest, checkSuitesAllPassed, dropSupersededSuites, allCheckSuitesPassed, retryAfterFromHeaders, githubApi } from './github';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** A response GitHub (or a proxy in front of it) returned with no readable body. */
function emptyResponse(status: number, contentType: string | null = null): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => { throw new SyntaxError('Unexpected end of JSON input'); },
    text: async () => '',
  } as unknown as Response;
}

describe('postPrReview', () => {
  it('posts a new review when no matching review exists for this commit', async () => {
    const methods: string[] = [];
    global.fetch = mock(async (_url: unknown, opts?: RequestInit) => {
      methods.push(opts?.method ?? 'GET');
      if (opts?.method === 'POST') {
        expect(JSON.parse(String(opts.body))).toEqual({
          commit_id: 'sha-1',
          event: 'APPROVE',
          body: 'Approved',
        });
        return jsonResponse(200, { id: 999, state: 'APPROVED' });
      }
      return jsonResponse(200, []);
    }) as unknown as typeof fetch;

    const result = await postPrReview({
      installationId: 5000,
      repoFullName: 'org/repo',
      prNumber: 42,
      headSha: 'sha-1',
      event: 'APPROVE',
      body: 'Approved',
    });

    expect(result.posted).toBe(true);
    expect(result.reviewId).toBe(999);
    expect(methods).toContain('POST');
  });

  it('does not stack a duplicate review when re-reviewing the same commit reaches the same verdict', async () => {
    global.fetch = mock(async (_url: unknown, opts?: RequestInit) => {
      if (opts?.method === 'POST') {
        throw new Error('must not POST a duplicate review');
      }
      return jsonResponse(200, [
        { id: 1, commit_id: 'sha-1', state: 'APPROVED', user: { login: 'buildd-ai[bot]' } },
      ]);
    }) as unknown as typeof fetch;

    const result = await postPrReview({
      installationId: 5000,
      repoFullName: 'org/repo',
      prNumber: 42,
      headSha: 'sha-1',
      event: 'APPROVE',
      body: 'Approved again',
    });

    expect(result.posted).toBe(false);
  });

  it('posts a fresh review when the head commit changed even if a prior review exists', async () => {
    global.fetch = mock(async (_url: unknown, opts?: RequestInit) => {
      if (opts?.method === 'POST') return jsonResponse(200, { id: 2, state: 'APPROVED' });
      return jsonResponse(200, [{ id: 1, commit_id: 'sha-old', state: 'APPROVED' }]);
    }) as unknown as typeof fetch;

    const result = await postPrReview({
      installationId: 5000,
      repoFullName: 'org/repo',
      prNumber: 42,
      headSha: 'sha-new',
      event: 'APPROVE',
      body: 'Approved',
    });

    expect(result.posted).toBe(true);
  });

  it('posts a fresh review when the same commit gets a different verdict (request-changes after approve)', async () => {
    global.fetch = mock(async (_url: unknown, opts?: RequestInit) => {
      if (opts?.method === 'POST') return jsonResponse(200, { id: 3, state: 'CHANGES_REQUESTED' });
      return jsonResponse(200, [{ id: 1, commit_id: 'sha-1', state: 'APPROVED' }]);
    }) as unknown as typeof fetch;

    const result = await postPrReview({
      installationId: 5000,
      repoFullName: 'org/repo',
      prNumber: 42,
      headSha: 'sha-1',
      event: 'REQUEST_CHANGES',
      body: 'Please fix X',
    });

    expect(result.posted).toBe(true);
  });

  it('does not throw when posting the review fails — returns a named reason instead', async () => {
    global.fetch = mock(async (_url: unknown, opts?: RequestInit) => {
      if (opts?.method === 'POST') return jsonResponse(422, { message: 'Unprocessable Entity' });
      return jsonResponse(200, []);
    }) as unknown as typeof fetch;

    const result = await postPrReview({
      installationId: 5000,
      repoFullName: 'org/repo',
      prNumber: 42,
      headSha: 'sha-1',
      event: 'APPROVE',
      body: 'Approved',
    });

    expect(result.posted).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

describe('postPrReview on a PR buildd itself opened', () => {
  const OWN_APPROVE = { message: 'Unprocessable Entity', errors: ['Review Can not approve your own pull request'] };
  const OWN_CHANGES = { message: 'Unprocessable Entity', errors: ['Review Can not request changes on your own pull request'] };
  const call = (event: 'APPROVE' | 'REQUEST_CHANGES', body = 'Verdict body') =>
    postPrReview({ installationId: 5000, repoFullName: 'org/repo', prNumber: 42, headSha: 'sha-1', event, body });

  for (const [event, refusal] of [['APPROVE', OWN_APPROVE], ['REQUEST_CHANGES', OWN_CHANGES]] as const) {
    it(`re-posts a refused ${event} as a COMMENT review at the same commit, saying GitHub's state is not the verdict`, async () => {
      const posts: Array<Record<string, unknown>> = [];
      global.fetch = mock(async (_url: unknown, opts?: RequestInit) => {
        if (opts?.method !== 'POST') return jsonResponse(200, []);
        const sent = JSON.parse(String(opts.body));
        posts.push(sent);
        return sent.event === 'COMMENT' ? jsonResponse(200, { id: 77, state: 'COMMENTED' }) : jsonResponse(422, refusal);
      }) as unknown as typeof fetch;

      const result = await call(event);

      expect(posts).toEqual([
        { commit_id: 'sha-1', event, body: 'Verdict body' },
        { commit_id: 'sha-1', event: 'COMMENT', body: `Verdict body\n\n${OWN_PR_REVIEW_NOTE}` },
      ]);
      expect(result).toEqual({ posted: true, reviewId: 77, commentedOwnPr: true });
    });
  }

  it('does not stack a second comment review when the same verdict is redelivered for the same commit', async () => {
    global.fetch = mock(async (_url: unknown, opts?: RequestInit) => {
      if (opts?.method === 'POST') throw new Error('must not POST again');
      return jsonResponse(200, [{ id: 77, commit_id: 'sha-1', state: 'COMMENTED', body: 'Verdict body' }]);
    }) as unknown as typeof fetch;

    const result = await call('APPROVE');
    expect(result.posted).toBe(false);
    expect(result.reason).toBe('a matching review already exists for this commit');
  });

  it('does not stack a second comment review when the earlier one carries the own-PR note', async () => {
    global.fetch = mock(async (_url: unknown, opts?: RequestInit) => {
      if (opts?.method === 'POST') throw new Error('must not POST again');
      return jsonResponse(200, [{ id: 77, commit_id: 'sha-1', state: 'COMMENTED', body: `Verdict body\n\n${OWN_PR_REVIEW_NOTE}` }]);
    }) as unknown as typeof fetch;

    expect((await call('APPROVE')).reason).toBe('a matching review already exists for this commit');
  });

  it('a 422 for any other reason is not retried as a comment', async () => {
    const events: string[] = [];
    global.fetch = mock(async (_url: unknown, opts?: RequestInit) => {
      if (opts?.method !== 'POST') return jsonResponse(200, []);
      events.push(JSON.parse(String(opts.body)).event);
      return jsonResponse(422, { message: 'Unprocessable Entity', errors: ['Pull request review thread line must be part of the diff'] });
    }) as unknown as typeof fetch;

    const result = await call('APPROVE');
    expect(events).toEqual(['APPROVE']);
    expect(result.posted).toBe(false);
  });

  it('a comment fallback that fails too reports the failure', async () => {
    global.fetch = mock(async (_url: unknown, opts?: RequestInit) => {
      if (opts?.method !== 'POST') return jsonResponse(200, []);
      const sent = JSON.parse(String(opts.body));
      return sent.event === 'COMMENT' ? jsonResponse(500, { message: 'Server Error' }) : jsonResponse(422, OWN_APPROVE);
    }) as unknown as typeof fetch;

    const result = await call('APPROVE');
    expect(result.posted).toBe(false);
    expect(result.commentedOwnPr).toBeUndefined();
    expect(result.reason).toBeTruthy();
  });
});

describe('retryAfterFromHeaders', () => {
  const now = Date.parse('2026-10-01T00:00:00Z');
  it('reads retry-after in seconds', () => {
    expect(retryAfterFromHeaders(new Headers({ 'retry-after': '90' }), now)).toBe(90_000);
  });
  it('reads x-ratelimit-reset (epoch seconds) when the quota is spent', () => {
    expect(retryAfterFromHeaders(new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 300) }), now)).toBe(300_000);
    // A reset already past is "now", never negative.
    expect(retryAfterFromHeaders(new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 - 5) }), now)).toBe(0);
  });
  it('ignores x-ratelimit-reset while quota remains, and anything unparseable', () => {
    expect(retryAfterFromHeaders(new Headers({ 'x-ratelimit-remaining': '12', 'x-ratelimit-reset': String(now / 1000 + 300) }), now)).toBeNull();
    expect(retryAfterFromHeaders(new Headers({ 'retry-after': 'soon' }), now)).toBeNull();
    expect(retryAfterFromHeaders(new Headers(), now)).toBeNull();
  });
});

describe('mergePullRequest', () => {
  it('carries a rate limit\'s retry-after on the refusal', async () => {
    global.fetch = mock(async () => new Response(JSON.stringify({ message: 'You have exceeded a secondary rate limit.' }), {
      status: 429, headers: { 'content-type': 'application/json', 'retry-after': '60' },
    })) as unknown as typeof fetch;
    const result = await mergePullRequest(5000, 'org/repo', 42, 'squash', 'head-A');
    expect(result).toMatchObject({ merged: false, status: 429, retryAfterMs: 60_000 });
    expect(result.indeterminate).toBeFalsy();
  });

  it('returns merged on a 200 with a parseable body', async () => {
    global.fetch = mock(async () => jsonResponse(200, { message: 'Pull Request successfully merged' })) as unknown as typeof fetch;

    const result = await mergePullRequest(5000, 'org/repo', 42, 'squash', 'head-A');

    expect(result).toEqual({ merged: true, message: 'Pull Request successfully merged', status: 200 });
  });

  it('carries GitHub\'s real reason as a definitive (non-indeterminate) rejection', async () => {
    global.fetch = mock(async () => jsonResponse(405, { message: 'Method Not Allowed' })) as unknown as typeof fetch;

    const result = await mergePullRequest(5000, 'org/repo', 42, 'squash', 'head-A');

    expect(result.merged).toBe(false);
    expect(result.message).toBe('Method Not Allowed');
    expect(result.indeterminate).toBeFalsy();
  });

  it('marks an empty-body failure response as indeterminate instead of surfacing a JSON parse error', async () => {
    global.fetch = mock(async () => emptyResponse(502)) as unknown as typeof fetch;

    const result = await mergePullRequest(5000, 'org/repo', 42, 'squash', 'head-A');

    expect(result.merged).toBe(false);
    expect(result.indeterminate).toBe(true);
    expect(result.message).not.toMatch(/unexpected end of json/i);
    expect(result.message).toContain('502');
  });

  it('marks an empty-body 409 as indeterminate rather than a real conflict rejection', async () => {
    global.fetch = mock(async () => emptyResponse(409)) as unknown as typeof fetch;

    const result = await mergePullRequest(5000, 'org/repo', 42, 'squash', 'head-A');

    expect(result.merged).toBe(false);
    expect(result.indeterminate).toBe(true);
  });

  it('marks a network failure (no response at all) as indeterminate', async () => {
    global.fetch = mock(async () => { throw new Error('fetch failed'); }) as unknown as typeof fetch;

    const result = await mergePullRequest(5000, 'org/repo', 42, 'squash', 'head-A');

    expect(result.merged).toBe(false);
    expect(result.indeterminate).toBe(true);
    expect(result.message).toContain('Could not reach GitHub');
  });

  it('treats a non-JSON body on a non-2xx response as indeterminate (e.g. an HTML proxy error page)', async () => {
    global.fetch = mock(async () => ({
      ok: false,
      status: 504,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/html' : null) },
      text: async () => '<html>Gateway Timeout</html>',
      json: async () => { throw new SyntaxError('Unexpected token <'); },
    })) as unknown as typeof fetch;

    const result = await mergePullRequest(5000, 'org/repo', 42, 'squash', 'head-A');

    expect(result.merged).toBe(false);
    expect(result.indeterminate).toBe(true);
    expect(result.message).not.toMatch(/unexpected token/i);
  });
});

describe('mergePullRequest expected head', () => {
  it('sends the checked SHA and reports a head movement as a definitive refusal', async () => {
    let sent: any;
    global.fetch = mock(async (_url: unknown, opts?: RequestInit) => {
      sent = JSON.parse(String(opts?.body));
      return sent.sha === 'head-A'
        ? jsonResponse(409, { message: 'Head branch was modified' })
        : jsonResponse(200, { message: 'merged unchecked head' });
    }) as unknown as typeof fetch;
    const result = await mergePullRequest(5000, 'org/repo', 42, 'squash', 'head-A');
    expect(sent).toEqual({ merge_method: 'squash', sha: 'head-A' });
    expect(result).toEqual({ merged: false, message: 'Head branch was modified', status: 409 });
  });
});

describe('checkSuitesAllPassed', () => {
  const suite = (slug: string, status: string, conclusion: string | null, runs: number) => ({
    app: { slug },
    status,
    conclusion,
    latest_check_runs_count: runs,
  });

  it('ignores a third-party app suite that was created but never ran anything', () => {
    // GitHub creates a suite for every installed app with checks permission;
    // an app that never reports leaves it queued with zero runs forever.
    expect(checkSuitesAllPassed([
      suite('github-actions', 'completed', 'success', 5),
      suite('vercel', 'completed', 'success', 1),
      suite('claude', 'queued', null, 0),
      suite('renovate', 'queued', null, 0),
    ])).toBe(true);
  });

  it('never ignores a github-actions suite, even before its runs register', () => {
    expect(checkSuitesAllPassed([
      suite('vercel', 'completed', 'success', 1),
      suite('github-actions', 'queued', null, 0),
    ])).toBe(false);
  });

  it('still waits on a third-party suite that has runs in progress', () => {
    expect(checkSuitesAllPassed([
      suite('github-actions', 'completed', 'success', 5),
      suite('vercel', 'in_progress', null, 1),
    ])).toBe(false);
  });

  it('is false when nothing real ran', () => {
    expect(checkSuitesAllPassed([suite('claude', 'queued', null, 0)])).toBe(false);
    expect(checkSuitesAllPassed([])).toBe(false);
  });

  it('fails on a failed suite', () => {
    expect(checkSuitesAllPassed([suite('github-actions', 'completed', 'failure', 3)])).toBe(false);
  });
});

// Task 9f4d3339: githubApi had no way to give up on a call, so one stalled read held a whole cron pass.
// The timeout is opt-in: a caller passes `signal`; the many callers that pass nothing get no signal.
describe('githubApi request timeout (opt-in AbortSignal)', () => {
  /** Like fetch against a server that never answers: settles only when the signal aborts. */
  const stalledFetch = (seen: Array<AbortSignal | undefined>) => mock((_url: unknown, opts?: RequestInit) => {
    seen.push(opts?.signal ?? undefined);
    return new Promise<Response>((_resolve, reject) => {
      const sig = opts?.signal;
      if (!sig) return;
      sig.addEventListener('abort', () => reject(sig.reason), { once: true });
    });
  });

  it('abandons a stalled call when the caller\'s signal fires', async () => {
    const seen: Array<AbortSignal | undefined> = [];
    global.fetch = stalledFetch(seen) as unknown as typeof fetch;
    const t0 = Date.now();
    await expect(githubApi(5000, '/repos/o/r/pulls/1', { signal: AbortSignal.timeout(40) })).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });

  it('passes no signal when the caller gives none, so existing callers are unchanged', async () => {
    const seen: Array<AbortSignal | undefined> = [];
    global.fetch = mock((_url: unknown, opts?: RequestInit) => {
      seen.push(opts?.signal ?? undefined);
      return Promise.resolve(jsonResponse(200, { ok: 1 }));
    }) as unknown as typeof fetch;
    expect(await githubApi(5000, '/repos/o/r/pulls/1')).toEqual({ ok: 1 });
    expect(seen).toEqual([undefined]);
  });
});

describe('allCheckSuitesPassed with a superseded run', () => {
  const failedSuite = { id: 1, app: { slug: 'github-actions' }, status: 'completed', conclusion: 'failure', latest_check_runs_count: 1 };
  const greenSuite = { id: 2, app: { slug: 'github-actions' }, status: 'completed', conclusion: 'success', latest_check_runs_count: 1 };
  const run = (id: number, suite: number, conclusion: string) => ({ id, name: 'build', status: 'completed', conclusion, check_suite: { id: suite } });

  it('drops a suite whose only run a newer same-name run replaced', () => {
    const kept = dropSupersededSuites([failedSuite, greenSuite], [run(10, 1, 'failure'), run(11, 2, 'success')]);
    expect(kept.map((s) => s.id)).toEqual([2]);
    expect(checkSuitesAllPassed(kept)).toBe(true);
  });

  it('keeps every suite when the run read is unavailable', () => {
    const kept = dropSupersededSuites([failedSuite, greenSuite], null);
    expect(checkSuitesAllPassed(kept)).toBe(false);
  });

  it('keeps a failed suite with no runs (startup failure)', () => {
    const kept = dropSupersededSuites([{ ...failedSuite, latest_check_runs_count: 0 }, greenSuite], [run(11, 2, 'success')]);
    expect(kept).toHaveLength(2);
  });

  it('still fails when the newest run is the failed one', () => {
    const kept = dropSupersededSuites([failedSuite, greenSuite], [run(10, 2, 'success'), run(11, 1, 'failure')]);
    expect(checkSuitesAllPassed(kept)).toBe(false);
  });

  it('reads green through the fetch path', async () => {
    const orig = global.fetch;
    global.fetch = mock(async (url: unknown) => {
      const u = String(url);
      if (u.includes('access_tokens')) return jsonResponse(201, { token: 't', expires_at: new Date(Date.now() + 3.6e6).toISOString() });
      if (u.includes('/check-suites')) return jsonResponse(200, { check_suites: [failedSuite, greenSuite] });
      if (u.includes('/actions/runs')) return jsonResponse(200, { total_count: 2, workflow_runs: [{ workflow_id: 7, check_suite_id: 1 }, { workflow_id: 7, check_suite_id: 2 }] });
      return jsonResponse(200, { total_count: 2, check_runs: [run(10, 1, 'failure'), run(11, 2, 'success')] });
    }) as unknown as typeof fetch;
    try {
      expect(await allCheckSuitesPassed(5001, 'org/repo', 'sha1')).toBe(true);
    } finally {
      global.fetch = orig;
    }
  });
});
