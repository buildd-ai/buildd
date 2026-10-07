import { describe, expect, it, mock } from 'bun:test';
import { handleBuilddAction, type ActionContext, type ApiFn } from '../mcp-tools';

const ctx: ActionContext = {
  workspaceId: 'ws-1',
  getWorkspaceId: async () => 'ws-1',
  getLevel: async () => 'worker',
};

describe('update_task pathManifest', () => {
  it('rejects pathManifest with a pointer to check_path_claim, without calling the API', async () => {
    const api = mock(() => Promise.resolve({}));
    await expect(
      handleBuilddAction(
        api as unknown as ApiFn,
        'update_task',
        { taskId: '11111111-1111-1111-1111-111111111111', pathManifest: ['apps/web/src/a.ts'] },
        ctx,
      ),
    ).rejects.toThrow('check_path_claim');
    expect(api).not.toHaveBeenCalled();
  });
});
