import { describe, it, expect, mock } from 'bun:test';
import { detectProviderAccessAsk } from '../provider-access-ask';
import { handleBuilddAction, type ApiFn } from '../mcp-tools';

describe('provider access ask', () => {
  it('turns the Axiom widen-the-key question into the canonical request', () => {
    expect(detectProviderAccessAsk('Please widen the worker key with analytics:read so I can query Axiom buildd-traces'))
      .toEqual({ provider: 'axiom', access: 'read', resource: 'buildd-traces' });
  });
  it('detects writes and leaves ordinary questions alone', () => {
    expect(detectProviderAccessAsk('I need write access to Linear')?.access).toBe('write');
    expect(detectProviderAccessAsk('Which base branch should I use?')).toBeNull();
    expect(detectProviderAccessAsk('Should the Axiom dashboard use a bar chart?')).toBeNull();
  });

  it('ask_human refuses it, parks nothing, and never recommends widening the key', async () => {
    const api = mock(async () => ({}));
    const res = await handleBuilddAction(api as unknown as ApiFn, 'ask_human', {
      question: 'Can you widen my worker key with analytics:read for Axiom?', workerId: 'w1',
    }, { workerId: 'w1', workspaceId: 'ws', getWorkspaceId: async () => 'ws', getLevel: async () => 'worker' } as never);
    expect(res.isError).toBe(true);
    const out = JSON.parse(res.content[0].text);
    expect(out.error).toBe('use_request_capability');
    expect(out.request.params).toEqual({ provider: 'axiom', access: 'read' });
    expect(out.reason).toContain('Do not ask anyone to widen the worker key');
    expect(api).not.toHaveBeenCalled();
  });
});
