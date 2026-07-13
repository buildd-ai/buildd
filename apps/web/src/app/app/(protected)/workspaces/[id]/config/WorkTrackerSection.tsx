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

// Selection sentinel for "GitHub via the workspace's existing App" (no connector).
const GITHUB_APP = 'github-app';

export default function WorkTrackerSection({ workspaceId, initialWorkTrackerConfig }: Props) {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [config, setConfig] = useState<WorkspaceWorkTrackerConfig | null>(initialWorkTrackerConfig);
  // Selection: '' (none) | GITHUB_APP | a connector id.
  const [selection, setSelection] = useState<string>(
    initialWorkTrackerConfig?.provider === 'github'
      ? GITHUB_APP
      : initialWorkTrackerConfig?.connectorId ?? '',
  );
  const [inboundLabel, setInboundLabel] = useState<string>(initialWorkTrackerConfig?.inboundLabel ?? '');
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

  async function save(body: unknown, successText: string) {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(errorLabel(err.error) ?? 'Failed to save');
      }
      const data = await res.json();
      setConfig(data.workTrackerConfig ?? null);
      setMessage({ type: 'success', text: successText });
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to save' });
    } finally {
      setSaving(false);
    }
  }

  function handleSave() {
    if (!selection) {
      return save({ workTrackerConfig: null }, 'Work tracker cleared.');
    }
    if (selection === GITHUB_APP) {
      const label = inboundLabel.trim();
      return save(
        { workTrackerConfig: { provider: 'github', ...(label ? { inboundLabel: label } : {}) } },
        'Work tracker saved.',
      );
    }
    const connector = connectors.find(c => c.id === selection);
    if (!connector) {
      setMessage({ type: 'error', text: 'Connector not found' });
      return;
    }
    return save(
      { workTrackerConfig: { connectorId: selection, provider: detectProvider(connector.url) } },
      'Work tracker saved.',
    );
  }

  const activeLabel = config
    ? config.provider === 'github'
      ? 'GitHub (repo App)'
      : connectors.find(c => c.id === config.connectorId)?.name ?? 'Connector'
    : null;

  return (
    <div className="mt-8 border border-border-subtle rounded-lg p-6">
      <h2 className="text-lg font-semibold mb-1">Work Tracker</h2>
      <p className="text-sm text-text-muted mb-4">
        Link an issue tracker to this workspace. Agents post a completion comment when a task&apos;s
        PR merges, and an issue labeled with your trigger label opens a linked task.
      </p>

      {config && activeLabel && (
        <div className="mb-4 flex items-center gap-2 text-sm text-text-secondary">
          <span className="w-2 h-2 rounded-full bg-status-success inline-block" />
          Active: <strong>{activeLabel}</strong>
          <ProviderBadge provider={config.provider} />
          {config.provider === 'github' && (
            <span className="text-text-muted">
              · inbound label <code className="bg-surface-3 px-1 rounded">{config.inboundLabel || 'buildd'}</code>
            </span>
          )}
        </div>
      )}

      <div className="flex items-end gap-3">
        <div className="flex-1">
          <label className="block text-sm font-medium mb-1" htmlFor="work-tracker-select">
            Tracker
          </label>
          <select
            id="work-tracker-select"
            className="w-full border border-border-subtle rounded px-3 py-2 bg-surface-1 text-sm"
            value={selection}
            onChange={e => setSelection(e.target.value)}
          >
            <option value="">— None (disable work tracker) —</option>
            <option value={GITHUB_APP}>GitHub (this repo&apos;s App)</option>
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

      {selection === GITHUB_APP && (
        <div className="mt-3">
          <label className="block text-sm font-medium mb-1" htmlFor="work-tracker-label">
            Inbound trigger label
          </label>
          <input
            id="work-tracker-label"
            type="text"
            className="w-full border border-border-subtle rounded px-3 py-2 bg-surface-1 text-sm"
            placeholder="buildd"
            value={inboundLabel}
            onChange={e => setInboundLabel(e.target.value)}
          />
          <p className="mt-1 text-xs text-text-muted">
            A GitHub issue with this label opens a linked task; closing the issue cancels an open
            task. Defaults to <code className="bg-surface-3 px-1 rounded">buildd</code> when blank.
          </p>
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

// Friendlier text for the API's machine error codes.
function errorLabel(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  const map: Record<string, string> = {
    github_app_not_installed: 'This workspace has no GitHub App installation. Install the buildd GitHub App on the repo first.',
    unsupported_provider: 'That tracker provider is not supported.',
  };
  return map[code] ?? code;
}
