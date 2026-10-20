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

  it('detects the Sentry and PostHog phrasing', () => {
    expect(detectProviderAccessAsk('I need read access to Sentry issues'))
      .toEqual({ provider: 'sentry', access: 'read' });
    expect(detectProviderAccessAsk('Please grant me PostHog read access')?.provider).toBe('posthog');
  });
  it('does not refuse ordinary questions that mention a provider and a generic word', () => {
    expect(detectProviderAccessAsk('Should I read the Linear ticket description before starting?')).toBeNull();
    expect(detectProviderAccessAsk('Which Vercel project should I use? The token in .env looks stale')).toBeNull();
    expect(detectProviderAccessAsk('Should I connect the Notion page to the doc with credentials from the README?')).toBeNull();
  });
  it('reads the context and options too: the provider ask there counts, an ordinary one does not', () => {
    expect(detectProviderAccessAsk('Which should I pick?', 'I need access to Axiom buildd-traces', 'A', 'B'))
      .toEqual({ provider: 'axiom', access: 'read', resource: 'buildd-traces' });
    expect(detectProviderAccessAsk('Which should I pick?', 'The Sentry token looks stale', 'Linear', 'Vercel')).toBeNull();
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
