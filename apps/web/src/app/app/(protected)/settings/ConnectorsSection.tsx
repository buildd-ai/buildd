'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';

interface Workspace {
  id: string;
  name: string;
}

interface Connector {
  id: string;
  name: string;
  url: string;
  authMode: 'none' | 'header' | 'oauth';
  status: 'connected' | 'expired' | 'not_connected';
}

interface ConnectorWithWorkspaces extends Connector {
  enabledWorkspaceIds: Set<string>;
}

export default function ConnectorsSection({ workspaces }: { workspaces: Workspace[] }) {
  const [connectors, setConnectors] = useState<ConnectorWithWorkspaces[]>([]);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [connRes, ...wsResults] = await Promise.all([
        fetch('/api/connectors'),
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
  }, [workspaces]);

  useEffect(() => {
    void load();
  }, [load]);

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

  return (
    <section>
      <div className="flex justify-between items-center mb-4">
        <h2 className="section-label">Connectors</h2>
        <Link
          href="/app/connections"
          className="text-sm text-text-secondary hover:text-text-primary transition-colors"
        >
          Manage
        </Link>
      </div>

      {message && (
        <div className={`mb-4 p-3 rounded-lg text-sm ${
          message.type === 'success'
            ? 'bg-status-success/10 text-status-success border border-status-success/30'
            : 'bg-status-error/10 text-status-error border border-status-error/30'
        }`}>
          {message.text}
        </div>
      )}

      {loading ? (
        <div className="text-text-secondary text-sm">Loading...</div>
      ) : connectors.length === 0 ? (
        <div className="card p-6 text-center">
          <p className="text-text-muted mb-3 text-sm">No connectors yet</p>
          <Link href="/app/connections" className="text-sm text-primary hover:underline">
            Add a connection
          </Link>
        </div>
      ) : (
        <div className="card divide-y divide-border-default">
          {connectors.map((connector) => (
            <div key={connector.id} className="p-4">
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-sm font-medium text-text-primary">{connector.name}</span>
                    <span className="text-xs text-text-muted font-mono">{connector.authMode}</span>
                  </div>
                  <div className="text-xs text-text-muted font-mono truncate">{connector.url}</div>
                </div>
                {workspaces.length === 1 ? (
                  <button
                    onClick={() => toggleWorkspace(
                      connector.id,
                      workspaces[0].id,
                      !connector.enabledWorkspaceIds.has(workspaces[0].id),
                    )}
                    disabled={toggling === `${connector.id}:${workspaces[0].id}`}
                    className={`px-3 py-1.5 text-xs rounded-md border transition-colors disabled:opacity-50 ${
                      connector.enabledWorkspaceIds.has(workspaces[0].id)
                        ? 'border-status-success/40 text-status-success bg-status-success/10'
                        : 'border-border-default text-text-secondary'
                    }`}
                  >
                    {connector.enabledWorkspaceIds.has(workspaces[0].id) ? 'Enabled' : 'Disabled'}
                  </button>
                ) : null}
              </div>

              {workspaces.length > 1 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {workspaces.map(ws => {
                    const enabled = connector.enabledWorkspaceIds.has(ws.id);
                    const key = `${connector.id}:${ws.id}`;
                    return (
                      <button
                        key={ws.id}
                        onClick={() => toggleWorkspace(connector.id, ws.id, !enabled)}
                        disabled={toggling === key}
                        className={`px-2.5 py-1 text-xs rounded-md border transition-colors disabled:opacity-50 ${
                          enabled
                            ? 'border-status-success/40 text-status-success bg-status-success/10'
                            : 'border-border-default text-text-muted'
                        }`}
                      >
                        {enabled ? '✓ ' : ''}{ws.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
