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

import { postPrReview } from './github';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
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
