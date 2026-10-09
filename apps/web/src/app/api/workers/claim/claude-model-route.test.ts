import { describe, it, expect, mock } from 'bun:test';
import { resolveClaudeModelRoute, routeUsesOauthSeat, type ClaudeRouteDeps } from './claude-model-route';

const base = {
  teamId: 'team-1',
  workspaceId: 'ws-1',
  accountId: 'account-1',
  cloudExecutor: false,
  llmProviderOverride: false,
  runnerSupportsEndpoint: true,
  encryptionKeySet: true,
};

const endpoint = { kind: 'gateway', baseUrl: 'https://gw.example.test', apiKey: 'k', authHeader: 'authorization', scope: 'team', secretId: 's' };

function deps(over: Partial<ClaudeRouteDeps> = {}): ClaudeRouteDeps {
  return {
    resolveEndpoint: mock(async () => null),
    listAnthropicKeys: mock(async () => []),
    ...over,
  };
}

describe('resolveClaudeModelRoute', () => {
  it('is the OAuth seat when nothing else resolves', async () => {
    const route = await resolveClaudeModelRoute(base, deps());
    expect(route).toBe('oauth_seat');
    expect(routeUsesOauthSeat(route)).toBe(true);
  });

  it('is the agent endpoint when the endpoint wins the ranking', async () => {
    const d = deps({ resolveEndpoint: mock(async () => ({ winner: 'endpoint', endpoint }) as any) });
    const route = await resolveClaudeModelRoute(base, d);
    expect(route).toBe('agent_endpoint');
    expect(routeUsesOauthSeat(route)).toBe(false);
    // Ranked as a Claude task, for this account and workspace.
    expect((d.resolveEndpoint as any).mock.calls[0][0]).toEqual({ teamId: 'team-1', workspaceId: 'ws-1', accountId: 'account-1', backend: 'claude' });
  });

  it('ignores an endpoint the runner will not apply', async () => {
    const d = deps({ resolveEndpoint: mock(async () => ({ winner: 'endpoint', endpoint }) as any) });
    expect(await resolveClaudeModelRoute({ ...base, runnerSupportsEndpoint: false }, d)).toBe('oauth_seat');
    expect(d.resolveEndpoint).not.toHaveBeenCalled();
  });

  it('is the API key when a live anthropic_api_key reaches the worker', async () => {
    const d = deps({
      resolveEndpoint: mock(async () => ({ winner: 'anthropic', endpoint, beatenBy: 'workspace' }) as any),
      listAnthropicKeys: mock(async () => [{ accountId: null, workspaceId: 'ws-1', healthStatus: 'healthy' }]),
    });
    const route = await resolveClaudeModelRoute(base, d);
    expect(route).toBe('anthropic_api_key');
    expect(routeUsesOauthSeat(route)).toBe(false);
  });

  it('does not count a revoked key, or one scoped to another workspace or account', async () => {
    const d = deps({
      listAnthropicKeys: mock(async () => [
        { accountId: null, workspaceId: null, healthStatus: 'revoked' },
        { accountId: null, workspaceId: 'ws-other', healthStatus: 'healthy' },
        { accountId: 'account-other', workspaceId: null, healthStatus: 'healthy' },
      ]),
    });
    expect(await resolveClaudeModelRoute(base, d)).toBe('oauth_seat');
  });

  it('counts an account-scoped key for the claiming account', async () => {
    const d = deps({ listAnthropicKeys: mock(async () => [{ accountId: 'account-1', workspaceId: null, healthStatus: null }]) });
    expect(await resolveClaudeModelRoute(base, d)).toBe('anthropic_api_key');
  });

  it('never uses the seat for a cloud executor, whose model traffic is credentialed at egress', async () => {
    const d = deps();
    const route = await resolveClaudeModelRoute({ ...base, cloudExecutor: true }, d);
    expect(route).toBe('cloud_egress');
    expect(routeUsesOauthSeat(route)).toBe(false);
    expect(d.resolveEndpoint).not.toHaveBeenCalled();
  });

  it("is the runner's own provider when it reported llmProviderOverride", async () => {
    expect(await resolveClaudeModelRoute({ ...base, llmProviderOverride: true }, deps())).toBe('runner_provider');
  });

  it('stays on the seat without ENCRYPTION_KEY: nothing server-side can be delivered', async () => {
    const d = deps({ listAnthropicKeys: mock(async () => [{ accountId: null, workspaceId: null, healthStatus: 'healthy' }]) });
    expect(await resolveClaudeModelRoute({ ...base, encryptionKeySet: false }, d)).toBe('oauth_seat');
  });

  it('fails closed to the seat when a lookup throws', async () => {
    const d = deps({ resolveEndpoint: mock(async () => { throw new Error('db down'); }) });
    expect(await resolveClaudeModelRoute(base, d)).toBe('oauth_seat');
  });

  it('is the seat without a team (no team credential can apply)', async () => {
    expect(await resolveClaudeModelRoute({ ...base, teamId: null }, deps())).toBe('oauth_seat');
  });
});

// Provider parity: the team's Anthropic key may sit in canonical storage
// (`inference_key` / `anthropic`) or the legacy `anthropic_api_key`. Either one
// is delivered as ANTHROPIC_API_KEY (./credential-injection), so either one
// means the run does not spend the seat.
describe('resolveClaudeModelRoute: canonical and legacy key storage', () => {
  const key = (extra: Record<string, unknown>) => ({ accountId: null, workspaceId: null, healthStatus: 'healthy', userId: null, ...extra });

  it('counts a canonical team key', async () => {
    const d = deps({ listAnthropicKeys: mock(async () => [key({ purpose: 'inference_key', label: 'anthropic' })]) });
    expect(await resolveClaudeModelRoute(base, d)).toBe('anthropic_api_key');
  });

  it('counts a legacy team key', async () => {
    const d = deps({ listAnthropicKeys: mock(async () => [key({ purpose: 'anthropic_api_key', label: null })]) });
    expect(await resolveClaudeModelRoute(base, d)).toBe('anthropic_api_key');
  });

  it('does not count another provider’s chat key, or a personal key', async () => {
    const d = deps({
      listAnthropicKeys: mock(async () => [
        key({ purpose: 'inference_key', label: 'openrouter' }),
        key({ purpose: 'inference_key', label: 'openai' }),
        key({ purpose: 'inference_key', label: 'anthropic', userId: 'user-1' }),
      ]),
    });
    expect(await resolveClaudeModelRoute(base, d)).toBe('oauth_seat');
  });
});
