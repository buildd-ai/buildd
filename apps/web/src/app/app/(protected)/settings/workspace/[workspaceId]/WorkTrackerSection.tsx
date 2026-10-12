'use client';

import { useState, useEffect } from 'react';
import type { WorkspaceWorkTrackerConfig } from '@buildd/core/db/schema';
import { Select } from '@/components/ui/Select';
import { TonePill } from '@/components/ui/StatePill';
import { ReadOnlyFacts } from './ReadOnlyFacts';

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
  /** Holds manage_workspace_settings. False: the linked tracker as text, no controls. */
  canEdit: boolean;
}

function detectProvider(url: string): string {
  if (url.includes('linear.app')) return 'linear';
  if (url.includes('github.com')) return 'github';
  if (url.includes('jira.atlassian.com') || url.includes('atlassian.net')) return 'jira';
  if (url.includes('asana.com')) return 'asana';
  return 'unknown';
}

const PROVIDER_LABELS: Record<string, string> = {
  linear: 'Linear',
  github: 'GitHub',
  jira: 'Jira',
  asana: 'Asana',
  unknown: 'Unknown',
};

// Selection sentinel for "GitHub via the workspace's existing App" (no connector).
const GITHUB_APP = 'github-app';

export default function WorkTrackerSection({ workspaceId, initialWorkTrackerConfig, canEdit }: Props) {
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
        throw new Error(errorLabel(err.error) ?? 'Could not save. Try again.');
      }
      const data = await res.json();
      setConfig(data.workTrackerConfig ?? null);
      setMessage({ type: 'success', text: successText });
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Could not save. Try again.' });
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
      setMessage({ type: 'error', text: 'Connector not found. Reload and select it again.' });
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
    <div className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className="text-sm font-medium text-text-primary">Work tracker</h3>
        {config && activeLabel && <TonePill tone="ok">Active</TonePill>}
      </div>
      <p className="text-xs text-text-secondary mt-0.5 mb-3">
        Agents comment on the linked issue when a task&apos;s PR merges. Issues with the trigger
        label open a linked task.
      </p>

      {!canEdit && (
        <ReadOnlyFacts
          facts={[
            { label: 'Tracker', value: config && activeLabel ? activeLabel : 'None', testId: 'work-tracker-value' },
            ...(config ? [{ label: 'Provider', value: PROVIDER_LABELS[config.provider] ?? config.provider }] : []),
            ...(config?.provider === 'github'
              ? [{ label: 'Inbound trigger label', value: <code className="font-mono">{config.inboundLabel || 'buildd'}</code> }]
              : []),
          ]}
        />
      )}

      {canEdit && config && activeLabel && (
        <p className="mb-3 text-xs text-text-secondary" data-testid="work-tracker-active">
          <span className="text-text-primary">{activeLabel}</span>
          <span className="text-text-muted"> · {PROVIDER_LABELS[config.provider] ?? config.provider}</span>
          {config.provider === 'github' && (
            <span className="text-text-muted">
              {' '}· inbound label <code className="font-mono">{config.inboundLabel || 'buildd'}</code>
            </span>
          )}
        </p>
      )}

      {canEdit && (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-0">
              <label className="block text-sm text-text-primary mb-1" htmlFor="work-tracker-select">
                Tracker
              </label>
              <Select
                id="work-tracker-select"
                value={selection}
                onChange={setSelection}
                options={[
                  { value: '', label: 'None', description: 'Work tracker off' },
                  { value: GITHUB_APP, label: 'GitHub', description: "This repo's App" },
                  ...connectors.map(c => ({ value: c.id, label: c.name, description: detectProvider(c.url) })),
                ]}
              />
            </div>

            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="btn min-h-11"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>

          {selection === GITHUB_APP && (
            <div className="mt-3">
              <label className="block text-sm text-text-primary mb-1" htmlFor="work-tracker-label">
                Inbound trigger label
              </label>
              <input
                id="work-tracker-label"
                type="text"
                className="w-full border border-border-default px-3 py-2 bg-surface-1 font-mono text-base md:text-sm"
                placeholder="buildd"
                value={inboundLabel}
                onChange={e => setInboundLabel(e.target.value)}
              />
              <p className="mt-1 text-xs text-text-muted">
                Adding this label to a GitHub issue opens a linked task; closing the issue cancels it.
                Defaults to <code className="font-mono">buildd</code>.
              </p>
            </div>
          )}
        </>
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
    github_app_not_installed: 'Install the buildd GitHub App on this repo first.',
    unsupported_provider: 'This tracker is not supported.',
  };
  return map[code] ?? code;
}
