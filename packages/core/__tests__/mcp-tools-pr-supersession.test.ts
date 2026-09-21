/**
 * Unit tests: the MCP surface for PR supersession (task fcaf83d5) —
 * record_pr_supersession's param validation and call shape, and get_pr/
 * get_task rendering the recorded edge back.
 */

import { describe, expect, it } from 'bun:test';
import { handleBuilddAction, type ActionContext, type ApiFn } from '../mcp-tools';

function context(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workerId: 'worker-1',
    getWorkspaceId: async () => 'workspace-1',
    getLevel: async () => 'worker',
    ...overrides,
  };
}

function apiReturning(response: unknown): ApiFn {
  return (async () => response) as unknown as ApiFn;
}

function apiRecording(calls: Array<{ path: string; init: unknown }>, response: unknown): ApiFn {
  return (async (path: string, init?: unknown) => {
    calls.push({ path, init });
    return response;
  }) as unknown as ApiFn;
}

const CI_AND_REVIEWS = {
  checks: { total: 0, passed: 0, failed: 0, pending: 0, state: 'none' },
  reviews: { approved: 0, changesRequested: 0, pending: 0 },
};

describe('record_pr_supersession', () => {
  it('rejects when neither workerId nor prNumber is supplied and there is no worker context', async () => {
    const api = apiReturning({});
    await expect(
      handleBuilddAction(api, 'record_pr_supersession', { supersedingPrNumber: 2293, reason: 'x' }, context({ workerId: undefined })),
    ).rejects.toThrow(/workerId or prNumber/);
  });

  it('rejects when supersedingPrNumber is missing', async () => {
    const api = apiReturning({});
    await expect(
      handleBuilddAction(api, 'record_pr_supersession', { prNumber: 2287, reason: 'x' }, context()),
    ).rejects.toThrow(/supersedingPrNumber/);
  });

  it('rejects when reason is missing', async () => {
    const api = apiReturning({});
    await expect(
      handleBuilddAction(api, 'record_pr_supersession', { prNumber: 2287, supersedingPrNumber: 2293 }, context()),
    ).rejects.toThrow(/reason/);
  });

  it('calls POST /api/github/pr/supersede with the resolved params and reports the result', async () => {
    const calls: Array<{ path: string; init: any }> = [];
    const api = apiRecording(calls, {
      ok: true,
      supersededPrNumber: 2287,
      supersedingPrNumber: 2293,
      supersedingPrUrl: 'https://github.com/org/repo/pull/2293',
    });

    const result = await handleBuilddAction(
      api,
      'record_pr_supersession',
      { prNumber: 2287, supersedingPrNumber: 2293, reason: 'branch deleted; re-landed via #2293' },
      context({ workerId: undefined }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe('/api/github/pr/supersede');
    const body = JSON.parse(calls[0]!.init.body);
    expect(body).toMatchObject({
      prNumber: 2287,
      supersedingPrNumber: 2293,
      reason: 'branch deleted; re-landed via #2293',
    });

    const output = (result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(output).toContain('PR #2287 recorded as superseded by PR #2293');
    expect(output).toContain('https://github.com/org/repo/pull/2293');
  });

  it('includes both the implicit ctx.workerId and the explicit prNumber in the outgoing body', async () => {
    // Production calls always carry a real ctx.workerId — the caller's own worker.
    // This reproduces the exact request shape that triggered the 400: workerId and
    // prNumber both present, with server-side resolution (route.ts) responsible for
    // prioritizing prNumber over the implicitly-injected workerId.
    const calls: Array<{ path: string; init: any }> = [];
    const api = apiRecording(calls, {
      ok: true,
      supersededPrNumber: 2287,
      supersedingPrNumber: 2293,
      supersedingPrUrl: 'https://github.com/org/repo/pull/2293',
    });

    await handleBuilddAction(
      api,
      'record_pr_supersession',
      { prNumber: 2287, supersedingPrNumber: 2293, reason: 'branch deleted; re-landed via #2293' },
      context(),
    );

    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]!.init.body);
    expect(body.workerId).toBe('worker-1');
    expect(body.prNumber).toBe(2287);
  });
});

describe('get_pr renders a recorded supersession edge', () => {
  it('names the successor PR and reason on a closed, superseded PR', async () => {
    const api = apiReturning({
      ok: true,
      pr: {
        number: 2287,
        title: 'Slice A',
        body: null,
        state: 'closed_unmerged',
        url: 'https://github.com/org/repo/pull/2287',
        mergeable: null,
        mergeableState: null,
        headSha: 'sha',
        baseRef: 'mission/foo',
        additions: 10,
        deletions: 2,
        changedFiles: 1,
        generatedAdditions: 0,
        generatedDeletions: 0,
        generatedFiles: 0,
        mergedAt: null,
        mergeCommitSha: null,
        mergedBy: null,
        mergedVia: null,
        closedAt: '2026-09-10T00:00:00.000Z',
        supersededByPrNumber: 2293,
        supersededByPrUrl: 'https://github.com/org/repo/pull/2293',
        supersededReason: 'branch deleted out from under it',
      },
      ...CI_AND_REVIEWS,
    });

    const result = await handleBuilddAction(api, 'get_pr', { prNumber: 2287 }, context());
    const output = (result as { content: Array<{ text: string }> }).content[0]!.text;

    expect(output).toContain('Superseded by: PR #2293');
    expect(output).toContain('https://github.com/org/repo/pull/2293');
    expect(output).toContain('branch deleted out from under it');
  });

  it('flags a closed-unmerged PR with no recorded supersession, naming the remedy', async () => {
    const api = apiReturning({
      ok: true,
      pr: {
        number: 2289,
        title: 'Slice B',
        body: null,
        state: 'closed_unmerged',
        url: 'https://github.com/org/repo/pull/2289',
        mergeable: null,
        mergeableState: null,
        headSha: 'sha',
        baseRef: 'mission/foo',
        additions: 5,
        deletions: 1,
        changedFiles: 1,
        generatedAdditions: 0,
        generatedDeletions: 0,
        generatedFiles: 0,
        mergedAt: null,
        mergeCommitSha: null,
        mergedBy: null,
        mergedVia: null,
        closedAt: '2026-09-10T00:00:00.000Z',
        supersededByPrNumber: null,
        supersededByPrUrl: null,
        supersededReason: null,
      },
      ...CI_AND_REVIEWS,
    });

    const result = await handleBuilddAction(api, 'get_pr', { prNumber: 2289 }, context());
    const output = (result as { content: Array<{ text: string }> }).content[0]!.text;

    expect(output).toContain('no supersession recorded');
    expect(output).toContain('record_pr_supersession');
  });

  it('omits the superseded line entirely for an open PR', async () => {
    const api = apiReturning({
      ok: true,
      pr: {
        number: 1,
        title: 'Open work',
        body: null,
        state: 'open',
        url: 'https://github.com/org/repo/pull/1',
        mergeable: true,
        mergeableState: 'clean',
        headSha: 'sha',
        baseRef: 'dev',
        additions: 1,
        deletions: 1,
        changedFiles: 1,
        generatedAdditions: 0,
        generatedDeletions: 0,
        generatedFiles: 0,
        mergedAt: null,
        mergeCommitSha: null,
        mergedBy: null,
        mergedVia: null,
        closedAt: null,
        supersededByPrNumber: null,
        supersededByPrUrl: null,
        supersededReason: null,
      },
      ...CI_AND_REVIEWS,
    });

    const result = await handleBuilddAction(api, 'get_pr', { prNumber: 1 }, context());
    const output = (result as { content: Array<{ text: string }> }).content[0]!.text;

    expect(output).not.toContain('Superseded');
    expect(output).not.toContain('no supersession recorded');
  });
});

describe('get_task renders a recorded supersession edge on a worker', () => {
  it('names the successor PR under the worker line', async () => {
    const api = apiReturning({
      id: 'task-1',
      title: 'Rescue task',
      status: 'completed',
      priority: 5,
      workers: [{
        id: 'w-1',
        status: 'completed',
        branch: 'buildd/rescue',
        prUrl: 'https://github.com/org/repo/pull/2287',
        prNumber: 2287,
        supersededByPrNumber: 2293,
        supersededByPrUrl: 'https://github.com/org/repo/pull/2293',
        supersededReason: 'branch deleted out from under it',
      }],
      artifacts: [],
    });

    const result = await handleBuilddAction(api, 'get_task', { taskId: '11111111-1111-1111-1111-111111111111' }, context());
    const output = (result as { content: Array<{ text: string }> }).content[0]!.text;

    expect(output).toContain('Superseded by: PR #2293');
    expect(output).toContain('branch deleted out from under it');
  });
});
