'use client';

import { useCallback, useEffect, useState, type ComponentProps } from 'react';
import { useSearchParams } from 'next/navigation';
import type { ListProvidersResponse, ProviderApiScope } from '@buildd/shared';
import { providerFlowMessage } from '@/components/settings/ConnectOpenRouterButton';
import { Select } from '@/components/ui/Select';
import Section from '@/components/ui/Section';
import Notice from '@/components/ui/Notice';
import CredentialPolicySelector from './CredentialPolicySelector';
import ProviderRow from './ProviderCard';
import { DecisionModelPicker, GatewayCard } from './GatewayAndDecisionModel';
import AgentBackendsSection, { type SignInSlots } from '../AgentBackendsSection';
import AgentEndpointSection, { type EndpointWorkspace } from './AgentEndpointSection';
import { ADVANCED_ANCHOR, coverageText, coverageView, groupProviders, policySentence } from './providers-view';

/**
 * The model keys, one scope per page. `scope="team"` is Settings › Team ›
 * Models: Keys (the team's), Workspace keys (one workspace at a time, picked
 * from a list) and Routing. `scope="mine"` is Settings › You › Keys: your own
 * keys and nothing of the team's to change, with the team's "Who pays" as a
 * line. No page mixes the two.
 *
 * Every model provider in registry order, one row each (Claude and OpenAI each
 * group their key and subscription into one row). "Who pays" shows on Models
 * only once it matters: a personal key exists in the team, or the policy is no
 * longer the default. Built on `/api/providers`: what a provider serves, the
 * scopes it can be stored at and what each stored row serves today come from
 * the response, never from a copy here. Keys never come back beyond last4.
 *
 * On Models a provider row shows every way it is connected in its opened
 * detail: the key, a subscription sign-in and a runner sign-in (`signIns`, the
 * Claude and Codex logins, at the row's scope). There is no separate sign-ins
 * section.
 *
 * Routing: what the cards don't cover (gateway, agent endpoint, decision
 * model) and the provider routing toggle. A gateway change reloads the cards,
 * so both sections live in one component.
 */
export default function ModelProvidersClient({ teamId, isAdmin, workspaces = [], signIns, scope = 'team' }: {
  teamId: string;
  /** Fallback for the Routing section until the list loads. */
  isAdmin: boolean;
  /** The team's workspaces, for Workspace keys and the agent endpoint. */
  workspaces?: EndpointWorkspace[];
  /** Props for the sign-ins folded into the Claude and OpenAI rows. Omitted: the rows hold keys only. */
  signIns?: Pick<ComponentProps<typeof AgentBackendsSection>, 'workspaces' | 'currentTeamId' | 'manageableTeamIds' | 'canManage' | 'canManageRouting'>;
  /** Whose keys this page holds: the team's (Models) or yours (Keys). */
  scope?: 'team' | 'mine';
}) {
  const params = useSearchParams();
  const [workspaceId, setWorkspaceId] = useState<string | null>(workspaces[0]?.id ?? null);
  const [data, setData] = useState<ListProvidersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped when the gateway changes: the sections that route through it reload.
  const [gatewayRev, setGatewayRev] = useState(0);
  // One row open at a time, across both lists: `<scope>:<group>`.
  const [openRow, setOpenRow] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ teamId });
      if (workspaceId && scope === 'team') qs.set('workspaceId', workspaceId);
      const res = await fetch(`/api/providers?${qs}`);
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? LOAD_ERROR);
      setData(await res.json() as ListProvidersResponse);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : LOAD_ERROR);
    }
  }, [teamId, workspaceId, scope]);

  useEffect(() => { void load(); }, [load]);

  // Old deep link (getting-started, failed-task page): open the Claude row on its key field.
  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.hash === '#agent-key') setOpenRow(`${scope}:claude`);
  }, [scope]);

  const flow = providerFlowMessage(params);
  const canManageRouting = data ? data.caller.can.manage_inference_providers : isAdmin;

  const list = (rowScope: ProviderApiScope, slots: SignInSlots | null, testId: string) => (
    data
      ? (
        <ul className="border-y border-border-default divide-y divide-border-default" data-testid={testId}>
          {groupProviders(data.providers).map((g) => {
            const key = `${rowScope}:${g.id}`;
            return (
              <ProviderRow
                key={key}
                group={g}
                scope={rowScope}
                data={data}
                workspaceId={workspaceId}
                onChanged={load}
                open={openRow === key}
                onToggle={(o) => setOpenRow(o ? key : null)}
                signIn={!slots ? null : g.id === 'claude' ? slots.claude : g.id === 'openai' ? slots.openai : null}
              />
            );
          })}
        </ul>
      )
      : !error && <p className="text-body text-text-muted">Loading…</p>
  );

  const status = (
    <>
      {flow && (
        <p role={flow.tone === 'err' ? 'alert' : 'status'} className={`text-body ${flow.tone === 'ok' ? 'text-status-success' : 'text-status-error'}`}>{flow.text}</p>
      )}
      {error && (
        <Notice tone="err" action={{ label: 'Retry', onClick: () => { void load(); } }} data-testid="providers-load-error">
          {LOAD_ERROR}
        </Notice>
      )}
    </>
  );

  if (scope === 'mine') {
    return (
      <Section title="Your keys" id="keys" className="scroll-mt-20">
        <div className="space-y-6">
          {status}
          {data && (
            <p className="text-body text-text-secondary" data-testid="credential-policy-line">
              <span className="font-semibold text-text-primary">Who pays: </span>{policySentence(data.policy)}
            </p>
          )}
          {list('mine', null, 'provider-list-mine')}
        </div>
      </Section>
    );
  }

  const render = (slots: SignInSlots | null, workspaceSlots: SignInSlots | null) => (
    <>
      <Section title="Keys" id="keys" className="scroll-mt-20">
        {/* Old links: /app/settings/providers and #provider-keys land here. */}
        <span id="provider-keys" aria-hidden="true" />
        {/* Old links: #sign-ins, #agent-backends (the sign-ins section these rows now hold). */}
        <span id="sign-ins" aria-hidden="true" />
        <span id="agent-backends" aria-hidden="true" />
        <div className="space-y-6">
          {status}

          {slots?.notice}

          {data && showWhoPays(data) && (
            <CredentialPolicySelector
              teamId={teamId}
              policy={data.policy}
              canManage={data.caller.can.manage_team_settings}
              onSaved={(policy) => setData((d) => (d ? { ...d, policy } : d))}
            />
          )}

          <div>
            {data && (
              <dl className="inset-panel mb-3 space-y-1 text-meta" data-testid="provider-coverage" aria-label="What is covered">
                {coverageView(data).map((l) => (
                  <div key={l.surface} className="flex flex-wrap gap-x-2" data-testid={`coverage-${l.surface}`} data-covered={l.usedBy.length > 0 ? 'true' : 'false'}>
                    <dt className="w-44 shrink-0 text-text-secondary">{l.label}</dt>
                    <dd className={`min-w-0 break-words ${l.usedBy.length ? 'text-text-primary' : 'text-text-muted'}`}>{coverageText(l)}</dd>
                  </div>
                ))}
                <p className="pt-1 text-text-muted">
                  Claude Code and cloud coding need an Anthropic-compatible route. A ChatGPT login signs in Codex only.
                </p>
              </dl>
            )}
            {list('team', slots, 'provider-list-team')}
          </div>
        </div>
      </Section>

      {workspaces.length > 0 && (
        <Section title="Workspace keys" id="workspace-keys" className="scroll-mt-20">
          <div className="space-y-3">
            <p className="text-meta text-text-muted">A workspace key is used for that workspace&apos;s work in place of the team key.</p>
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
            {list('workspace', workspaceSlots, 'provider-list-workspace')}
          </div>
        </Section>
      )}

      <Section title="Routing" id={ADVANCED_ANCHOR} className="scroll-mt-20">
        {/* Old #advanced links (the section's previous name). */}
        <span id="advanced" aria-hidden="true" />
        <div className="space-y-8">
          <p className="text-meta text-text-muted">Gateway, agent endpoint and the decision model.</p>
          <GatewayCard teamId={teamId} canManage={canManageRouting} onChanged={() => { setGatewayRev((r) => r + 1); void load(); }} />
          <DecisionModelPicker teamId={teamId} canManage={canManageRouting} rev={gatewayRev} />
          <AgentEndpointSection teamId={teamId} canManage={canManageRouting} workspaces={workspaces} rev={gatewayRev} />
          {slots && <div className="border-y border-border-default">{slots.routing}</div>}
        </div>
      </Section>
    </>
  );

  if (!signIns || signIns.workspaces.length === 0) return render(null, null);
  // Two sign-in sets: the team's for the Keys rows, the picked workspace's for
  // Workspace keys. Only the team's notice and routing row are drawn.
  return (
    <AgentBackendsSection {...signIns} scope="team" workspaceId={null}>
      {(teamSlots) => (
        workspaceId
          ? (
            <AgentBackendsSection {...signIns} scope="workspace" workspaceId={workspaceId}>
              {(wsSlots) => render(teamSlots, wsSlots)}
            </AgentBackendsSection>
          )
          : render(teamSlots, null)
      )}
    </AgentBackendsSection>
  );
}

const LOAD_ERROR = "Couldn't load your providers.";

/** "Who pays" matters once someone in the team has a personal key, or the policy was changed. */
export function showWhoPays(data: Pick<ListProvidersResponse, 'policy' | 'personalKeyCount' | 'providers'>): boolean {
  if (data.policy.credentialPolicy && data.policy.credentialPolicy !== 'team') return true;
  if ((data.personalKeyCount ?? 0) > 0) return true;
  return data.providers.some((p) => (p.set.mine?.length ?? 0) > 0);
}
