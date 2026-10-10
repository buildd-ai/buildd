'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import type { ListProvidersResponse, ProviderApiScope } from '@buildd/shared';
import { providerFlowMessage } from '@/components/settings/ConnectOpenRouterButton';
import { Select } from '@/components/ui/Select';
import Section from '@/components/ui/Section';
import Notice from '@/components/ui/Notice';
import CredentialPolicySelector from './CredentialPolicySelector';
import ProviderRow from './ProviderCard';
import { DecisionModelPicker, GatewayCard } from './GatewayAndDecisionModel';
import AgentEndpointSection, { type EndpointWorkspace } from './AgentEndpointSection';
import { ADVANCED_ANCHOR, SCOPE_TABS, groupProviders, isScopeTab } from './providers-view';

/**
 * Settings → Models, the Keys and Routing sections. Keys: every model provider
 * in registry order, one row each (Claude and OpenAI each group their key and
 * subscription into one row), at the scope picked in the tabs (Team /
 * Workspace / Mine). "Who pays" shows only once it matters: a personal key
 * exists in the team, or the policy is no longer the default. Built on
 * `/api/providers`: what a provider serves, the scopes it can be stored at and
 * what each stored row serves today come from the response, never from a copy
 * here. Keys never come back beyond last4.
 *
 * Routing: what the cards don't cover (gateway, agent endpoint, decision
 * model). A gateway change reloads the cards, so both sections live in one
 * component; `between` renders between them (the page's Runner sign-ins).
 */
export default function ModelProvidersClient({ teamId, isAdmin, workspaces = [], between }: {
  teamId: string;
  /** Fallback for the Routing section until the list loads. */
  isAdmin: boolean;
  /** The team's workspaces, for the Workspace tab and the agent endpoint. */
  workspaces?: EndpointWorkspace[];
  /** Rendered between Keys and Routing. */
  between?: ReactNode;
}) {
  const params = useSearchParams();
  const initialScope = params.get('scope');
  const [scope, setScope] = useState<ProviderApiScope>(isScopeTab(initialScope) ? initialScope : 'team');
  const [workspaceId, setWorkspaceId] = useState<string | null>(workspaces[0]?.id ?? null);
  const [data, setData] = useState<ListProvidersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped when the gateway changes: the sections that route through it reload.
  const [gatewayRev, setGatewayRev] = useState(0);
  // One row open at a time.
  const [openRow, setOpenRow] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ teamId });
      if (workspaceId) qs.set('workspaceId', workspaceId);
      const res = await fetch(`/api/providers?${qs}`);
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? LOAD_ERROR);
      setData(await res.json() as ListProvidersResponse);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : LOAD_ERROR);
    }
  }, [teamId, workspaceId]);

  useEffect(() => { void load(); }, [load]);

  const flow = providerFlowMessage(params);
  const canManageRouting = data ? data.caller.can.manage_inference_providers : isAdmin;
  const tabDisabled = (id: ProviderApiScope) => (id === 'workspace' && workspaces.length === 0) || (id === 'mine' && data?.caller.canSetMine === false);

  return (
    <>
      <Section title="Keys" id="keys" className="scroll-mt-20">
        {/* Old links: /app/settings/providers and #provider-keys land here. */}
        <span id="provider-keys" aria-hidden="true" />
        <div className="space-y-6">
          {flow && (
            <p role={flow.tone === 'err' ? 'alert' : 'status'} className={`text-body ${flow.tone === 'ok' ? 'text-status-success' : 'text-status-error'}`}>{flow.text}</p>
          )}
          {error && (
            <Notice tone="err" action={{ label: 'Retry', onClick: () => { void load(); } }} data-testid="providers-load-error">
              {LOAD_ERROR}
            </Notice>
          )}

          {data && showWhoPays(data) && (
            <CredentialPolicySelector
              teamId={teamId}
              policy={data.policy}
              canManage={data.caller.can.manage_team_settings}
              onSaved={(policy) => setData((d) => (d ? { ...d, policy } : d))}
            />
          )}

          <div>
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
              {/* Not a second scope picker: it picks which workspace. */}
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

            <div role="tabpanel">
              {data
                ? (
                  <ul className="border-y border-border-default divide-y divide-border-default">
                    {groupProviders(data.providers).map((g) => (
                      <ProviderRow
                        key={`${scope}-${g.id}`}
                        group={g}
                        scope={scope}
                        data={data}
                        workspaceId={workspaceId}
                        onChanged={load}
                        open={openRow === g.id}
                        onToggle={(o) => setOpenRow(o ? g.id : null)}
                      />
                    ))}
                  </ul>
                )
                : !error && <p className="text-body text-text-muted">Loading…</p>}
            </div>
          </div>
        </div>
      </Section>

      {between}

      <Section title="Routing" id={ADVANCED_ANCHOR} className="scroll-mt-20">
        {/* Old #advanced links (the section's previous name). */}
        <span id="advanced" aria-hidden="true" />
        <div className="space-y-8">
          <p className="text-meta text-text-muted">Gateway, agent endpoint and the decision model.</p>
          <GatewayCard teamId={teamId} canManage={canManageRouting} onChanged={() => { setGatewayRev((r) => r + 1); void load(); }} />
          <DecisionModelPicker teamId={teamId} canManage={canManageRouting} rev={gatewayRev} />
          <AgentEndpointSection teamId={teamId} canManage={canManageRouting} workspaces={workspaces} rev={gatewayRev} />
        </div>
      </Section>
    </>
  );
}

const LOAD_ERROR = "Couldn't load your providers.";

/** "Who pays" matters once someone in the team has a personal key, or the policy was changed. */
export function showWhoPays(data: Pick<ListProvidersResponse, 'policy' | 'personalKeyCount' | 'providers'>): boolean {
  if (data.policy.credentialPolicy && data.policy.credentialPolicy !== 'team') return true;
  if ((data.personalKeyCount ?? 0) > 0) return true;
  return data.providers.some((p) => (p.set.mine?.length ?? 0) > 0);
}
