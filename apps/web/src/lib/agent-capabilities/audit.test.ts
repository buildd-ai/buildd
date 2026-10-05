import { describe, it, expect, mock } from 'bun:test';
import { recordCapabilityDecision } from './audit';

const WS = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';

describe('recordCapabilityDecision', () => {
  it('writes the decision with ids, labels and expiry', async () => {
    const insert = mock(async (_v: Record<string, unknown>) => {});
    const expiresAt = new Date('2026-01-01T01:00:00Z');
    await recordCapabilityDecision({
      capability: 'github.repo_grant', decision: 'allowed', workspaceId: WS, taskId: TASK,
      principalVia: 'dispatch', resource: 'github_repo:row-1', expiresAt,
    }, { insert });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0][0]).toMatchObject({
      capability: 'github.repo_grant', decision: 'allowed', workspaceId: WS, taskId: TASK,
      principalVia: 'dispatch', resource: 'github_repo:row-1', expiresAt, reasonCode: null,
    });
  });

  it('drops a value that is not an id rather than risk a foreign-key failure', async () => {
    const insert = mock(async (_v: Record<string, unknown>) => {});
    await recordCapabilityDecision({ capability: 'task_token.mint', decision: 'refused', taskId: 'not-a-uuid', reasonCode: 'not_found' }, { insert });
    expect(insert.mock.calls[0][0].taskId).toBeNull();
  });

  it('never throws, whatever the write does', async () => {
    const insert = mock(async () => { throw new Error('db down'); });
    await expect(recordCapabilityDecision({ capability: 'pr.merge', decision: 'refused' }, { insert })).resolves.toBeUndefined();
    const syncThrow = mock(() => { throw new Error('no insert'); });
    await expect(recordCapabilityDecision({ capability: 'pr.merge', decision: 'refused' }, { insert: syncThrow as any })).resolves.toBeUndefined();
  });

  it('has no field a credential could travel in', async () => {
    const insert = mock(async (_v: Record<string, unknown>) => {});
    await recordCapabilityDecision({ capability: 'model.endpoint', decision: 'allowed', ...({ token: 'bldt_x', key: 'k' } as any) }, { insert });
    const written = JSON.stringify(insert.mock.calls[0][0]);
    expect(written).not.toContain('bldt_x');
    expect(Object.keys(insert.mock.calls[0][0]).sort()).toEqual([
      'accountId', 'capability', 'decision', 'expiresAt', 'principalVia', 'reasonCode', 'resource', 'sideEffect', 'taskId', 'workerId', 'workspaceId',
    ]);
  });
});
