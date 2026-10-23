import { describe, expect, it, mock } from 'bun:test';
import { handleBuilddAction, type ActionContext, type ApiFn } from '../mcp-tools';

// Spec e28018c2 R-20: update_task carries dependsOn to PATCH /api/tasks/[id],
// which decides reach and cycles. Made-up ids.
const TASK_ID = '11111111-1111-4111-8111-111111111111';
const UPSTREAM = '22222222-2222-4222-8222-222222222222';

const ctx: ActionContext = {
  workspaceId: 'ws-1',
  getWorkspaceId: async () => 'ws-1',
  getLevel: async () => 'worker',
};

describe('update_task dependsOn', () => {
  it('sends the whole new list, an empty one included', async () => {
    const api = mock(() => Promise.resolve({ id: TASK_ID, title: 'Write the docs', status: 'pending', priority: 5 }));
    await handleBuilddAction(api as unknown as ApiFn, 'update_task', { taskId: TASK_ID, dependsOn: [UPSTREAM] }, ctx);
    expect(JSON.parse((api.mock.calls[0] as any[])[1].body)).toEqual({ dependsOn: [UPSTREAM] });

    await handleBuilddAction(api as unknown as ApiFn, 'update_task', { taskId: TASK_ID, dependsOn: [] }, ctx);
    expect(JSON.parse((api.mock.calls[1] as any[])[1].body)).toEqual({ dependsOn: [] });
  });
});
