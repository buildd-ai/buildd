'use client';

import { useState, useEffect } from 'react';
import type { WorkspaceWorkTrackerConfig } from '@buildd/core/db/schema';

interface Connector {
  id: string;
  name: string;
  url: string;
  authMode: string;
  enabled: boolean;
  status: 'connected' | 'expired' | 'not_connected';
}

interface Props {
  workspaceId: string;
  initialWorkTrackerConfig: WorkspaceWorkTrackerConfig | null;
}

function detectProvider(url: string): string {
  if (url.includes('linear.app')) return 'linear';
  if (url.includes('github.com')) return 'github';
  if (url.includes('jira.atlassian.com') || url.includes('atlassian.net')) return 'jira';
  if (url.includes('asana.com')) return 'asana';
  return 'unknown';
}

function ProviderBadge({ provider }: { provider: string }) {
  const labels: Record<string, string> = {
    linear: 'Linear',
    github: 'GitHub',
    jira: 'Jira',
    asana: 'Asana',
    unknown: 'Unknown',
  };
  return (
    <span className="inline-flex items-center gap-1 text-xs bg-surface-3 text-text-secondary px-1.5 py-0.5 rounded">
      {labels[provider] ?? provider}
    </span>
  );
}

export default function WorkTrackerSection({ workspaceId, initialWorkTrackerConfig }: Props) {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [config, setConfig] = useState<WorkspaceWorkTrackerConfig | null>(initialWorkTrackerConfig);
  const [selectedConnectorId, setSelectedConnectorId] = useState<string>(
    initialWorkTrackerConfig?.connectorId ?? '',
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    fetch(`/api/workspaces/${workspaceId}/connectors`)
      .then(r => r.json())
      .then(data => {
        const list: Connector[] = (data.connectors ?? []).filter(
          (c: Connector) => c.status === 'connected',
        );
        setConnectors(list);
      })
      .catch(() => {});
  }, [workspaceId]);

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    try {
      if (!selectedConnectorId) {
        // Clear the work tracker
        const res = await fetch(`/api/workspaces/${workspaceId}/settings`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workTrackerConfig: null }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error ?? 'Failed to save');
        }
        setConfig(null);
        setMessage({ type: 'success', text: 'Work tracker cleared.' });
        return;
      }

      const connector = connectors.find(c => c.id === selectedConnectorId);
      if (!connector) throw new Error('Connector not found');
      const provider = detectProvider(connector.url);

      const res = await fetch(`/api/workspaces/${workspaceId}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workTrackerConfig: { connectorId: selectedConnectorId, provider } }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? 'Failed to save');
      }
      const data = await res.json();
      setConfig(data.workTrackerConfig);
      setMessage({ type: 'success', text: 'Work tracker saved.' });
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to save' });
    } finally {
      setSaving(false);
    }
  }

  const activeConnector = config ? connectors.find(c => c.id === config.connectorId) : null;

  return (
    <div className="mt-8 border border-border-subtle rounded-lg p-6">
      <h2 className="text-lg font-semibold mb-1">Work Tracker</h2>
      <p className="text-sm text-text-muted mb-4">
        Link a connected MCP connector as the issue tracker for this workspace. Agents will
        post completion comments to linked issues.
      </p>

      {config && activeConnector && (
        <div className="mb-4 flex items-center gap-2 text-sm text-text-secondary">
          <span className="w-2 h-2 rounded-full bg-status-success inline-block" />
          Active: <strong>{activeConnector.name}</strong>
          <ProviderBadge provider={config.provider} />
        </div>
      )}

      {connectors.length === 0 ? (
        <p className="text-sm text-text-muted">
          No connected connectors found for this workspace. Enable a connector under the workspace
          connectors settings first.
        </p>
      ) : (
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <label className="block text-sm font-medium mb-1" htmlFor="work-tracker-connector">
              Connector
            </label>
            <select
              id="work-tracker-connector"
              className="w-full border border-border-subtle rounded px-3 py-2 bg-surface-1 text-sm"
              value={selectedConnectorId}
              onChange={e => setSelectedConnectorId(e.target.value)}
            >
              <option value="">— None (disable work tracker) —</option>
              {connectors.map(c => (
                <option key={c.id} value={c.id}>
                  {c.name} ({detectProvider(c.url)})
                </option>
              ))}
            </select>
          </div>

          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 rounded bg-accent text-white text-sm font-medium disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}

      {message && (
        <p className={`mt-2 text-sm ${message.type === 'success' ? 'text-status-success' : 'text-status-error'}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}
