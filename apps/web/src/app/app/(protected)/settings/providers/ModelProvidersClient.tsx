'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import type { ListProvidersResponse, ProviderApiScope } from '@buildd/shared';
import { providerFlowMessage } from '@/components/settings/ConnectOpenRouterButton';
import { Select } from '@/components/ui/Select';
import CredentialPolicySelector from './CredentialPolicySelector';
import ProviderCard from './ProviderCard';
import { DecisionModelPicker, GatewayCard } from './GatewayAndDecisionModel';
import AgentEndpointSection, { type EndpointWorkspace } from './AgentEndpointSection';
import { ADVANCED_ANCHOR, SCOPE_TABS, coverageText, coverageView, isScopeTab } from './providers-view';

/**
 * Settings → Providers. Every model provider in registry order, one card each,
 * at the scope picked in the tabs (Team / Workspace / Mine), with the team's
 * credential policy on top. Built on `/api/providers`: what a provider serves,
 * the scopes it can be stored at and what each stored row serves today come
 * from the response, never from a copy here. Keys never come back beyond last4.
 *
 * Routing settings the cards don't cover (gateway, agent endpoint, decision
 * model) stay under Advanced.
 */
export default function ModelProvidersClient({ teamId, isAdmin, workspaces = [] }: {
  teamId: string;
  /** Fallback for the Advanced sections until the list loads. */
  isAdmin: boolean;
  /** The team's workspaces, for the Workspace tab and the agent endpoint. */
  workspaces?: EndpointWorkspace[];
}) {
  const params = useSearchParams();
  const initialScope = params.get('scope');
  const [scope, setScope] = useState<ProviderApiScope>(isScopeTab(initialScope) ? initialScope : 'team');
  const [workspaceId, setWorkspaceId] = useState<string | null>(workspaces[0]?.id ?? null);
  const [data, setData] = useState<ListProvidersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped when the gateway changes: the sections that route through it reload.
  const [gatewayRev, setGatewayRev] = useState(0);

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ teamId });
      if (workspaceId) qs.set('workspaceId', workspaceId);
      const res = await fetch(`/api/providers?${qs}`);
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Could not load providers');
      setData(await res.json() as ListProvidersResponse);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load providers');
    }
  }, [teamId, workspaceId]);

  useEffect(() => { void load(); }, [load]);

  const flow = providerFlowMessage(params);
  const canManageRouting = data ? data.caller.can.manage_inference_providers : isAdmin;
  const labelOf = (id: string) => data?.providers.find((p) => p.id === id)?.label ?? id;
  const tabDisabled = (id: ProviderApiScope) => (id === 'workspace' && workspaces.length === 0) || (id === 'mine' && data?.caller.canSetMine === false);

  return (
    <div className="space-y-8">
      {flow && (
        <p role={flow.tone === 'err' ? 'alert' : 'status'} className={`text-body ${flow.tone === 'ok' ? 'text-status-success' : 'text-status-error'}`}>{flow.text}</p>
      )}
      {error && <div className="notice notice-err text-meta">{error}</div>}

      {data && (
        <CredentialPolicySelector
          teamId={teamId}
          policy={data.policy}
          canManage={data.caller.can.manage_team_settings}
          onSaved={(policy) => setData((d) => (d ? { ...d, policy } : d))}
        />
      )}

      <section aria-labelledby="providers-h">
        <h2 id="providers-h" className="section-label mb-3">Providers</h2>
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <div className="seg" role="tablist" aria-label="Scope">
            {SCOPE_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={scope === t.id}
                data-testid={`scope-tab-${t.id}`}
                className={`seg-item h-11 md:h-8 ${scope === t.id ? 'seg-item-active' : ''}`}
                disabled={tabDisabled(t.id)}
                onClick={() => setScope(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          {scope === 'workspace' && workspaces.length > 0 && (
            <div className="min-w-0 w-full sm:w-64">
              <Select
                value={workspaceId ?? ''}
                onChange={(v) => setWorkspaceId(v || null)}
                options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
                aria-label="Workspace"
                sheetTitle="Workspace"
                testId="scope-workspace"
              />
            </div>
          )}
        </div>

        {data && (
          <dl className="inset-panel mb-3 space-y-1 text-meta" data-testid="provider-coverage" aria-label="What is covered">
            {coverageView(data).map((l) => (
              <div key={l.surface} className="flex flex-wrap gap-x-2" data-testid={`coverage-${l.surface}`} data-covered={l.usedBy.length > 0 ? 'true' : 'false'}>
                <dt className="w-44 shrink-0 text-text-secondary">{l.label}</dt>
                <dd className={`min-w-0 break-words ${l.usedBy.length ? 'text-text-primary' : 'text-text-muted'}`}>{coverageText(l)}</dd>
              </div>
            ))}
            <p className="pt-1 text-text-muted">
              A provider key picks the route, not the model: an OpenAI key runs OpenAI models in chat and Codex.
              Claude Code and cloud coding need an Anthropic-compatible route (Anthropic, OpenRouter or a gateway).
              A ChatGPT login is a separate seat that signs in Codex only; it never serves chat.
            </p>
          </dl>
        )}

        <div className="space-y-2.5" role="tabpanel">
          {data
            ? data.providers.map((p) => (
              <ProviderCard
                key={p.id}
                provider={p}
                scope={scope}
                data={data}
                workspaceId={workspaceId}
                onChanged={load}
                labelOf={labelOf}
              />
            ))
            : !error && <p className="text-body text-text-muted">Loading…</p>}
        </div>
      </section>

      <section id={ADVANCED_ANCHOR} aria-labelledby="advanced-h" className="scroll-mt-20 space-y-8">
        <div>
          <h2 id="advanced-h" className="section-label mb-1.5">Advanced</h2>
          <p className="text-meta text-text-muted">
            Gateway, agent routing and the decision model. Runner backends and seats are on{' '}
            <Link href="/app/settings/runners#agent-backends" className="underline hover:text-text-primary">Runners</Link>.
          </p>
        </div>
        <GatewayCard teamId={teamId} canManage={canManageRouting} onChanged={() => { setGatewayRev((r) => r + 1); void load(); }} />
        <DecisionModelPicker teamId={teamId} canManage={canManageRouting} rev={gatewayRev} />
        <AgentEndpointSection teamId={teamId} canManage={canManageRouting} workspaces={workspaces} rev={gatewayRev} />
      </section>
    </div>
  );
}
