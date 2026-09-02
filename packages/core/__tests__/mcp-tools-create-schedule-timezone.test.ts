/**
 * create_schedule MUST NOT pin an agent-created schedule to UTC.
 *
 * Regression: the MCP client sent `timezone: params.timezone || 'UTC'`, so the
 * schedules route never saw an absent timezone and its team-zone default could
 * never fire. Every schedule an agent created ran on a wall clock nobody on the
 * team uses. See docs/specs/timezone-resolution.md.
 */
import { describe, it, expect, mock } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';

const WS_ID = '00000000-0000-0000-0000-000000000001';

function ctx(): ActionContext {
  return {
    workspaceId: WS_ID,
    getWorkspaceId: async () => WS_ID,
    getLevel: async () => 'admin',
  };
}

/** Returns the JSON body POSTed to the schedules route. */
async function capturePostBody(params: Record<string, unknown>) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const api = mock(async (path: string, options?: RequestInit) => {
    calls.push({
      path,
      body: options?.body ? JSON.parse(options.body as string) : {},
    });
    return {
      schedule: {
        id: 'sched_1',
        name: 'nightly',
        cronExpression: '0 3 * * *',
        timezone: 'America/New_York',
        nextRunAt: null,
        taskTemplate: { title: 'do the thing' },
      },
    };
  }) as unknown as ApiFn;

  const result = await handleBuilddAction(api, 'create_schedule', params, ctx());
  expect(result.isError).toBeFalsy();

  const post = calls.find((c) => c.path.includes('/schedules'));
  if (!post) throw new Error(`No POST to /schedules. Calls: ${JSON.stringify(calls)}`);
  return post.body;
}

const BASE = { name: 'nightly', cronExpression: '0 3 * * *', title: 'do the thing', workspaceId: WS_ID };

describe('create_schedule timezone passthrough', () => {
  it('omits timezone entirely when the caller gave none, so the team zone applies', async () => {
    const body = await capturePostBody({ ...BASE });
    expect('timezone' in body).toBe(false);
    expect(body.timezone).toBeUndefined();
  });

  it('never substitutes UTC for an absent timezone', async () => {
    const body = await capturePostBody({ ...BASE });
    expect(body.timezone).not.toBe('UTC');
  });

  it('forwards an explicitly requested zone unchanged', async () => {
    const body = await capturePostBody({ ...BASE, timezone: 'Europe/Berlin' });
    expect(body.timezone).toBe('Europe/Berlin');
  });

  it('forwards an explicit UTC request unchanged', async () => {
    const body = await capturePostBody({ ...BASE, timezone: 'UTC' });
    expect(body.timezone).toBe('UTC');
  });
});
