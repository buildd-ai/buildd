'use client';

import { useCallback, useEffect, useState, type ComponentProps } from 'react';
import { useSearchParams } from 'next/navigation';
import type { ListProvidersResponse, ProviderApiScope } from '@buildd/shared';
import { providerFlowMessage } from '@/components/settings/ConnectOpenRouterButton';
import Link from 'next/link';
import Section from '@/components/ui/Section';
import Notice from '@/components/ui/Notice';
import StoredPolicyNotice from './StoredPolicyNotice';
import ProviderRow from './ProviderCard';
import { DecisionModelPicker, GatewayCard } from './GatewayAndDecisionModel';
import AgentBackendsSection, { type SignInSlots } from '../AgentBackendsSection';
import AgentEndpointSection, { type EndpointWorkspace } from './AgentEndpointSection';
import { connectedProviders, groupProviders, keyRuleLine, providersTitle, storedPolicyLine, usesTeamLine } from './providers-view';
import UsedForSection from './UsedForSection';

/**
 * The model keys, one scope per page. `scope="team"` is Settings › Team ›
 * Models: Providers (the team's, plus one line naming the workspaces that
 * use their own keys) and Used for (only once two or more are connected).
 * `scope="workspace"` is that workspace's settings page: "Uses <team>'s
 * settings" until an admin overrides, then the workspace's own rows, an
 * inherited one reading "<team>'s key". The team page's heading names the
 * team ("Providers · <team>") for someone in more than one. `scope="mine"` is
 * Settings › You › Keys: your own keys and nothing of the team's to change,
 * with the key rule as a line. No page mixes scopes.
 *
 * Every model provider in registry order, one row each (Claude and OpenAI each
 * group their key and subscription into one row). Whose key has no setting:
 * a person's own key goes first, the team's is the fallback. Only a team that
 * stored another policy sees a line about it, with a way back to the default.
 * Built on `/api/providers`: what a provider serves, the
 * scopes it can be stored at and what each stored row serves today come from
 * the response, never from a copy here. Keys never come back beyond last4.
 *
 * On Models a provider row shows every way it is connected in its opened
 * detail: the key, a subscription sign-in and a runner sign-in (`signIns`, the
 * Claude and Codex logins, at the row's scope). There is no separate sign-ins
 * section.
 *
 * The LiteLLM gateway and a custom endpoint are rows like any other; their
 * forms open in the row. A gateway change reloads the rows and the decision
 * model, so all of it lives in one component. The decision model is a platform
 * operator control (lib/admin/platform-operator-caller.ts): its Used for row renders for an
 * operator only, editable when they also hold the `manage_team_settings` its
 * route checks.
 */
export default function ModelProvidersClient({ teamId, isAdmin, operator = false, workspaces = [], signIns, scope = 'team', workspaceId: fixedWorkspaceId = null }: {
  teamId: string;
  /** Fallback for the Routing section until the list loads. */
  isAdmin: boolean;
  /** A platform operator: the decision model row renders. */
  operator?: boolean;
  /** The team's workspaces, for Workspace keys and the agent endpoint. */
  workspaces?: EndpointWorkspace[];
  /** Props for the sign-ins folded into the Claude and OpenAI rows. Omitted: the rows hold keys only. */
  signIns?: Pick<ComponentProps<typeof AgentBackendsSection>, 'workspaces' | 'currentTeamId' | 'manageableTeamIds' | 'canManage' | 'canManageRouting'>;
  /** Whose keys this page holds: the team's (Models), one workspace's (its settings page) or yours (Keys). */
  scope?: 'team' | 'workspace' | 'mine';
  /** With scope "workspace": the workspace whose own keys these are. */
  workspaceId?: string | null;
}) {
  const params = useSearchParams();
  const workspaceId = scope === 'workspace' ? fixedWorkspaceId : null;
  // A workspace with nothing of its own shows "Uses <team>'s settings" until an admin overrides.
  const [overriding, setOverriding] = useState(false);
  const [data, setData] = useState<ListProvidersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped when the gateway changes: the sections that route through it reload.
  const [gatewayRev, setGatewayRev] = useState(0);
  // One row open at a time, across both lists: `<scope>:<group>`.
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
  }, [teamId, workspaceId, scope]);

  useEffect(() => { void load(); }, [load]);

  // Old deep link (getting-started, failed-task page): open the Claude row on its key field.
  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.hash === '#agent-key') setOpenRow(`${scope}:claude`);
  }, [scope]);

  // Old #workspace-keys links: the section moved to each workspace's own settings.
  useEffect(() => {
    if (scope !== 'team' || !data || typeof window === 'undefined' || window.location.hash !== '#workspace-keys') return;
    const first = data.workspacesWithKeys?.[0];
    window.location.replace(first ? `/app/settings/workspace/${first}#models` : '/app/settings/workspaces');
  }, [scope, data]);

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
                form={rowScope === 'workspace'
                  ? (g.id === 'custom-endpoint' ? <AgentEndpointSection teamId={teamId} canManage={canManageRouting} workspaces={workspaces.filter((w) => w.id === workspaceId)} rev={gatewayRev} embedded scope={{ workspaceId: workspaceId! }} /> : null)
                  : rowScope !== 'team' ? null
                  : g.id === 'litellm' ? <GatewayCard teamId={teamId} canManage={canManageRouting} embedded onChanged={() => { setGatewayRev((r) => r + 1); void load(); }} />
                  : g.id === 'custom-endpoint' ? <AgentEndpointSection teamId={teamId} canManage={canManageRouting} workspaces={workspaces} rev={gatewayRev} embedded scope="team" />
                  : null}
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
            <p className="text-body text-text-secondary" data-testid="credential-policy-line">{keyRuleLine(data.policy)}</p>
          )}
          {list('mine', null, 'provider-list-mine')}
        </div>
      </Section>
    );
  }

  const render = (slots: SignInSlots | null) => (
    <>
      <Section title={providersTitle(data)} id="keys" className="scroll-mt-20">
        <span id="providers" aria-hidden="true" />
        {/* Old links: #routing, #advanced (the removed Routing section; the gateway and endpoint are rows now). */}
        <span id="routing" aria-hidden="true" />
        <span id="advanced" aria-hidden="true" />
        {/* Old links: /app/settings/providers and #provider-keys land here. */}
        <span id="provider-keys" aria-hidden="true" />
        {/* Old links: #sign-ins, #agent-backends (the sign-ins section these rows now hold). */}
        <span id="sign-ins" aria-hidden="true" />
        <span id="agent-backends" aria-hidden="true" />
        <div className="space-y-6">
          {status}

          {slots?.notice}

          {data && storedPolicyLine(data.policy) && (
            <StoredPolicyNotice
              teamId={teamId}
              policy={data.policy}
              canManage={data.caller.can.manage_team_settings}
              onSaved={(policy) => setData((d) => (d ? { ...d, policy } : d))}
            />
          )}

          {list('team', slots, 'provider-list-team')}

          {data && <WorkspacesWithKeys ids={data.workspacesWithKeys ?? []} workspaces={workspaces} />}
        </div>
      </Section>

      {data && (
        <UsedForSection
          teamId={teamId}
          data={data}
          canManage={data.caller.can.manage_team_settings}
          decisions={operator ? <DecisionModelPicker teamId={teamId} canManage={data.caller.can.manage_team_settings} rev={gatewayRev} embedded /> : undefined}
          extra={slots && bothBackends(data) ? <div className="border-y border-border-default">{slots.routing}</div> : null}
        />
      )}


    </>
  );

  if (scope === 'workspace') {
    const own = !!data && data.providers.some((p) => (p.set.workspace ?? []).length > 0);
    const canOverride = !!data && (data.caller.can.manage_team_credentials || data.caller.can.manage_team_model_keys);
    const body = (slots: SignInSlots | null) => (
      <Section title="Models" id="models" className="scroll-mt-20">
        <div className="space-y-3">
          {status}
          {data && !own && !overriding && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2" data-testid="workspace-uses-team">
              <p className="text-body text-text-secondary">{usesTeamLine(data.teamName)}</p>
              {canOverride && <button type="button" className="btn" onClick={() => setOverriding(true)}>Override</button>}
            </div>
          )}
          {(own || overriding) && list('workspace', slots, 'provider-list-workspace')}
        </div>
      </Section>
    );
    if (!signIns || !workspaceId) return body(null);
    return (
      <AgentBackendsSection {...signIns} scope="workspace" workspaceId={workspaceId}>
        {(wsSlots) => body(wsSlots)}
      </AgentBackendsSection>
    );
  }

  if (!signIns || signIns.workspaces.length === 0) return render(null);
  return (
    <AgentBackendsSection {...signIns} scope="team" workspaceId={null}>
      {(teamSlots) => render(teamSlots)}
    </AgentBackendsSection>
  );
}

/** "2 workspaces use their own keys: api, web." Each name links to that workspace's Models section. */
function WorkspacesWithKeys({ ids, workspaces }: { ids: readonly string[]; workspaces: readonly EndpointWorkspace[] }) {
  const named = ids.map((id) => workspaces.find((w) => w.id === id)).filter((w): w is EndpointWorkspace => !!w);
  if (named.length === 0) return null;
  return (
    <p className="text-body text-text-secondary" data-testid="workspaces-with-keys">
      {named.length === 1 ? '1 workspace uses its own keys: ' : `${named.length} workspaces use their own keys: `}
      {named.map((w, i) => (
        <span key={w.id}>
          {i > 0 && ', '}
          <Link href={`/app/settings/workspace/${w.id}#models`} className="underline text-text-primary hover:no-underline">{w.name}</Link>
        </span>
      ))}
    </p>
  );
}

const LOAD_ERROR = "Couldn't load your providers.";

/** The Claude / Codex switch only means something when the team can run both. */
function bothBackends(data: Pick<ListProvidersResponse, 'providers'>): boolean {
  const ids = connectedProviders(data).map((p) => p.id);
  return ids.some((id) => id === 'anthropic' || id === 'claude-subscription') && ids.some((id) => id === 'openai' || id === 'codex-subscription');
}
