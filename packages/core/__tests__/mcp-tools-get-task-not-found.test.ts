import { describe, it, expect } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';

const ctx: ActionContext = { authType: 'oauth', getWorkspaceId: async () => null, getLevel: async () => 'worker' };
const ID = 'aaaaaaaa-1111-4111-8111-111111111111';

async function outcome(api: ApiFn) {
  try {
    const r = await handleBuilddAction(api, 'get_task', { taskId: ID }, ctx);
    return String(r.content[0].text);
  } catch (e) {
    return (e as Error).message;
  }
}

describe('get_task on an id that is not a task', () => {
  // Agents read a mission list (ID: …) and hand the mission id to get_task.
  it('a 404 points at manage_missions get, so the next call is the right one', async () => {
    const msg = await outcome(async () => { throw new Error('API error: 404 - {"error":"Task not found"}'); });
    expect(msg).toContain('404');
    expect(msg).toContain('manage_missions');
  });

  it('other errors pass through unchanged', async () => {
    const msg = await outcome(async () => { throw new Error('API error: 500 - boom'); });
    expect(msg).toBe('API error: 500 - boom');
  });
});
