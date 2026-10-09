import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROUTES, ROUTE_IDS } from '@builddai/ai-kit/models/routes';
import { PROVIDER_KEY_CAPABILITIES } from '@builddai/ai-kit/models/provider-keys';
import {
  PROVIDER_IDS,
  PROVIDER_REGISTRY,
  SURFACES,
  TIER_PROVIDER_IDS,
  TIER_PROVIDER_OPTIONS,
  backendCredentialPurposes,
  providerDescriptor,
  providerStorages,
  tierProviderSurfaces,
  tierUsedBy,
  type ModelCredentialPurpose,
} from '../providers';
import { BACKEND_REGISTRY } from '../backend-policy';

const repo = join(import.meta.dir, '..', '..', '..');

/** Every `secrets.purpose` that holds a model credential (hand-written on purpose). */
const MODEL_CREDENTIAL_PURPOSES: ModelCredentialPurpose[] = [
  'inference_key', 'anthropic_api_key', 'decision_key', 'oauth_token',
  'claude_credential', 'openai_api_key', 'codex_credential', 'agent_endpoint',
];

describe('provider registry: shape', () => {
  it('has one entry per provider, in a stable id order', () => {
    expect(PROVIDER_REGISTRY.map(p => p.id)).toEqual([...PROVIDER_IDS]);
    expect([...PROVIDER_IDS].sort()).toEqual([
      'anthropic', 'claude-subscription', 'codex-subscription', 'custom-endpoint',
      'litellm', 'openai', 'openrouter',
    ]);
  });

  it('every impossible provider×surface pair carries a non-empty reason', () => {
    for (const p of PROVIDER_REGISTRY) {
      for (const s of SURFACES) {
        const support = p.surfaces[s];
        if (support.ok) {
          expect(support.via.length).toBeGreaterThan(0);
        } else {
          expect(support.reason.trim().length).toBeGreaterThan(10);
          for (const alt of support.instead ?? []) {
            // An "instead" must actually serve the surface.
            expect(providerDescriptor(alt).surfaces[s].ok).toBe(true);
          }
        }
      }
    }
  });

  it('encodes the design matrix (served surfaces per provider)', () => {
    const served = Object.fromEntries(PROVIDER_REGISTRY.map(p => [p.id, SURFACES.filter(s => p.surfaces[s].ok)]));
    expect(served).toEqual({
      'claude-subscription': ['agent-claude'],
      anthropic: ['chat', 'agent-claude', 'cloud-egress'],
      'codex-subscription': ['agent-codex'],
      openai: ['chat', 'agent-codex'],
      openrouter: ['chat', 'agent-claude', 'agent-codex', 'cloud-egress'],
      litellm: ['chat', 'agent-claude', 'agent-codex', 'cloud-egress'],
      'custom-endpoint': ['agent-claude', 'cloud-egress'],
    });
  });

  it('every model-credential purpose is the storage of exactly one shape (label-keyed purposes per label)', () => {
    const keys = PROVIDER_REGISTRY.flatMap(p => providerStorages(p).map(s => `${s.purpose}/${s.label ?? ''}`));
    expect(new Set(keys).size).toBe(keys.length);
    const purposes = new Set(PROVIDER_REGISTRY.flatMap(p => providerStorages(p).map(s => s.purpose)));
    expect([...purposes].sort()).toEqual([...MODEL_CREDENTIAL_PURPOSES].sort());
  });

  it('a storage is only read today by surfaces its provider can serve', () => {
    for (const p of PROVIDER_REGISTRY) {
      for (const s of providerStorages(p)) {
        for (const surface of s.readBy) expect(p.surfaces[surface].ok).toBe(true);
      }
    }
  });

  it('personal scope follows ROUTES.personalKeys for route-backed providers', () => {
    for (const id of ROUTE_IDS) {
      const p = PROVIDER_REGISTRY.find(d => d.route === id)!;
      expect(p).toBeDefined();
      expect(p.scopes.includes('personal')).toBe(ROUTES[id].personalKeys);
    }
    expect(providerDescriptor('custom-endpoint').scopes).toEqual(['team', 'workspace']);
    expect(providerDescriptor('litellm').scopes).toEqual(['team', 'workspace']);
  });

  it('every tier provider surface is one its provider can serve, and every tier provider is satisfied', () => {
    for (const p of PROVIDER_REGISTRY) {
      for (const t of p.tierProviders) {
        for (const s of t.surfaces) expect(p.surfaces[s].ok).toBe(true);
      }
    }
    for (const t of TIER_PROVIDER_IDS) expect(tierProviderSurfaces(t).length).toBeGreaterThan(0);
  });

  it('settings card ids and orders are unique; MCP action names the provider', () => {
    const ids = PROVIDER_REGISTRY.map(p => p.settingsCard.id);
    const orders = PROVIDER_REGISTRY.map(p => p.settingsCard.order);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(orders).size).toBe(orders.length);
    for (const p of PROVIDER_REGISTRY) expect(p.mcp).toEqual({ action: 'manage_providers', provider: p.id });
  });
});

describe('derived lists equal what they were before', () => {
  it('PROVIDER_KEY_CAPABILITIES[].purposes is unchanged', () => {
    expect(Object.fromEntries(PROVIDER_KEY_CAPABILITIES.map(p => [p.id, p.purposes]))).toEqual({
      anthropic: ['inference_key', 'anthropic_api_key'],
      openai: ['inference_key'],
      openrouter: ['inference_key', 'decision_key'],
      litellm: ['inference_key'],
    });
  });

  it('the deprecated ROUTES legacyPurposes still agree with the registry', () => {
    for (const id of ROUTE_IDS) {
      const route = ROUTES[id] as { key?: { legacyPurposes?: readonly string[] } };
      expect(PROVIDER_KEY_CAPABILITIES.find(p => p.id === id)!.purposes.slice(1)).toEqual([...(route.key?.legacyPurposes ?? [])]);
    }
  });

  it('BACKEND_REGISTRY.claude.credentialPurposes is unchanged', () => {
    expect(BACKEND_REGISTRY.claude.credentialPurposes).toEqual(['claude_credential', 'oauth_token', 'anthropic_api_key']);
  });

  it('TIER_PROVIDER_OPTIONS ids, order and labels are unchanged', () => {
    expect(TIER_PROVIDER_OPTIONS.map(p => [p.id, p.label])).toEqual([
      ['anthropic', 'Anthropic'],
      ['openrouter', 'OpenRouter'],
      ['openai', 'OpenAI'],
      ['openai-codex', 'OpenAI Codex'],
    ]);
    expect(TIER_PROVIDER_OPTIONS.map(p => p.id)).toEqual([...TIER_PROVIDER_IDS]);
    expect(TIER_PROVIDER_OPTIONS[0].note).toBeUndefined();
    expect(TIER_PROVIDER_OPTIONS[1].note).toBeUndefined();
  });

  it('tierUsedBy is unchanged for anthropic, openrouter, openai-codex and unknown providers', () => {
    expect(tierUsedBy('anthropic')).toBe('agent runs, chat');
    expect(tierUsedBy('openrouter')).toBe('agent runs, chat');
    expect(tierUsedBy('openai-codex')).toBe('agent runs only');
    expect(tierUsedBy('not-a-provider')).toBe('agent runs, chat');
  });
});

describe('documented fixes', () => {
  it('fix: Codex counts an OpenAI API key as configured (it runs on one)', () => {
    expect(BACKEND_REGISTRY.codex.credentialPurposes).toEqual(['codex_credential', 'openai_api_key']);
  });

  it('fix: OpenRouter no longer names the non-existent openrouter_credential purpose', () => {
    expect(BACKEND_REGISTRY.openrouter.credentialPurposes).not.toContain('openrouter_credential' as never);
    for (const purpose of BACKEND_REGISTRY.openrouter.credentialPurposes) {
      expect(MODEL_CREDENTIAL_PURPOSES).toContain(purpose as ModelCredentialPurpose);
    }
    // No agent reader takes a stored OpenRouter key yet.
    expect(backendCredentialPurposes('openrouter')).toEqual([]);
    expect(BACKEND_REGISTRY.openrouter.dispatchable).toBe(false);
  });

  it('fix: the OpenAI tier serves agent runs too (tier-pool maps it to runner:codex)', () => {
    expect(tierUsedBy('openai')).toBe('agent runs, chat');
    const note = TIER_PROVIDER_OPTIONS.find(p => p.id === 'openai')!.note!;
    expect(note).not.toMatch(/runners cannot/i);
    expect(note).toMatch(/Codex runs/);
    expect(note).toMatch(/Claude runs cannot/);
  });
});

describe('derived lists are not written literally again', () => {
  it('backend-policy.ts derives credentialPurposes', () => {
    const src = readFileSync(join(repo, 'packages/core/backend-policy.ts'), 'utf8');
    expect(src).not.toMatch(/credentialPurposes:\s*\[/);
  });

  it('provider-keys.ts derives purposes', () => {
    const src = readFileSync(join(repo, 'packages/ai-kit/src/models/provider-keys.ts'), 'utf8');
    expect(src).not.toMatch(/purposes:\s*\[/);
  });

  it('tier-mapping.ts defines no tier provider list or tierUsedBy of its own', () => {
    const src = readFileSync(join(repo, 'apps/web/src/lib/tier-mapping.ts'), 'utf8');
    expect(src).not.toMatch(/TIER_PROVIDER_OPTIONS\s*:/);
    expect(src).not.toMatch(/function\s+tierUsedBy/);
  });
});
