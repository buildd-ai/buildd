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

import { postPrReview, mergePullRequest, checkSuitesAllPassed } from './github';

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

describe('mergePullRequest', () => {
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
