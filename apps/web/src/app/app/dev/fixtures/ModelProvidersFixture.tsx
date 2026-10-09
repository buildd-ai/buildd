'use client';

/**
 * `?state=model-providers`: Settings → Providers with team keys (one revoked),
 * a Claude seat, a workspace override, a personal key and no credential policy
 * chosen yet; under Advanced a connected LiteLLM gateway, a team agent
 * endpoint on two of three workspaces, and two
 * workspace overrides (one a copy of the team endpoint, one different). The
 * real page needs a team with all of that configured, so a route screenshot of
 * a fresh team shows only the empty state. Fixture values only: example.com
 * URLs, made-up last4s.
 */
import { Suspense, useState } from 'react';
import SettingsPage from '../../(protected)/settings/_components/SettingsPage';
import ModelProvidersClient from '../../(protected)/settings/providers/ModelProvidersClient';
import { PROVIDERS_DESCRIPTION } from '../../(protected)/settings/providers/provider-copy';
import type { CredentialPolicyValue, ExplainProviderResponse } from '@buildd/shared';
import { fixturePolicy, fixtureResponse, fixtureRow, type FixtureRow } from './providers-fixture-data';

const TEAM = 'fixture-team';
const WORKSPACES = [
  { id: 'ws-a', name: 'Workspace A' },
  { id: 'ws-b', name: 'Workspace B' },
  { id: 'ws-c', name: 'Workspace C' },
];
const FLASH = 'fireworks_ai/deepseek-v4p1-flash';
const TIERS: Array<[string, string]> = [
  ['claude-fable-5-1', 'premium-plus'],
  ['claude-opus-5-5', 'premium'],
  ['claude-opus-5', 'premium'],
  ['claude-sonnet-5', 'standard'],
  ['claude-sonnet-4-6', 'standard'],
  ['claude-haiku-4-5-20251001', 'budget'],
];
const MODELS: Record<string, string> = Object.fromEntries(
  TIERS.map(([m]) => [m, m.startsWith('claude-haiku') ? 'claude-haiku-4-5' : FLASH]),
);
const MAPPING = TIERS.map(([model, tier]) => ({ model, tiers: [tier], sent: MODELS[model] }));
const LISTED = [
  FLASH,
  'fireworks_ai/deepseek-v4p1-pro',
  'bedrock/deepseek.r1-v1:0',
  'bedrock/deepseek.v3-v1:0',
  'claude-haiku-4-5',
  'openrouter/anthropic/claude-sonnet-5',
];
const DAY = 24 * 3600 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function endpoints() {
  const team = {
    id: 'fixture-team-endpoint', scope: 'team', workspaceId: null, workspaceName: null,
    appliesTo: WORKSPACES.slice(0, 2), kind: 'gateway', baseUrl: 'https://litellm.example.com', authHeader: 'authorization',
    models: MODELS, mapping: MAPPING, last4: 'abcd', gatewayMissing: false, health: 'healthy',
    lastVerifiedAt: ago(3 * DAY), lastVerificationError: null,
  };
  return [
    team,
    { ...team, id: 'fixture-copy', scope: 'workspace', workspaceId: 'ws-a', workspaceName: 'Workspace A', appliesTo: null, matchesTeam: true, lastVerifiedAt: ago(9 * DAY) },
    {
      ...team, id: 'fixture-override', scope: 'workspace', workspaceId: 'ws-c', workspaceName: 'Workspace C', appliesTo: null, matchesTeam: false,
      kind: 'anthropic-compatible', baseUrl: 'https://proxy.example.com', last4: 'wxyz', health: 'unknown',
      lastVerificationError: 'The endpoint returned 502.', lastVerifiedAt: ago(2 * 3600 * 1000),
      models: { 'claude-sonnet-5': 'bedrock/deepseek.v3-v1:0' },
      mapping: MAPPING.map((m) => ({ ...m, sent: m.model === 'claude-sonnet-5' ? 'bedrock/deepseek.v3-v1:0' : m.model })),
    },
  ];
}

const ROWS: FixtureRow[] = [
  { provider: 'anthropic', scope: 'team', last4: 'a1b2', lastVerifiedAt: ago(2 * 3600 * 1000) },
  { provider: 'claude-subscription', scope: 'team', shape: 'oauth_managed', lastVerifiedAt: ago(DAY) },
  { provider: 'openai', scope: 'team', last4: 'k9q4', health: 'revoked', lastVerificationError: 'OpenAI rejected the key (401).', lastVerifiedAt: ago(3 * DAY) },
  { provider: 'litellm', scope: 'team', last4: 'abcd', lastVerifiedAt: ago(3 * DAY) },
  { provider: 'custom-endpoint', scope: 'team', last4: 'abcd' },
  { provider: 'openrouter', scope: 'workspace', workspaceId: 'ws-a', last4: 'r7s8', lastVerifiedAt: ago(5 * DAY) },
  { provider: 'anthropic', scope: 'mine', last4: 'm3n4' },
];

function explain(url: URL): ExplainProviderResponse {
  const surface = url.searchParams.get('surface') as ExplainProviderResponse['surface'];
  const provider = url.searchParams.get('provider') ?? 'anthropic';
  const as = url.searchParams.get('as') === 'self' ? 'self' : 'team';
  const workspaceId = url.searchParams.get('workspaceId');
  const row = ROWS.find((r) => r.provider === provider && (r.scope === 'team' || (as === 'self' && r.scope === 'mine')) && r.health !== 'revoked');
  if (!row) return { surface, as, workspaceId, result: { resolved: false, reason: `No usable ${provider} credential for this.` }, why: [`team ${provider}: none set`] };
  const scope = row.scope === 'mine' ? 'personal' : row.scope;
  return {
    surface, as, workspaceId,
    result: { resolved: true, provider, shape: fixtureRow(row).shape, scope, source: { scope, secretId: 'fixture', purpose: fixtureRow(row).purpose, label: null, legacy: false } },
    why: as === 'self' ? ['personal key: used, the team policy puts yours first'] : ['team key: used'],
  };
}

function installStub() {
  if (typeof window === 'undefined') return;
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const real = window.fetch.bind(window);
  let credentialPolicy: CredentialPolicyValue | null = null;
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    const parsed = new URL(url, window.location.origin);
    if (parsed.pathname === '/api/providers/explain') return Promise.resolve(json(explain(parsed)));
    if (parsed.pathname === '/api/providers') {
      if (init?.method === 'PATCH') {
        credentialPolicy = JSON.parse(String(init.body)).credentialPolicy;
        return Promise.resolve(json({ policy: fixturePolicy(credentialPolicy) }));
      }
      return Promise.resolve(json(fixtureResponse({ rows: ROWS, workspaceId: parsed.searchParams.get('workspaceId'), credentialPolicy, teamId: TEAM })));
    }
    if (url.startsWith('/api/inference-keys')) return Promise.resolve(json({ canManageTeamKeys: true, providers: [], keyPolicy: 'team' }));
    if (!url.startsWith(`/api/teams/${TEAM}`)) return real(input, init);
    if (url.endsWith('/litellm-gateway')) {
      return Promise.resolve(json({ gateway: { baseURL: 'https://litellm.example.com/v1', last4: 'abcd', health: 'healthy', lastVerificationError: null } }));
    }
    if (url.endsWith('/agent-endpoint/models/suggest')) return Promise.resolve(json({ suggestions: [] }));
    if (url.endsWith('/agent-endpoint/models')) {
      const rows = TIERS.map(([model, tier]) => ({ model, tiers: [tier], value: MODELS[model], source: 'alias', served: true }));
      return Promise.resolve(json({ available: true, listed: LISTED, rows }));
    }
    if (url.includes('/agent-endpoint')) return Promise.resolve(json({ endpoints: endpoints() }));
    return Promise.resolve(json({ team: { decisionModel: null } }));
  }) as typeof fetch;
}

export default function ModelProvidersFixture() {
  // Installed before the sections' mount effects fire, which a child effect would otherwise beat.
  useState(() => installStub());
  return (
    <div className="min-h-screen bg-surface-1">
      <SettingsPage title="Providers" description={PROVIDERS_DESCRIPTION}>
        <Suspense>
          <ModelProvidersClient teamId={TEAM} isAdmin workspaces={WORKSPACES} />
        </Suspense>
      </SettingsPage>
    </div>
  );
}
