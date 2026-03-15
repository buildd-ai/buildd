'use client';

import { useState, useEffect } from 'react';

interface Workspace {
  id: string;
  name: string;
  repo: string | null;
}

interface DiscordConfig {
  guildId?: string;
  channelId?: string;
  botToken?: string;
  enabled?: boolean;
}

export default function DiscordSection({ workspaces }: { workspaces: Workspace[] }) {
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>(workspaces[0]?.id || '');
  const [config, setConfig] = useState<DiscordConfig>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showToken, setShowToken] = useState(false);

  useEffect(() => {
    if (selectedWorkspaceId) {
      loadConfig(selectedWorkspaceId);
    }
  }, [selectedWorkspaceId]);

  async function loadConfig(workspaceId: string) {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}`);
      if (res.ok) {
        const data = await res.json();
        setConfig(data.workspace?.discordConfig || {});
      }
    } catch (err) {
      console.error('Failed to load Discord config:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!selectedWorkspaceId) return;
    setSaving(true);
    setMessage(null);

    try {
      const res = await fetch(`/api/workspaces/${selectedWorkspaceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ discordConfig: config }),
      });

      if (res.ok) {
        setMessage({ type: 'success', text: 'Discord configuration saved' });
      } else {
        const err = await res.json();
        setMessage({ type: 'error', text: err.error || 'Failed to save' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: 'Failed to save Discord configuration' });
    } finally {
      setSaving(false);
    }
  }

  if (workspaces.length === 0) {
    return (
      <section>
        <h2 className="section-label mb-4">Discord</h2>
        <div className="card p-6 text-center">
          <p className="text-text-muted text-sm">Create a workspace first to configure Discord integration</p>
        </div>
      </section>
    );
  }

  return (
    <section>
      <h2 className="section-label mb-4">Discord</h2>

      {message && (
        <div className={`mb-4 p-3 rounded-lg text-sm ${
          message.type === 'success'
            ? 'bg-status-success/10 text-status-success border border-status-success/30'
            : 'bg-status-error/10 text-status-error border border-status-error/30'
        }`}>
          {message.text}
        </div>
      )}

      {/* Workspace selector */}
      {workspaces.length > 1 && (
        <div className="mb-4">
          <label className="block text-sm text-text-secondary mb-1">Workspace</label>
          <select
            value={selectedWorkspaceId}
            onChange={(e) => setSelectedWorkspaceId(e.target.value)}
            className="w-full px-3 py-2 bg-surface-2 border border-border-default rounded-md text-sm text-text-primary"
          >
            {workspaces.map((ws) => (
              <option key={ws.id} value={ws.id}>
                {ws.name}{ws.repo ? ` (${ws.repo})` : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      {loading ? (
        <div className="text-text-secondary text-sm">Loading...</div>
      ) : (
        <div className="card p-4 space-y-4">
          {/* Enable toggle */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium">Enable Discord Integration</label>
              <p className="text-xs text-text-secondary mt-0.5">
                Allow the /buildd slash command and notifications in your Discord server
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={config.enabled || false}
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

          {/* Guild ID */}
          <div>
            <label className="block text-sm text-text-secondary mb-1">Guild ID (Server ID)</label>
            <input
              type="text"
              value={config.guildId || ''}
              onChange={(e) => setConfig({ ...config, guildId: e.target.value })}
              placeholder="e.g. 123456789012345678"
              className="w-full px-3 py-2 bg-surface-2 border border-border-default rounded-md text-sm text-text-primary placeholder:text-text-muted"
            />
            <p className="text-xs text-text-muted mt-1">
              Right-click your server name and select &quot;Copy Server ID&quot; (enable Developer Mode in Discord settings)
            </p>
          </div>

          {/* Channel ID */}
          <div>
            <label className="block text-sm text-text-secondary mb-1">Channel ID</label>
            <input
              type="text"
              value={config.channelId || ''}
              onChange={(e) => setConfig({ ...config, channelId: e.target.value })}
              placeholder="e.g. 123456789012345678"
              className="w-full px-3 py-2 bg-surface-2 border border-border-default rounded-md text-sm text-text-primary placeholder:text-text-muted"
            />
            <p className="text-xs text-text-muted mt-1">
              The channel where buildd will send notifications
            </p>
          </div>

          {/* Bot Token */}
          <div>
            <label className="block text-sm text-text-secondary mb-1">Bot Token</label>
            <div className="relative">
              <input
                type={showToken ? 'text' : 'password'}
                value={config.botToken || ''}
                onChange={(e) => setConfig({ ...config, botToken: e.target.value })}
                placeholder="Enter your Discord bot token"
                className="w-full px-3 py-2 pr-20 bg-surface-2 border border-border-default rounded-md text-sm text-text-primary placeholder:text-text-muted font-mono"
              />
              <button
                type="button"
                onClick={() => setShowToken(!showToken)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-text-secondary hover:text-text-primary px-2 py-1"
              >
                {showToken ? 'Hide' : 'Show'}
              </button>
            </div>
            <p className="text-xs text-text-muted mt-1">
              From the Discord Developer Portal &gt; your app &gt; Bot &gt; Token
            </p>
          </div>

          {/* Save button */}
          <div className="flex justify-end pt-2">
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-sm bg-primary text-white rounded-md hover:bg-primary-hover disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save Discord Settings'}
            </button>
          </div>
        </div>
      )}

      <p className="text-xs text-text-secondary mt-3">
        Set up a Discord bot at the{' '}
        <a
          href="https://discord.com/developers/applications"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline"
        >
          Discord Developer Portal
        </a>
        . Invite it to your server with the <code className="text-xs bg-surface-3 px-1 rounded">applications.commands</code> and <code className="text-xs bg-surface-3 px-1 rounded">bot</code> scopes.
      </p>
    </section>
  );
}
