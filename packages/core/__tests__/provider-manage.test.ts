import { describe, expect, it } from 'bun:test';
import { PROVIDER_IDS, PROVIDER_REGISTRY, SURFACES, providerDescriptor } from '../providers';
import {
  modelCredentialPurposes,
  providerShape,
  rowProvider,
  scopeRefusal,
  storageServes,
  surfaceRefusal,
  writePermission,
  writeStorage,
} from '../providers/manage';

const shapeOf = (id: (typeof PROVIDER_IDS)[number], shape?: Parameters<typeof providerShape>[1]) => providerShape(id, shape)!;

describe('writeStorage', () => {
  it('a personal credential always goes to the canonical storage', () => {
    for (const p of PROVIDER_REGISTRY) {
      for (const s of p.shapes) expect(writeStorage(p.id, s, 'mine')).toEqual(s.storage);
    }
  });

  it('a team Anthropic key goes where every surface reads it today (the legacy purpose)', () => {
    const st = writeStorage('anthropic', shapeOf('anthropic'), 'team');
    expect(st.purpose).toBe('anthropic_api_key');
    expect(storageServes(providerDescriptor('anthropic'), st)).toEqual(['chat', 'agent-claude', 'cloud-egress']);
    expect(writeStorage('anthropic', shapeOf('anthropic'), 'workspace').purpose).toBe('anthropic_api_key');
  });

  it('a tie stays on canonical storage', () => {
    // OpenAI: canonical serves chat, legacy serves Codex: one surface each.
    expect(writeStorage('openai', shapeOf('openai'), 'team')).toEqual({ purpose: 'inference_key', label: 'openai', readBy: ['chat'] });
    expect(writeStorage('openrouter', shapeOf('openrouter'), 'team').purpose).toBe('inference_key');
  });

  it('never picks a storage that serves fewer surfaces than canonical', () => {
    for (const p of PROVIDER_REGISTRY) {
      for (const s of p.shapes) {
        const chosen = writeStorage(p.id, s, 'team');
        expect(storageServes(p, chosen).length).toBeGreaterThanOrEqual(storageServes(p, s.storage).length);
      }
    }
  });
});

describe('providerShape', () => {
  it('defaults to a pasteable shape', () => {
    expect(providerShape('claude-subscription')!.id).toBe('setup_token');
    expect(providerShape('anthropic')!.id).toBe('api_key');
    expect(providerShape('litellm')!.id).toBe('gateway');
    expect(providerShape('custom-endpoint')!.id).toBe('endpoint');
    // Codex has only the browser flow.
    expect(providerShape('codex-subscription')!.id).toBe('oauth_managed');
  });

  it('is null for a shape the provider does not have', () => {
    expect(providerShape('anthropic', 'gateway')).toBeNull();
  });
});

describe('scopeRefusal', () => {
  it('team and workspace are always open', () => {
    for (const id of PROVIDER_IDS) {
      expect(scopeRefusal(id, 'team')).toBeNull();
      expect(scopeRefusal(id, 'workspace')).toBeNull();
    }
  });

  it('mine follows the registry scopes and pending scopes', () => {
    for (const p of PROVIDER_REGISTRY) {
      const open = p.scopes.includes('personal') && !(p.pendingScopes ?? []).includes('personal');
      expect(scopeRefusal(p.id, 'mine') === null).toBe(open);
    }
    expect(scopeRefusal('anthropic', 'mine')).toBeNull();
    expect(scopeRefusal('litellm', 'mine')).toMatch(/shared configuration/);
    expect(scopeRefusal('claude-subscription', 'mine')).toMatch(/not delivered/);
  });
});

describe('surfaceRefusal', () => {
  it('returns the registry string verbatim for every impossible pair', () => {
    for (const p of PROVIDER_REGISTRY) {
      for (const s of SURFACES) {
        const support = p.surfaces[s];
        const refusal = surfaceRefusal(p.id, s);
        if (support.ok) expect(refusal).toBeNull();
        else expect(refusal!.reason).toBe(support.reason);
      }
    }
  });
});

describe('writePermission', () => {
  it('matches the route that has always written each storage', () => {
    expect(writePermission(shapeOf('anthropic'), { purpose: 'inference_key', label: 'anthropic', readBy: [] })).toBe('manage_team_model_keys');
    expect(writePermission(shapeOf('anthropic'), { purpose: 'anthropic_api_key', readBy: [] })).toBe('manage_team_credentials');
    expect(writePermission(shapeOf('claude-subscription'), shapeOf('claude-subscription').storage)).toBe('manage_team_credentials');
    expect(writePermission(shapeOf('litellm'), shapeOf('litellm').storage)).toBe('manage_inference_providers');
    expect(writePermission(shapeOf('custom-endpoint'), shapeOf('custom-endpoint').storage)).toBe('manage_inference_providers');
  });
});

describe('rowProvider', () => {
  it('classifies every canonical and legacy storage', () => {
    expect(rowProvider({ purpose: 'inference_key', label: 'Anthropic' })).toEqual({ provider: 'anthropic', shape: 'api_key', legacy: false });
    expect(rowProvider({ purpose: 'anthropic_api_key', label: null })).toEqual({ provider: 'anthropic', shape: 'api_key', legacy: true });
    expect(rowProvider({ purpose: 'decision_key', label: null })).toEqual({ provider: 'openrouter', shape: 'api_key', legacy: true });
    expect(rowProvider({ purpose: 'oauth_token', label: null })).toEqual({ provider: 'claude-subscription', shape: 'setup_token', legacy: false });
    expect(rowProvider({ purpose: 'inference_key', label: 'litellm' })).toEqual({ provider: 'litellm', shape: 'gateway', legacy: false });
    expect(rowProvider({ purpose: 'mcp_credential', label: 'X' })).toBeNull();
    expect(rowProvider({ purpose: 'inference_key', label: 'unknown' })).toBeNull();
  });

  it('modelCredentialPurposes covers every storage', () => {
    const all = modelCredentialPurposes();
    for (const p of PROVIDER_REGISTRY) for (const s of p.shapes) for (const st of [s.storage, ...s.legacy]) expect(all).toContain(st.purpose);
    expect(all).not.toContain('mcp_credential');
  });
});
