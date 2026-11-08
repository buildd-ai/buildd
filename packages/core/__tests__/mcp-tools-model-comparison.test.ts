import { describe, it, expect, mock } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';

const WS = '00000000-0000-0000-0000-000000000001';
const ctx = (): ActionContext => ({
  workspaceId: WS, workerId: '00000000-0000-0000-0000-000000000002', authType: 'oauth',
  getWorkspaceId: async () => WS, getLevel: async () => 'admin',
});

describe('get_model_comparison', () => {
  it('passes the filters through to the comparison route and scopes to the workspace', async () => {
    const api = mock(async (_p: string) => ({ totals: { attempts: 2 }, autoPromote: false, configs: [] }));
    const res = await handleBuilddAction(api as unknown as ApiFn, 'get_model_comparison',
      { model: 'opus', harness: 'h1', hardware: '4090', taskType: 'engineering', window: '7d' }, ctx());
    expect(res.isError).toBeFalsy();
    const url = new URL(`http://x${api.mock.calls[0][0]}`);
    expect(url.pathname).toBe('/api/model-comparison');
    expect(url.searchParams.get('workspaceId')).toBe(WS);
    expect(url.searchParams.get('model')).toBe('opus');
    expect(url.searchParams.get('hardware')).toBe('4090');
    const body = JSON.parse(res.content[0].text as string);
    expect(body.status).toBe('OK');
    expect(body.autoPromote).toBe(false);
  });

  it('says NO_DATA rather than zero when there are no attempts', async () => {
    const api = mock(async () => ({ totals: { attempts: 0 }, configs: [] }));
    const res = await handleBuilddAction(api as unknown as ApiFn, 'get_model_comparison', {}, ctx());
    expect(JSON.parse(res.content[0].text as string).status).toBe('NO_DATA');
  });

  it('rejects an unknown window without calling the API', async () => {
    const api = mock(async () => ({}));
    const res = await handleBuilddAction(api as unknown as ApiFn, 'get_model_comparison', { window: '1y' }, ctx());
    expect(res.isError).toBe(true);
    expect(api).not.toHaveBeenCalled();
  });
});
