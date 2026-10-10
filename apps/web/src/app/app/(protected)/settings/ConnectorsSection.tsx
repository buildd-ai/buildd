'use client';

import { useState, useEffect, useCallback } from 'react';
import Section from '@/components/ui/Section';
import Notice from '@/components/ui/Notice';
import { TonePill } from '@/components/ui/StatePill';
import { Select } from '@/components/ui/Select';
import { ConnectorIcon } from '@/components/ConnectorIcon';

interface Workspace {
  id: string;
  name: string;
  /** The workspace's team: turning a connector on or off there needs manage_connectors in it. */
  teamId?: string;
}

interface Team {
  id: string;
  name: string;
}

interface Connector {
  id: string;
  name: string;
  url: string;
  authMode: 'none' | 'header' | 'oauth';
  status: 'connected' | 'expired' | 'not_connected';
  /** Present when the connector is shared *to* the current team (spec §1b).
   * Shared-in connectors are enable-only here; owner controls live with the
   * owner team on Settings → MCP connectors. */
  shared?: boolean;
  ownerTeamName?: string | null;
  iconUrl?: string | null;
}

interface ConnectorWithWorkspaces extends Connector {
  enabledWorkspaceIds: Set<string>;
}

export default function ConnectorsSection({
  workspaces,
  teams = [],
  currentTeamId = null,
  manageableTeamIds,
}: {
  workspaces: Workspace[];
  teams?: Team[];
  currentTeamId?: string | null;
  /**
   * Teams where the person holds `manage_connectors` (overrides applied). A
   * workspace outside them shows whether a connector is on, read-only, and a
   * connector of another team gets no Reconnect. Omitted = every team.
   */
  manageableTeamIds?: string[];
}) {
  const [connectors, setConnectors] = useState<ConnectorWithWorkspaces[]>([]);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // Which team's connectors to show. Without this the API falls back to the user's
  // *first* team, so connectors owned by any other team are invisible here — which
  // makes a transferred connector look lost and leads to duplicate re-creation.
  const [selectedTeamId, setSelectedTeamId] = useState<string>(currentTeamId ?? teams[0]?.id ?? '');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const connUrl = selectedTeamId ? `/api/connectors?teamId=${selectedTeamId}` : '/api/connectors';
      const [connRes, ...wsResults] = await Promise.all([
        fetch(connUrl),
        ...workspaces.map(ws => fetch(`/api/workspaces/${ws.id}/connectors`)),
      ]);

      const connData = connRes.ok ? await connRes.json() : { connectors: [] };
      const baseConnectors: Connector[] = connData.connectors ?? [];

      // Build a map: connectorId → Set of workspaceIds where it's enabled
      const enabledMap = new Map<string, Set<string>>();
      for (let i = 0; i < workspaces.length; i++) {
        if (wsResults[i].ok) {
          const wsData = await wsResults[i].json();
          for (const c of wsData.connectors ?? []) {
            if (!enabledMap.has(c.id)) enabledMap.set(c.id, new Set());
            enabledMap.get(c.id)!.add(workspaces[i].id);
          }
        }
      }

      setConnectors(baseConnectors.map(c => ({
        ...c,
        enabledWorkspaceIds: enabledMap.get(c.id) ?? new Set(),
      })));
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [workspaces, selectedTeamId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Re-run the OAuth authorization flow for an expired/dead credential. Reuses the
  // same POST /connect → authorizationUrl redirect that ConnectionsClient uses to
  // connect — no new endpoint.
  async function handleReconnect(connectorId: string) {
    setReconnecting(connectorId);
    setMessage(null);
    try {
      const res = await fetch(`/api/connectors/${connectorId}/connect`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        window.location.href = data.authorizationUrl;
      } else {
        const err = await res.json();
        setMessage({ type: 'error', text: err.error || 'Failed to start reconnect' });
        setReconnecting(null);
      }
    } catch {
      setMessage({ type: 'error', text: 'Failed to start reconnect' });
      setReconnecting(null);
    }
  }

  async function toggleWorkspace(connectorId: string, workspaceId: string, enabled: boolean) {
    const key = `${connectorId}:${workspaceId}`;
    setToggling(key);
    setMessage(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/connectors`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connectorId, enabled }),
      });
      if (res.ok) {
        setConnectors(prev => prev.map(c => {
          if (c.id !== connectorId) return c;
          const next = new Set(c.enabledWorkspaceIds);
          if (enabled) next.add(workspaceId); else next.delete(workspaceId);
          return { ...c, enabledWorkspaceIds: next };
        }));
      } else {
        const err = await res.json();
        setMessage({ type: 'error', text: err.error || 'Failed to update' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Failed to update' });
    } finally {
      setToggling(null);
    }
  }

  const manages = (teamId: string | undefined) => !manageableTeamIds || (!!teamId && manageableTeamIds.includes(teamId));
  const canReconnect = manages(selectedTeamId);
  const anyEditable = workspaces.some((ws) => manages(ws.teamId));

  // Nothing to grant yet: the Add button above is the whole story. With several
  // teams the section stays, since its header holds the team switch.
  if (!loading && connectors.length === 0 && !message && teams.length <= 1) return null;

  return (
    <Section
      title="Workspace access"
      action={
        <div className="flex items-center gap-2 min-w-0">
          {!anyEditable && !loading && connectors.length > 0 && (
            <span data-testid="workspace-access-read-only" className="text-xs text-text-muted">Admins can change this.</span>
          )}
          {teams.length > 1 && (
            <Select
              aria-label="Team"
              size="sm"
              value={selectedTeamId}
              onChange={setSelectedTeamId}
              options={teams.map((t) => ({ value: t.id, label: t.name }))}
              className="min-w-[10rem] max-w-[16rem]"
            />
          )}
        </div>
      }
    >
      {message && (
        <Notice tone={message.type === 'success' ? 'ok' : 'err'} className="mb-3">
          {message.text}
        </Notice>
      )}

      {loading ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : connectors.length === 0 ? (
        <p className="text-sm text-text-muted">Add a connector above, then choose its workspaces here.</p>
      ) : (
        <ul className="divide-y divide-border-default">
          {connectors.map((connector) => (
            <li key={connector.id} className="py-3">
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  {/* Auth mode and URL live in the connector's Details above. */}
                  <div className="flex flex-wrap items-center gap-2">
                    <ConnectorIcon name={connector.name} iconUrl={connector.iconUrl} size={18} />
                    <span className="text-sm font-medium text-text-primary">{connector.name}</span>
                    {connector.shared && (
                      <TonePill tone="q">Shared by {connector.ownerTeamName || 'another team'}</TonePill>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {/* Expired => dead/stale OAuth credential (spec §1b): a distinct
                      warning-toned Reconnect CTA, not the red transient-error banner
                      and not the green connected/enabled state. Grantees can't
                      reconnect a shared-in connector (owner holds the credential). */}
                  {canReconnect && connector.status === 'expired' && !connector.shared && connector.authMode === 'oauth' && (
                    <button
                      onClick={() => handleReconnect(connector.id)}
                      disabled={reconnecting === connector.id}
                      className="btn btn-warning"
                    >
                      {reconnecting === connector.id ? 'Redirecting…' : 'Reconnect'}
                    </button>
                  )}
                  {workspaces.length === 1 && !manages(workspaces[0].teamId) ? (
                    <TonePill tone={connector.enabledWorkspaceIds.has(workspaces[0].id) ? 'ok' : 'q'}>
                      {connector.enabledWorkspaceIds.has(workspaces[0].id) ? 'Enabled' : 'Disabled'}
                    </TonePill>
                  ) : workspaces.length === 1 ? (
                    <button
                      onClick={() => toggleWorkspace(
                        connector.id,
                        workspaces[0].id,
                        !connector.enabledWorkspaceIds.has(workspaces[0].id),
                      )}
                      disabled={toggling === `${connector.id}:${workspaces[0].id}`}
                      className={`btn ${connector.enabledWorkspaceIds.has(workspaces[0].id) ? 'btn-ok' : ''}`}
                    >
                      {connector.enabledWorkspaceIds.has(workspaces[0].id) ? 'Enabled' : 'Disabled'}
                    </button>
                  ) : null}
                </div>
              </div>

              {workspaces.length > 1 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {workspaces.map(ws => {
                    const enabled = connector.enabledWorkspaceIds.has(ws.id);
                    const key = `${connector.id}:${ws.id}`;
                    if (!manages(ws.teamId)) {
                      return (
                        <TonePill key={ws.id} tone={enabled ? 'ok' : 'q'}>
                          {enabled ? '✓ ' : ''}{ws.name}
                        </TonePill>
                      );
                    }
                    return (
                      <button
                        key={ws.id}
                        onClick={() => toggleWorkspace(connector.id, ws.id, !enabled)}
                        disabled={toggling === key}
                        className={`btn btn-sm ${enabled ? 'btn-ok' : ''}`}
                      >
                        {enabled ? '✓ ' : ''}{ws.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
