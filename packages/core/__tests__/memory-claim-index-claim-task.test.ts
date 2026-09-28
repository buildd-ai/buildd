/**
 * claim_task "Relevant Memory" under index injection (task caa30c0f). Flag off
 * is pinned by memory-read-golden.test.ts; this pins flag on, and that an
 * explicit `false` is the same as absent.
 */
import { describe, it, expect, mock } from 'bun:test';
import { handleBuilddAction, type ActionContext } from '../mcp-tools';
import { MEMORY_INDEX_HEADER } from '../memory-claim-index';

mock.module('../memory-scope', () => ({
  resolveMemoryProjectKey: async () => 'acme/widgets',
  resolveMemoryHitScope: async () => null,
}));

const WS = 'aaaa0000-0000-0000-0000-000000000000';
const TEAM = 'bbbb0000-0000-0000-0000-000000000000';
const M1 = '1a2b3c4d-0000-4000-8000-000000000001';
const M2 = '2b3c4d5e-0000-4000-8000-000000000002';
const M3 = '3c4d5e6f-0000-4000-8000-000000000003';

async function claim(gitConfig: Record<string, unknown> | undefined, context?: Record<string, unknown>) {
  const memories = [
    { id: M2, type: 'pattern', title: 'Second', content: 'x'.repeat(250) },
    { id: M1, type: 'gotcha', title: 'First', content: 'short' },
  ];
  const search = mock(async (_q: any) => ({ results: [{ id: M1 }, { id: M2 }], total: 2 }));
  const batch = mock(async (_ids: string[]) => ({ memories }));
  const api = mock(async (endpoint: string) => {
    if (endpoint === '/api/workers/claim') {
      return {
        workers: [{
          id: 'worker-1',
          taskId: 'task-1',
          branch: 'buildd/x',
          openPRs: [],
          task: {
            id: 'task-1', title: 'Fix the login bug', description: 'd', workspaceId: WS,
            ...(context ? { context } : {}),
            workspace: { id: WS, teamId: TEAM, repo: 'https://github.com/Acme/Widgets.git', name: 'widgets', dataClass: 'standard', ...(gitConfig ? { gitConfig } : {}) },
          },
        }],
      };
    }
    return {};
  });
  const actx: ActionContext = {
    workspaceId: WS,
    authType: 'api',
    getWorkspaceId: async () => WS,
    getLevel: async () => 'worker',
    getMemoryClient: async () => ({ search, batch }) as any,
    memoryLedger: () => {},
  };
  const res = await handleBuilddAction(api as any, 'claim_task', {}, actx);
  return res.content[0].text as string;
}

describe('claim_task Relevant Memory, index injection', () => {
  it('flag false renders exactly what an absent flag renders', async () => {
    expect(await claim({ memoryIndexInjection: false })).toBe(await claim(undefined));
  });

  it('flag on renders one header and one line per memory, no bodies', async () => {
    const text = await claim({ memoryIndexInjection: true });
    expect(text).toContain(`## Relevant Memory\n${MEMORY_INDEX_HEADER}\n- pattern m:2b3c4d5e Second (title)\n- gotcha m:1a2b3c4d First (title)`);
    expect(text).not.toContain('xxxxxxxxxx');
    expect(text).not.toContain('READ these memories');
    expect(text.split(MEMORY_INDEX_HEADER)).toHaveLength(2);
  });

  it('merges the claim-time entries first and dedupes the search against them', async () => {
    const text = await claim({ memoryIndexInjection: true }, {
      memoryIndex: [
        { id: M3, type: 'decision', title: 'Claim-time hit', why: 'path' },
        { id: M1, type: 'gotcha', title: 'First', why: 'path' },
      ],
    });
    expect(text).toContain([
      MEMORY_INDEX_HEADER,
      '- decision m:3c4d5e6f Claim-time hit (path)',
      '- gotcha m:1a2b3c4d First (path)',
      '- pattern m:2b3c4d5e Second (title)',
    ].join('\n'));
    expect(text.match(/m:1a2b3c4d/g)).toHaveLength(1);
  });

  it('honours the workspace budget', async () => {
    const text = await claim({ memoryIndexInjection: true, memoryIndexTokenBudget: 40 });
    expect(text).toContain('m:2b3c4d5e');
    expect(text).not.toContain('m:1a2b3c4d');
  });
});
