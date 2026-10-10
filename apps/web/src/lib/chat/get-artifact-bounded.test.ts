import { describe, expect, it } from 'bun:test';
import { buildChatTools } from './tools';

// Chat's get_artifact runs the same handler as MCP (packages/core/mcp-tools.ts),
// so a long document comes back as an outline and is read part by part.
const ID = '11111111-1111-4111-8111-111111111111';

function setup(artifact: Record<string, unknown>) {
  const calls: string[] = [];
  const tools = buildChatTools({
    ctx: { getWorkspaceId: async () => 'ws', getLevel: async () => 'worker' } as any,
    allowWrites: false,
    authorizedToolCallIds: new Set(),
    onMissionFiled: async () => {},
    makeApi: (onCall) => async (endpoint: string, init?: RequestInit) => {
      calls.push(endpoint);
      const body = { artifact: { id: ID, title: 'Manual', type: 'content', createdAt: 'x', updatedAt: 'y', currentRevision: 1, ...artifact } };
      onCall({ method: init?.method ?? 'GET', path: endpoint.split('?')[0], status: 200, body });
      return body;
    },
  } as any);
  const run = (input: unknown) => (tools.get_artifact as any).execute(input, { toolCallId: 'c1', messages: [] });
  return { tools, run, calls };
}

describe('chat get_artifact: bounded reads', () => {
  it('asks for view=auto by default and renders an outline instead of the whole body', async () => {
    const { run, calls } = setup({ content: null, read: { view: 'outline', chars: 650_000, sections: [{ id: 's2', level: 2, title: 'Rotating credentials', chars: 16_500 }] } });
    const out = await run({ artifactId: ID });
    expect(calls).toEqual([`/api/artifacts/${ID}?view=auto`]);
    expect(String(out.data)).toContain('s2: Rotating credentials (16,500 chars)');
  });

  it('passes a section read through', async () => {
    const { run, calls } = setup({ content: null, read: { view: 'section', chars: 9, section: { id: 's2', title: 'B', chars: 3 }, text: 'abc', truncated: false } });
    const out = await run({ artifactId: ID, view: 'section', section: 's2' });
    expect(calls).toEqual([`/api/artifacts/${ID}?view=section&section=s2`]);
    expect(String(out.data)).toContain('## Section s2: B');
  });
});
