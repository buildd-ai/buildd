import { describe, expect, it } from 'bun:test';
import { applyWallFallbackCredentials, type WallFallbackPlan } from './wall-fallback-injection';

const endpointRoute = {
  kind: 'openrouter', baseUrl: 'https://openrouter.ai/api', apiKey: 'sk-or-key', authHeader: 'authorization', models: {}, toolSearch: false,
  openAiBaseUrl: 'https://openrouter.ai/api/v1',
} as any;

function worker(id: string, taskId: string, extra: Record<string, unknown> = {}, task: Record<string, unknown> = {}) {
  return { id, taskId, branch: 'b', task: { id: taskId, workspaceId: 'ws', backend: 'claude', workspace: { teamId: 'team' }, ...task }, ...extra } as any;
}

const record = { served: 'anthropic', label: "the team's Anthropic API key", wall: { scope: 'login', runner: 'r1' }, at: 'now' } as any;

function plan(over: Partial<WallFallbackPlan> = {}): WallFallbackPlan {
  return { credential: { served: 'anthropic', label: record.label, last4: null, apiKey: 'sk-ant-fallback' }, record, ...over };
}

const baseOpts = { heldByTeam: new Map(), skip: new Set<string>(), runnerSupportsEndpoint: true, runnerSupportsHeaders: true };

describe('applyWallFallbackCredentials', () => {
  it('delivers the API key to a walled run and nothing else as its model credential', () => {
    const w = worker('w1', 't1', { modelEndpoint: { kind: 'gateway' } });
    const applied = applyWallFallbackCredentials([w], { ...baseOpts, plans: new Map([['t1', plan()]]) });
    expect([...applied.keys()]).toEqual(['w1']);
    expect(w.serverApiKey).toBe('sk-ant-fallback');
    expect(w.modelEndpoint).toBeUndefined();
  });

  it('delivers an endpoint fallback as the model endpoint, removing any key', () => {
    const w = worker('w1', 't1', { serverApiKey: 'other' });
    const p = plan({ credential: { served: 'openrouter', label: 'x', last4: null, endpoint: endpointRoute } });
    applyWallFallbackCredentials([w], { ...baseOpts, plans: new Map([['t1', p]]) });
    expect(w.serverApiKey).toBeUndefined();
    expect(w.modelEndpoint).toMatchObject({ kind: 'openrouter', baseUrl: 'https://openrouter.ai/api', authToken: 'sk-or-key', authHeader: 'authorization' });
  });

  it('does not deliver an endpoint the runner cannot apply', () => {
    const w = worker('w1', 't1');
    const p = plan({ credential: { served: 'litellm', label: 'x', last4: null, endpoint: endpointRoute } });
    const applied = applyWallFallbackCredentials([w], { ...baseOpts, runnerSupportsEndpoint: false, plans: new Map([['t1', p]]) });
    expect(applied.size).toBe(0);
    expect(w.modelEndpoint).toBeUndefined();
    const w2 = worker('w2', 't2');
    const withHeaders = plan({ credential: { served: 'endpoint', label: 'x', last4: null, endpoint: { ...endpointRoute, headers: { 'cf-aig-authorization': 'Bearer t' } } } });
    expect(applyWallFallbackCredentials([w2], { ...baseOpts, runnerSupportsHeaders: false, plans: new Map([['t2', withHeaders]]) }).size).toBe(0);
  });

  it('withholds the reserved credential from an ordinary run of a subscription runner', () => {
    const a = worker('a', 'ta', { serverApiKey: 'team-key', mcpSecrets: { X: '1' } });
    const b = worker('b', 'tb', { modelEndpoint: { kind: 'gateway' }, modelEndpointIgnored: true });
    applyWallFallbackCredentials([a], { ...baseOpts, plans: new Map(), heldByTeam: new Map([['team', 'anthropic_api_key']]) });
    applyWallFallbackCredentials([b], { ...baseOpts, plans: new Map(), heldByTeam: new Map([['team', 'agent_endpoint']]) });
    expect(a.serverApiKey).toBeUndefined();
    expect(a.mcpSecrets).toEqual({ X: '1' });
    expect(b.modelEndpoint).toBeUndefined();
    expect(b.modelEndpointIgnored).toBeUndefined();
  });

  it('never touches a personal-key, native-login or Codex worker', () => {
    const personal = worker('p', 'tp', { serverApiKey: 'mine' });
    const codex = worker('c', 'tc', { modelEndpoint: { kind: 'gateway' } }, { backend: 'codex' });
    const applied = applyWallFallbackCredentials([personal, codex], {
      ...baseOpts,
      skip: new Set(['p']),
      plans: new Map([['tp', plan()], ['tc', plan()]]),
      heldByTeam: new Map([['team', 'agent_endpoint']]),
    });
    expect(applied.size).toBe(0);
    expect(personal.serverApiKey).toBe('mine');
    expect(codex.modelEndpoint).toEqual({ kind: 'gateway' });
  });
});
