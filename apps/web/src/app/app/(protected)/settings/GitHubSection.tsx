'use client';

import { useState, useEffect } from 'react';
import ConfirmDialog from '@/components/ConfirmDialog';
import SettingsSection from './SettingsSection';

interface Installation {
  id: string;
  installationId: number;
  accountLogin: string;
  accountAvatarUrl: string | null;
  accountType: string;
  repositorySelection: string | null;
  repoCount: number;
  suspendedAt: string | null;
}

/**
 * `disconnectableIds`: installations the person may disconnect (the server
 * page computes the DELETE route's rule). Any other row offers Sync only and
 * says who can change it. Omitted = every row.
 */
export default function GitHubSection({ disconnectableIds }: { disconnectableIds?: string[] } = {}) {
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [loading, setLoading] = useState(true);
  // False when this buildd server has no GitHub App: connecting cannot work.
  const [configured, setConfigured] = useState(true);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [disconnecting, setDisconnecting] = useState<{ id: string; login: string } | null>(null);
  const [disconnectLoading, setDisconnectLoading] = useState(false);

  useEffect(() => {
    loadInstallations();
  }, []);

  async function loadInstallations() {
    try {
      const res = await fetch('/api/github/installations');
      if (res.ok) {
        const data = await res.json();
        setConfigured(data.configured !== false);
        setInstallations(data.installations || []);
      }
    } catch (err) {
      console.error('Failed to load installations:', err);
    } finally {
      setLoading(false);
    }
  }

  async function syncRepos(installationId: string) {
    setSyncing(installationId);
    setMessage(null);
    try {
      const res = await fetch(`/api/github/installations/${installationId}/repos`, {
        method: 'POST',
      });
      if (res.ok) {
        const data = await res.json();
        const repoWord = data.synced === 1 ? 'repo' : 'repos';
        const wsWord = data.linked === 1 ? 'workspace' : 'workspaces';
        const summary = `Synced ${data.synced} ${repoWord} · linked ${data.linked} ${wsWord}`;
        const isWarning = data.linked === 0 && data.synced > 0;
        setMessage({
          type: isWarning ? 'info' : 'success',
          text: isWarning
            ? `${summary}. Check workspace repo URLs or the installation scope.`
            : summary,
        });
        loadInstallations();
      } else {
        const err = await res.json();
        setMessage({ type: 'error', text: err.error || 'Sync failed' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: 'Failed to sync repos' });
    } finally {
      setSyncing(null);
    }
  }

  async function handleDisconnect() {
    if (!disconnecting) return;

    setDisconnectLoading(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/github/installations/${disconnecting.id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setMessage({ type: 'success', text: `Disconnected ${disconnecting.login}` });
        setDisconnecting(null);
        loadInstallations();
      } else {
        const err = await res.json();
        setMessage({ type: 'error', text: err.error || 'Disconnect failed' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: 'Failed to disconnect' });
    } finally {
      setDisconnectLoading(false);
    }
  }

  return (
    <SettingsSection
      title="GitHub"
      bare
      action={configured ? <a href="/api/github/install" className="btn btn-quiet">+ Connect org</a> : undefined}
    >
      {message && (
        <div className={`notice mb-3 ${
          message.type === 'success' ? 'notice-ok' : message.type === 'info' ? 'notice-info' : 'notice-err'
        }`}>
          {message.text}
        </div>
      )}

      {loading ? (
        <div className="text-text-secondary text-sm">Loading…</div>
      ) : !configured ? (
        <div className="card p-6" data-testid="github-unavailable">
          <p className="text-sm text-text-primary mb-2">GitHub is not set up on this buildd server.</p>
          <p className="text-sm text-text-secondary">
            You can still work with a repository: paste its address when you create a workspace, or in the
            workspace&apos;s settings under Link a repository.
          </p>
          <p className="text-xs text-text-muted mt-3">
            Running this server yourself? Create a GitHub App and set its ID, client ID and private key in the
            server&apos;s environment, then restart it.
          </p>
        </div>
      ) : installations.length === 0 ? (
        <div className="card p-6 text-center">
          <p className="text-text-muted mb-3 text-sm">No GitHub organizations connected</p>
          <a
            href="/api/github/install"
            className="btn btn-primary"
          >
            Connect an org
          </a>
          <p className="text-xs text-text-secondary mt-4 pt-3 border-t border-border-default">
            To modify repo access, visit{' '}
            <a
              href="https://github.com/settings/installations"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              GitHub Settings
            </a>
          </p>
        </div>
      ) : (
        <div className="card divide-y divide-border-default">
          {installations.map((inst) => (
            <div key={inst.id} className="p-4">
              <div className="flex flex-wrap items-center gap-3">
                {inst.accountAvatarUrl && (
                  <img
                    src={inst.accountAvatarUrl}
                    alt={inst.accountLogin}
                    className="w-10 h-10"
                  />
                )}
                <div className="flex-1 min-w-[8rem]">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{inst.accountLogin}</span>
                    <span className="status-pill status-pill-plain">{inst.accountType}</span>
                    {inst.suspendedAt && (
                      <span className="status-pill status-pill-err">Suspended</span>
                    )}
                  </div>
                  <div className="text-sm text-text-secondary">
                    {inst.repoCount} repos &bull; {inst.repositorySelection === 'all' ? 'All repos' : 'Selected repos'}
                  </div>
                </div>
                <div className="flex gap-2 ml-auto">
                  <button
                    onClick={() => syncRepos(inst.id)}
                    disabled={syncing === inst.id}
                    className="btn"
                  >
                    {syncing === inst.id ? 'Syncing…' : 'Sync'}
                  </button>
                  {!disconnectableIds || disconnectableIds.includes(inst.id) ? (
                    <button
                      onClick={() => setDisconnecting({ id: inst.id, login: inst.accountLogin })}
                      className="btn btn-danger"
                    >
                      Disconnect
                    </button>
                  ) : (
                    <span data-testid={`github-read-only-${inst.id}`} className="self-center text-xs text-text-muted">Admins can disconnect this.</span>
                  )}
                </div>
              </div>
            </div>
          ))}
          <p className="p-4 text-xs text-text-secondary">
            To modify repo access, visit{' '}
            <a
              href="https://github.com/settings/installations"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              GitHub Settings
            </a>
          </p>
        </div>
      )}

      <ConfirmDialog
        open={!!disconnecting}
        title={`Disconnect ${disconnecting?.login}?`}
        message="Removes the synced repos from buildd. GitHub keeps them."
        confirmLabel="Disconnect"
        variant="warning"
        loading={disconnectLoading}
        onConfirm={handleDisconnect}
        onCancel={() => setDisconnecting(null)}
      />
    </SettingsSection>
  );
}
