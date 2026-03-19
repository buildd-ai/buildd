'use client';

import { useState, useEffect } from 'react';
import { Select } from '@/components/ui/Select';

interface Workspace {
  id: string;
  name: string;
}

interface SlackConfig {
  teamId: string;
  channelId: string;
  hasBotToken: boolean;
  enabled: boolean;
}

export default function SlackSection({ workspaces }: { workspaces: Workspace[] }) {
  const [selectedWorkspace, setSelectedWorkspace] = useState<string>(workspaces[0]?.id || '');
  const [config, setConfig] = useState<SlackConfig>({
    teamId: '',
    channelId: '',
    hasBotToken: false,
    enabled: false,
  });
  const [botToken, setBotToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (selectedWorkspace) {
      loadConfig(selectedWorkspace);
    }
  }, [selectedWorkspace]);

  async function loadConfig(workspaceId: string) {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/integrations/slack`);
      if (res.ok) {
        const data = await res.json();
        setConfig(data.slackConfig);
        setBotToken('');
      } else {
        setMessage({ type: 'error', text: 'Failed to load Slack config' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Failed to load Slack config' });
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!selectedWorkspace) return;
    setSaving(true);
    setMessage(null);

    try {
      const body: Record<string, unknown> = {
        teamId: config.teamId,
        channelId: config.channelId,
        enabled: config.enabled,
      };

      // Only send botToken if user typed a new one
      if (botToken) {
        body.botToken = botToken;
      }

      const res = await fetch(`/api/workspaces/${selectedWorkspace}/integrations/slack`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const data = await res.json();
        setConfig(data.slackConfig);
        setBotToken('');
        setMessage({ type: 'success', text: 'Slack configuration saved' });
      } else {
        const err = await res.json();
        setMessage({ type: 'error', text: err.error || 'Failed to save' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Failed to save Slack config' });
    } finally {
      setSaving(false);
    }
  }

  if (workspaces.length === 0) {
    return (
      <section>
        <h2 className="section-label mb-4">Slack</h2>
        <div className="card p-6 text-center">
          <p className="text-text-muted text-sm">Create a workspace first to configure Slack integration.</p>
        </div>
      </section>
    );
  }

  return (
    <section>
      <h2 className="section-label mb-4">Slack</h2>

      {message && (
        <div
          className={`mb-4 p-3 rounded-lg text-sm ${
            message.type === 'success'
              ? 'bg-status-success/10 text-status-success border border-status-success/30'
              : 'bg-status-error/10 text-status-error border border-status-error/30'
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="card p-4 space-y-4">
        {/* Workspace selector */}
        {workspaces.length > 1 && (
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Workspace</label>
            <Select
              value={selectedWorkspace}
              onChange={setSelectedWorkspace}
              options={workspaces.map((ws) => ({ value: ws.id, label: ws.name }))}
            />
          </div>
        )}

        {loading ? (
          <div className="text-text-secondary text-sm py-4 text-center">Loading...</div>
        ) : (
          <>
            {/* Enable toggle */}
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium">Enable Slack</label>
                <p className="text-xs text-text-secondary">
                  Allow the /buildd slash command and event notifications
                </p>
              </div>
              <button
                onClick={() => setConfig({ ...config, enabled: !config.enabled })}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  config.enabled ? 'bg-primary' : 'bg-surface-3'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    config.enabled ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            {/* Team ID */}
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">
                Slack Team ID
              </label>
              <input
                type="text"
                value={config.teamId}
                onChange={(e) => setConfig({ ...config, teamId: e.target.value })}
                placeholder="T01234ABCDE"
                className="w-full px-3 py-2 bg-surface-2 border border-border-default rounded-md text-sm font-mono"
              />
              <p className="text-xs text-text-muted mt-1">
                Find this in Slack &gt; Settings &gt; Workspace Settings
              </p>
            </div>

            {/* Channel ID */}
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">
                Channel ID
              </label>
              <input
                type="text"
                value={config.channelId}
                onChange={(e) => setConfig({ ...config, channelId: e.target.value })}
                placeholder="C01234ABCDE"
                className="w-full px-3 py-2 bg-surface-2 border border-border-default rounded-md text-sm font-mono"
              />
              <p className="text-xs text-text-muted mt-1">
                Right-click a channel &gt; View channel details &gt; copy the Channel ID
              </p>
            </div>

            {/* Bot Token */}
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">
                Bot Token
              </label>
              <input
                type="password"
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                placeholder={config.hasBotToken ? '********** (saved)' : 'xoxb-...'}
                className="w-full px-3 py-2 bg-surface-2 border border-border-default rounded-md text-sm font-mono"
              />
              <p className="text-xs text-text-muted mt-1">
                Your Slack app&apos;s Bot User OAuth Token (xoxb-...)
              </p>
            </div>

            {/* Save button */}
            <div className="flex justify-end pt-2">
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-2 text-sm bg-primary text-white rounded-md hover:bg-primary-hover disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </>
        )}
      </div>

      <p className="text-xs text-text-secondary mt-3">
        Set up a Slack app at{' '}
        <a
          href="https://api.slack.com/apps"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline"
        >
          api.slack.com/apps
        </a>
        {' '}with the <code className="text-xs bg-surface-3 px-1 rounded">chat:write</code> and{' '}
        <code className="text-xs bg-surface-3 px-1 rounded">commands</code> scopes.
      </p>
    </section>
  );
}
