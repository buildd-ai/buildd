/**
 * attachAgentEndpoints: the §2 winner is attached, and only the winner
 * (docs/design/agent-model-endpoint.md). The ranking itself is tested in
 * packages/core/__tests__/agent-endpoint-resolve.test.ts; this pins what the
 * claim does with each decision. Fixtures are illustrative.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { AgentModelDecision } from '@buildd/core/agent-endpoint';

const { attachAgentEndpoints } = await import('./agent-endpoint-injection');

const endpoint = {
  kind: 'anthropic-compatible' as const, baseUrl: 'https://litellm.example.com', apiKey: 'sk-agent-example',
  authHeader: 'authorization' as const, models: { 'claude-sonnet-5': 'team-sonnet' }, secretId: 's-1', scope: 'team' as const,
};
const win: AgentModelDecision = { winner: 'endpoint', endpoint };
const lose: AgentModelDecision = { winner: 'anthropic', endpoint, beatenBy: 'workspace' };

function claim(backend?: string) {
  const task = { id: 'task-1', workspaceId: 'ws-1', backend, workspace: { teamId: 'team-1' } };
  const workers = [{ id: 'worker-1', taskId: 'task-1', task }] as any[];
  return { workers, tasks: [task] };
}

const origKey = process.env.ENCRYPTION_KEY;
beforeEach(() => { process.env.ENCRYPTION_KEY = 'test-key'; });
afterEach(() => { if (origKey === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = origKey; });

describe('attachAgentEndpoints', () => {
  it('endpoint wins: attaches modelEndpoint and reports the worker so nothing else is attached', async () => {
    const { workers, tasks } = claim();
    const resolve = mock(async () => win);
    const won = await attachAgentEndpoints(workers, tasks, 'acc-1', { llmProviderOverride: false, runnerSupportsEndpoint: true }, { resolve });
    expect([...won]).toEqual(['worker-1']);
    expect(workers[0].modelEndpoint).toEqual({
      kind: 'anthropic-compatible', baseUrl: 'https://litellm.example.com', authToken: 'sk-agent-example',
      authHeader: 'authorization', models: { 'claude-sonnet-5': 'team-sonnet' },
    });
    expect(resolve).toHaveBeenCalledWith({ teamId: 'team-1', workspaceId: 'ws-1', accountId: 'acc-1' });
  });

  it('endpoint loses the ranking: nothing attached, worker not reported', async () => {
    const { workers, tasks } = claim();
    const won = await attachAgentEndpoints(workers, tasks, 'acc-1', { llmProviderOverride: false, runnerSupportsEndpoint: true }, { resolve: async () => lose });
    expect(won.size).toBe(0);
    expect('modelEndpoint' in workers[0]).toBe(false);
    expect('modelEndpointIgnored' in workers[0]).toBe(false);
  });

  it('no endpoint: the worker is untouched', async () => {
    const { workers, tasks } = claim();
    const before = JSON.stringify(workers);
    const won = await attachAgentEndpoints(workers, tasks, 'acc-1', { llmProviderOverride: false, runnerSupportsEndpoint: true }, { resolve: async () => null });
    expect(won.size).toBe(0);
    expect(JSON.stringify(workers)).toBe(before);
  });

  it('per-machine override: the key is not sent, only the non-secret ignored marker', async () => {
    const { workers, tasks } = claim();
    const won = await attachAgentEndpoints(workers, tasks, 'acc-1', { llmProviderOverride: true, runnerSupportsEndpoint: true }, { resolve: async () => win });
    expect([...won]).toEqual(['worker-1']);
    expect(workers[0].modelEndpoint).toBeUndefined();
    expect(workers[0].modelEndpointIgnored).toBe(true);
    expect(JSON.stringify(workers)).not.toContain('sk-agent-example');
  });

  it('codex tasks are skipped without resolving', async () => {
    const { workers, tasks } = claim('codex');
    const resolve = mock(async () => win);
    const won = await attachAgentEndpoints(workers, tasks, 'acc-1', { llmProviderOverride: false, runnerSupportsEndpoint: true }, { resolve });
    expect(won.size).toBe(0);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('no ENCRYPTION_KEY: a no-op', async () => {
    delete process.env.ENCRYPTION_KEY;
    const { workers, tasks } = claim();
    const resolve = mock(async () => win);
    expect((await attachAgentEndpoints(workers, tasks, 'acc-1', { llmProviderOverride: false, runnerSupportsEndpoint: true }, { resolve })).size).toBe(0);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('a resolver failure is non-fatal and attaches nothing', async () => {
    const { workers, tasks } = claim();
    const won = await attachAgentEndpoints(workers, tasks, 'acc-1', { llmProviderOverride: false, runnerSupportsEndpoint: true }, { resolve: async () => { throw new Error('boom'); } });
    expect(won.size).toBe(0);
    expect(workers[0].modelEndpoint).toBeUndefined();
  });

  it('a runner that does not support endpoints: nothing resolved, attached or withheld', async () => {
    const { workers, tasks } = claim();
    const before = JSON.stringify(workers);
    const resolve = mock(async () => win);
    const won = await attachAgentEndpoints(workers, tasks, 'acc-1', { llmProviderOverride: false, runnerSupportsEndpoint: false }, { resolve });
    expect(won.size).toBe(0);
    expect(resolve).not.toHaveBeenCalled();
    expect(JSON.stringify(workers)).toBe(before);
  });
});
