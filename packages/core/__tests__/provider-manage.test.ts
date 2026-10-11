import { describe, expect, it } from 'bun:test';
import { PROVIDER_IDS, PROVIDER_REGISTRY, SURFACES, providerDescriptor } from '../providers';
import {
  modelCredentialPurposes,
  providerShape,
  requiredKeyPrefix,
  rowProvider,
  scopeRefusal,
  storageServes,
  storedWritePermissions,
  surfaceRefusal,
  writePermission,
  writePermissions,
  writeStorage,
} from '../providers/manage';

const shapeOf = (id: (typeof PROVIDER_IDS)[number], shape?: Parameters<typeof providerShape>[1]) => providerShape(id, shape)!;

describe('writeStorage', () => {
  it('a personal credential always goes to the canonical storage', () => {
    for (const p of PROVIDER_REGISTRY) {
      for (const s of p.shapes) expect(writeStorage(p.id, s, 'mine')).toEqual(s.storage);
    }
  });

  // Provider parity: agent runs read the canonical storage now, so a team or
  // workspace Anthropic or OpenAI key is written there, and serves chat and
  // agent runs alike. (Before: the Anthropic key went to the legacy
  // `anthropic_api_key`, the only storage the host claim read, and a team
  // OpenAI key reached chat only.)
  it('a team or workspace Anthropic key goes to canonical storage, which every surface reads', () => {
    for (const scope of ['team', 'workspace'] as const) {
      const st = writeStorage('anthropic', shapeOf('anthropic'), scope);
      expect(st).toEqual({ purpose: 'inference_key', label: 'anthropic', readBy: ['chat', 'agent-claude', 'cloud-egress'] });
      expect(storageServes(providerDescriptor('anthropic'), st)).toEqual(['chat', 'agent-claude', 'cloud-egress']);
    }
  });

  it('a team or workspace OpenAI key goes to canonical storage, which serves chat and Codex runs', () => {
    for (const scope of ['team', 'workspace'] as const) {
      const st = writeStorage('openai', shapeOf('openai'), scope);
      expect(st).toEqual({ purpose: 'inference_key', label: 'openai', readBy: ['chat', 'agent-codex'] });
      expect(storageServes(providerDescriptor('openai'), st)).toEqual(['chat', 'agent-codex']);
    }
  });

  it('a tie stays on canonical storage', () => {
    expect(writeStorage('openrouter', shapeOf('openrouter'), 'team').purpose).toBe('inference_key');
  });

  it('no API key provider writes a legacy alias any more', () => {
    for (const p of PROVIDER_REGISTRY) {
      const s = p.shapes.find(x => x.id === 'api_key');
      if (!s) continue;
      for (const scope of ['team', 'workspace'] as const) expect(writeStorage(p.id, s, scope)).toEqual(s.storage);
    }
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

describe('writePermissions', () => {
  // A canonical key that agent runs read is both a model key and an agent
  // credential: whoever sets it needs what each of the two routes that used to
  // write those storages needed, so moving the write changes nobody's access.
  it('a canonical key read by agent runs needs both the model-key and the agent-credential permission', () => {
    for (const id of ['anthropic', 'openai'] as const) {
      expect(writePermissions(shapeOf(id), shapeOf(id).storage)).toEqual(['manage_team_model_keys', 'manage_team_credentials']);
    }
  });

  it('a chat-only canonical key, and every other storage, needs only its own route\'s permission', () => {
    expect(writePermissions(shapeOf('openrouter'), shapeOf('openrouter').storage)).toEqual(['manage_team_model_keys']);
    expect(writePermissions(shapeOf('anthropic'), { purpose: 'anthropic_api_key', readBy: ['agent-claude'] })).toEqual(['manage_team_credentials']);
    expect(writePermissions(shapeOf('litellm'), shapeOf('litellm').storage)).toEqual(['manage_inference_providers']);
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

describe('storedWritePermissions: a raw purpose + label gets the /api/providers rule', () => {
  it('an Anthropic or OpenAI key in canonical storage needs both permissions, whatever the label case', () => {
    for (const label of ['anthropic', 'openai', 'Anthropic']) {
      expect(storedWritePermissions({ purpose: 'inference_key', label })).toEqual(['manage_team_model_keys', 'manage_team_credentials']);
    }
  });

  it('agrees with writePermissions for every API key and seat token storage in the registry', () => {
    for (const p of PROVIDER_REGISTRY) {
      for (const s of p.shapes) {
        if (s.id === 'gateway' || s.id === 'endpoint') continue;
        for (const st of [s.storage, ...s.legacy]) {
          expect(storedWritePermissions({ purpose: st.purpose, label: st.label ?? null })).toEqual(writePermissions(s, st));
        }
      }
    }
  });

  it("keeps each other storage at its own route's permission", () => {
    expect(storedWritePermissions({ purpose: 'inference_key', label: 'openrouter' })).toEqual(['manage_team_model_keys']);
    expect(storedWritePermissions({ purpose: 'decision_key' })).toEqual(['manage_team_model_keys']);
    expect(storedWritePermissions({ purpose: 'anthropic_api_key' })).toEqual(['manage_team_credentials']);
    expect(storedWritePermissions({ purpose: 'oauth_token' })).toEqual(['manage_team_credentials']);
  });

  it("is null for a gateway, an unknown label and a non-model secret, which keep the route's own rule", () => {
    expect(storedWritePermissions({ purpose: 'inference_key', label: 'litellm' })).toBeNull();
    expect(storedWritePermissions({ purpose: 'inference_key', label: 'nobody' })).toBeNull();
    expect(storedWritePermissions({ purpose: 'mcp_credential', label: 'X' })).toBeNull();
  });
});

describe('requiredKeyPrefix', () => {
  it('a key agent runs read keeps its legacy alias prefix, so a pasted seat token is refused', () => {
    expect(requiredKeyPrefix({ purpose: 'inference_key', label: 'anthropic' })).toBe('sk-ant-api');
    expect(requiredKeyPrefix({ purpose: 'anthropic_api_key' })).toBe('sk-ant-api');
    expect(requiredKeyPrefix({ purpose: 'inference_key', label: 'openai' })).toBe('sk-');
    expect(requiredKeyPrefix({ purpose: 'openai_api_key' })).toBe('sk-');
    expect(requiredKeyPrefix({ purpose: 'oauth_token' })).toBe('sk-ant-oat');
  });

  it('a chat-only key and a gateway key have none', () => {
    expect(requiredKeyPrefix({ purpose: 'inference_key', label: 'openrouter' })).toBeUndefined();
    expect(requiredKeyPrefix({ purpose: 'inference_key', label: 'litellm' })).toBeUndefined();
    expect(requiredKeyPrefix({ purpose: 'mcp_credential' })).toBeUndefined();
  });
});
