import { describe, it, expect } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';

const ctx: ActionContext = { authType: 'oauth', getWorkspaceId: async () => null, getLevel: async () => 'worker' };
const neverCalled: ApiFn = async () => { throw new Error('api should not be called'); };

async function outcome(action: string, params: Record<string, unknown>) {
  try {
    const r = await handleBuilddAction(neverCalled, action, params, ctx);
    return String(r.content[0].text);
  } catch (e) {
    return (e as Error).message;
  }
}

// The legacy single-tool surface documents the artifactId param only in prose
// inside a long params description, not as a JSON-schema field — an agent
// reaching for the generic "id" (right call for memory_delete, get_task, etc.
// use their own entity-named id) gets a bare "artifactId is required" with no
// pointer back to the name it should have used.
describe('get_artifact / update_artifact: wrong id param name', () => {
  it('get_artifact names the correct param when called with id instead of artifactId', async () => {
    const msg = await outcome('get_artifact', { id: 'some-id' });
    expect(msg).toContain('artifactId');
    expect(msg).toContain('id');
  });

  it('get_artifact still reports a plain miss with no params at all', async () => {
    const msg = await outcome('get_artifact', {});
    expect(msg).toBe('artifactId is required');
  });

  it('update_artifact names the correct param when called with id instead of artifactId', async () => {
    const msg = await outcome('update_artifact', { id: 'some-id', title: 'x' });
    expect(msg).toContain('artifactId');
  });
});
