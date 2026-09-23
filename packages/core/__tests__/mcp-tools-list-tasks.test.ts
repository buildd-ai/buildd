import { describe, it, expect, mock } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';

// list_tasks used to hardcode `status=active` in its REST call, so a caller
// auditing completed work (e.g. a fallback-completion sweep) had no way to
// reach terminal tasks through this action at all — see the friction report
// this fixes. These tests cover the status passthrough and the terminal-audit
// row formatting (summarySource / PR / artifact attribution).

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    authType: 'api',
    workspaceId: 'ws-1',
    getWorkspaceId: async () => 'ws-1',
    getLevel: async () => 'worker',
    ...overrides,
  };
}

describe('list_tasks — status passthrough', () => {
  it('defaults to status=active when no status param is given', async () => {
    const api = mock(async () => ({ tasks: [], total: 0, pendingCount: 0, hasMore: false })) as unknown as ApiFn;

    await handleBuilddAction(api, 'list_tasks', {}, ctx());

    const calledUrl = (api as any).mock.calls[0][0] as string;
    expect(calledUrl).toContain('status=active');
  });

  it('passes an explicit terminal status through to the REST call', async () => {
    const api = mock(async () => ({ tasks: [], total: 0, pendingCount: 0, hasMore: false })) as unknown as ApiFn;

    const result = await handleBuilddAction(api, 'list_tasks', { status: 'completed' }, ctx());

    const calledUrl = (api as any).mock.calls[0][0] as string;
    expect(calledUrl).toContain('status=completed');
    expect(result.content[0].text).toBe('No completed tasks found.');
  });

  it('falls back to active for an out-of-vocabulary status value', async () => {
    const api = mock(async () => ({ tasks: [], total: 0, pendingCount: 0, hasMore: false })) as unknown as ApiFn;

    await handleBuilddAction(api, 'list_tasks', { status: 'bogus' }, ctx());

    const calledUrl = (api as any).mock.calls[0][0] as string;
    expect(calledUrl).toContain('status=active');
  });

  it('formats terminal rows with summarySource and deliverable attribution, no claim hint', async () => {
    const api = mock(async () => ({
      tasks: [
        {
          id: 't1', title: 'Fallback completion, no PR', status: 'completed', category: 'bug',
          descriptionPreview: 'desc', updatedAt: '2026-09-14T00:00:00.000Z',
          summarySource: 'fallback', prNumber: null, hasArtifact: false,
        },
        {
          id: 't2', title: 'Real fix', status: 'completed', category: 'bug',
          descriptionPreview: 'desc', updatedAt: '2026-09-14T00:00:00.000Z',
          summarySource: 'agent', prNumber: 42, hasArtifact: false,
        },
      ],
      total: 2, pendingCount: 0, hasMore: false,
    })) as unknown as ApiFn;

    const result = await handleBuilddAction(api, 'list_tasks', { status: 'completed' }, ctx());
    const out = result.content[0].text;

    expect(out).toContain('2 completed tasks:');
    expect(out).toContain('summary:fallback');
    expect(out).toContain('no-deliverable');
    expect(out).toContain('summary:agent');
    expect(out).toContain('PR #42');
    expect(out).not.toContain('action=claim_task');
  });

  it('active-mode formatting is unchanged (pending/in-progress header, claim hint)', async () => {
    const api = mock(async () => ({
      tasks: [
        { id: 't1', title: 'Do the thing', status: 'pending', category: null, descriptionPreview: 'desc' },
      ],
      total: 1, pendingCount: 1, hasMore: false,
    })) as unknown as ApiFn;

    const result = await handleBuilddAction(api, 'list_tasks', {}, ctx());
    const out = result.content[0].text;

    expect(out).toContain('1 active task (1 pending, 0 in progress):');
    expect(out).toContain('action=claim_task');
    expect(out).not.toContain('summary:');
  });
});

// list_tasks used to hardcode limit=5 regardless of what the caller asked
// for, even though the underlying REST route accepts up to 200 — a caller
// auditing more than 5 tasks had no way to widen the page through this
// action at all.
describe('list_tasks — limit param', () => {
  async function limitPassedThrough(params: Record<string, unknown>): Promise<string> {
    const api = mock(async () => ({ tasks: [], total: 0, pendingCount: 0, hasMore: false })) as unknown as ApiFn;
    await handleBuilddAction(api, 'list_tasks', params, ctx());
    const calledUrl = (api as any).mock.calls[0][0] as string;
    return new URL(calledUrl, 'http://x').searchParams.get('limit')!;
  }

  it('passes an explicit in-range limit through unchanged', async () => {
    expect(await limitPassedThrough({ limit: 20 })).toBe('20');
  });

  it('clamps an above-max limit down to 50', async () => {
    expect(await limitPassedThrough({ limit: 500 })).toBe('50');
  });

  it('defaults to 5 when limit is omitted', async () => {
    expect(await limitPassedThrough({})).toBe('5');
  });

  it('defaults to 5 for a non-numeric limit', async () => {
    expect(await limitPassedThrough({ limit: 'lots' })).toBe('5');
  });

  it('clamps a below-min limit up to 1', async () => {
    expect(await limitPassedThrough({ limit: 0 })).toBe('1');
  });
});
