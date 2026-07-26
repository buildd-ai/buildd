import { describe, it, expect, mock } from 'bun:test';
import { processLinearWebhook } from './route';

// DI core test — NO mock.module. All boundaries are injected, so this file leaks
// nothing into sibling test files (the bun mock.module global-leak class).

const fakeDb = {} as any;
const linearWs = { teamId: 'team-1', workTrackerConfig: { provider: 'linear', inboundLabel: 'buildd' } };

const validBody = JSON.stringify({
  type: 'Issue',
  action: 'update',
  data: { id: 'uuid-1', title: 'T', url: 'https://linear.app/x', labels: [{ name: 'buildd' }] },
});

describe('processLinearWebhook', () => {
  it('404 when the workspace is unknown (handler never runs)', async () => {
    const handle = mock(async () => ({ action: 'created' as const }));
    const res = await processLinearWebhook(
      fakeDb,
      { workspaceId: 'ws-x', rawBody: validBody, signature: 'sig' },
      { getWorkspace: async () => undefined as any, verify: async () => true, handle },
    );
    expect(res.status).toBe(404);
    expect(handle).not.toHaveBeenCalled();
  });

  it('401 when the workspace has no webhook secret configured', async () => {
    const res = await processLinearWebhook(
      fakeDb,
      { workspaceId: 'ws-1', rawBody: validBody, signature: 'sig' },
      { getWorkspace: async () => linearWs as any, getSigningSecret: async () => null },
    );
    expect(res.status).toBe(401);
  });

  it('401 on a bad signature — no mutation (AC-4)', async () => {
    const handle = mock(async () => ({ action: 'created' as const }));
    const res = await processLinearWebhook(
      fakeDb,
      { workspaceId: 'ws-1', rawBody: validBody, signature: 'bad' },
      {
        getWorkspace: async () => linearWs as any,
        getSigningSecret: async () => 'shh',
        verify: async () => false,
        handle,
      },
    );
    expect(res.status).toBe(401);
    expect(handle).not.toHaveBeenCalled();
  });

  it('200 no-op when the workspace is not Linear-tracked (handler never runs)', async () => {
    const handle = mock(async () => ({ action: 'created' as const }));
    const res = await processLinearWebhook(
      fakeDb,
      { workspaceId: 'ws-1', rawBody: validBody, signature: 'sig' },
      {
        getWorkspace: async () => ({ teamId: 'team-1', workTrackerConfig: { provider: 'github' } }) as any,
        getSigningSecret: async () => 'shh',
        verify: async () => true,
        handle,
      },
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ action: 'ignored', reason: 'provider' });
    expect(handle).not.toHaveBeenCalled();
  });

  it('200 + dispatches a parsed label event to the handler on a valid delivery', async () => {
    const handle = mock(async () => ({ action: 'created' as const, taskId: 't-1' }));
    const res = await processLinearWebhook(
      fakeDb,
      { workspaceId: 'ws-1', rawBody: validBody, signature: 'sig' },
      { getWorkspace: async () => linearWs as any, getSigningSecret: async () => 'shh', verify: async () => true, handle },
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, action: 'created', taskId: 't-1' });
    expect(handle).toHaveBeenCalledWith(
      fakeDb,
      { workspaceId: 'ws-1', teamId: 'team-1' },
      expect.objectContaining({ kind: 'label', issueId: 'uuid-1' }),
    );
  });

  it('401 on a stale delivery (replay guard)', async () => {
    const stale = JSON.stringify({ type: 'Issue', action: 'update', data: { id: 'u' }, webhookTimestamp: 1000 });
    const res = await processLinearWebhook(
      fakeDb,
      { workspaceId: 'ws-1', rawBody: stale, signature: 'sig' },
      {
        getWorkspace: async () => linearWs as any,
        getSigningSecret: async () => 'shh',
        verify: async () => true,
        now: () => 10_000_000,
      },
    );
    expect(res.status).toBe(401);
  });

  it('400 on an unparseable body', async () => {
    const res = await processLinearWebhook(
      fakeDb,
      { workspaceId: 'ws-1', rawBody: 'not json', signature: 'sig' },
      { getWorkspace: async () => linearWs as any, getSigningSecret: async () => 'shh', verify: async () => true },
    );
    expect(res.status).toBe(400);
  });
});
