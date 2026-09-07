/**
 * Regression: release_status and trigger_release must resolve workspace names
 * (e.g. "buildd") to UUIDs before calling the API. Without this, the API
 * receives a non-UUID string as workspaceId, Postgres throws
 * "invalid input syntax for type uuid: 'buildd'", and the route returns
 * 500 with an empty body.
 */
import { describe, it, expect, mock } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';

const WORKSPACE_UUID = '11111111-2222-3333-4444-555555555555';
const WORKSPACE_NAME = 'buildd';

function adminContext(): ActionContext {
  return {
    workspaceId: WORKSPACE_UUID,
    getWorkspaceId: async () => WORKSPACE_UUID,
    getLevel: async () => 'admin',
  };
}

function makeApi(handler: (url: string, opts?: any) => any): ApiFn {
  return mock(async (url: string, opts?: any) => handler(url, opts)) as unknown as ApiFn;
}

// Typical API mock: resolves workspace by name → returns UUID in list
function workspaceListApi(preflightData: Record<string, unknown> = {}): {
  api: ApiFn;
  calls: Array<{ url: string; opts?: any }>;
} {
  const calls: Array<{ url: string; opts?: any }> = [];
  const api = makeApi((url, opts) => {
    calls.push({ url, opts });
    if (url === '/api/workspaces') {
      return {
        workspaces: [{ id: WORKSPACE_UUID, name: WORKSPACE_NAME, repo: `buildd-ai/${WORKSPACE_NAME}` }],
      };
    }
    if (url.startsWith('/api/releases/status')) {
      return { ok: true, repo: 'buildd-ai/buildd', ref: 'dev', prodBranch: 'main', aheadBy: 2, shippableCommits: [], ciState: 'passing', failingChecks: [], ...preflightData };
    }
    if (url.startsWith('/api/releases/trigger')) {
      return { ok: true, repo: 'buildd-ai/buildd', workflowFile: 'release.yml', ref: 'dev', dispatched: true, runsUrl: 'https://github.com/buildd-ai/buildd/actions' };
    }
    throw new Error(`Unexpected API call: ${url}`);
  });
  return { api, calls };
}

describe('release_status — workspace name resolution', () => {
  it('resolves workspace name to UUID before calling /api/releases/status', async () => {
    const { api, calls } = workspaceListApi();

    const result = await handleBuilddAction(api, 'release_status', {
      workspaceId: WORKSPACE_NAME,
      ref: 'dev',
      prodBranch: 'main',
    }, adminContext());

    // Should have resolved the workspace name
    const statusCall = calls.find(c => c.url.startsWith('/api/releases/status'));
    expect(statusCall).toBeTruthy();
    // Must pass UUID, not the workspace name
    expect(statusCall!.url).toContain(`workspaceId=${WORKSPACE_UUID}`);
    expect(statusCall!.url).not.toContain(`workspaceId=${WORKSPACE_NAME}`);

    // Result should contain the preflight text
    const text = result?.content?.[0]?.text ?? '';
    expect(text).toContain('buildd-ai/buildd');
  });

  it('passes UUID through unchanged without extra /api/workspaces call', async () => {
    const { api, calls } = workspaceListApi();

    await handleBuilddAction(api, 'release_status', {
      workspaceId: WORKSPACE_UUID,
      ref: 'dev',
    }, adminContext());

    // Should NOT call /api/workspaces when a UUID is already provided
    expect(calls.find(c => c.url === '/api/workspaces')).toBeUndefined();

    const statusCall = calls.find(c => c.url.startsWith('/api/releases/status'));
    expect(statusCall!.url).toContain(`workspaceId=${WORKSPACE_UUID}`);
  });

  it('throws a clean error when workspace name cannot be resolved and no repo provided', async () => {
    const api = makeApi((url) => {
      if (url === '/api/workspaces') return { workspaces: [] };
      throw new Error(`Unexpected: ${url}`);
    });

    const err = await handleBuilddAction(api, 'release_status', {
      workspaceId: 'nonexistent-workspace',
    }, adminContext()).catch(e => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/could not resolve workspace/i);
  });

  it('falls back to repo param when workspace name cannot be resolved', async () => {
    const { api, calls } = workspaceListApi();

    // Override workspaces list to return nothing
    const emptyApi = makeApi((url, opts) => {
      if (url === '/api/workspaces') return { workspaces: [] };
      if (url.startsWith('/api/releases/status')) {
        return { ok: true, repo: 'buildd-ai/buildd', ref: 'dev', prodBranch: 'main', aheadBy: 0, shippableCommits: [], ciState: 'passing', failingChecks: [] };
      }
      throw new Error(`Unexpected: ${url}`);
    });

    const result = await handleBuilddAction(emptyApi, 'release_status', {
      workspaceId: 'nonexistent',
      repo: 'buildd-ai/buildd',
    }, adminContext());

    expect(result?.content?.[0]?.text).toContain('buildd-ai/buildd');
  });
});

describe('trigger_release — workspace name resolution', () => {
  it('resolves workspace name to UUID before calling /api/releases/trigger', async () => {
    const calls: Array<{ url: string; opts?: any }> = [];
    const api = makeApi((url, opts) => {
      calls.push({ url, opts });
      if (url === '/api/workspaces') {
        return { workspaces: [{ id: WORKSPACE_UUID, name: WORKSPACE_NAME, repo: `buildd-ai/${WORKSPACE_NAME}` }] };
      }
      if (url === '/api/releases/trigger') {
        return { ok: true, repo: 'buildd-ai/buildd', workflowFile: 'release.yml', ref: 'dev', dispatched: true, runsUrl: 'https://github.com/buildd-ai/buildd/actions' };
      }
      throw new Error(`Unexpected: ${url}`);
    });

    await handleBuilddAction(api, 'trigger_release', {
      workspaceId: WORKSPACE_NAME,
    }, adminContext());

    const triggerCall = calls.find(c => c.url === '/api/releases/trigger');
    expect(triggerCall).toBeTruthy();
    const body = JSON.parse(triggerCall!.opts.body);
    expect(body.workspaceId).toBe(WORKSPACE_UUID);
    expect(body.workspaceId).not.toBe(WORKSPACE_NAME);
  });

  it('passes UUID through unchanged without extra /api/workspaces call', async () => {
    const calls: Array<{ url: string; opts?: any }> = [];
    const api = makeApi((url, opts) => {
      calls.push({ url, opts });
      if (url === '/api/releases/trigger') {
        return { ok: true, repo: 'buildd-ai/buildd', workflowFile: 'release.yml', ref: 'dev', dispatched: true, runsUrl: 'https://github.com/buildd-ai/buildd/actions' };
      }
      throw new Error(`Unexpected: ${url}`);
    });

    await handleBuilddAction(api, 'trigger_release', {
      workspaceId: WORKSPACE_UUID,
    }, adminContext());

    expect(calls.find(c => c.url === '/api/workspaces')).toBeUndefined();
    const body = JSON.parse(calls.find(c => c.url === '/api/releases/trigger')!.opts.body);
    expect(body.workspaceId).toBe(WORKSPACE_UUID);
  });
});

/**
 * Regression: a deduped response (same headSha already in flight) or a
 * response missing workflowFile/ref must never be reported as "Release
 * dispatched" — that read as success on a call that dispatched nothing and
 * put literal "undefined" in the confirmation string.
 */
describe('trigger_release — deduped / incomplete response formatting', () => {
  it('reports "not dispatched" for a deduped response instead of claiming success', async () => {
    const api = makeApi((url) => {
      if (url === '/api/releases/trigger') {
        return { ok: true, strategy: 'workflow_dispatch', repo: 'buildd-ai/buildd', releaseId: 'existing-release-id', deduped: true };
      }
      throw new Error(`Unexpected: ${url}`);
    });

    const result = await handleBuilddAction(api, 'trigger_release', {
      workspaceId: WORKSPACE_UUID,
      force: true,
    }, adminContext());

    const text = result?.content?.[0]?.text ?? '';
    expect(text).not.toContain('dispatched on');
    expect(text).not.toContain('undefined');
    expect(text.toLowerCase()).toContain('not dispatched');
    expect(text).toContain('existing-release-id');
  });

  it('treats a response missing workflowFile/ref as failed, not a silent success', async () => {
    const api = makeApi((url) => {
      if (url === '/api/releases/trigger') {
        return { ok: true, strategy: 'workflow_dispatch', repo: 'buildd-ai/buildd' };
      }
      throw new Error(`Unexpected: ${url}`);
    });

    const result = await handleBuilddAction(api, 'trigger_release', {
      workspaceId: WORKSPACE_UUID,
    }, adminContext());

    expect(result?.isError).toBe(true);
    const text = result?.content?.[0]?.text ?? '';
    expect(text).not.toContain('Release dispatched');
    expect(text).not.toContain('undefined');
  });
});
