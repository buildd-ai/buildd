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

export default function GitHubSection() {
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [loading, setLoading] = useState(true);
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
            ? `${summary} — check workspace repo URLs or installation scope`
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
      action={<a href="/api/github/install" className="btn btn-quiet">+ Connect org</a>}
    >
      {message && (
        <div className={`notice mb-3 ${
          message.type === 'success' ? 'notice-ok' : message.type === 'info' ? 'notice-info' : 'notice-err'
        }`}>
          {message.text}
        </div>
      )}

      {loading ? (
        <div className="text-text-secondary text-sm">Loading...</div>
      ) : installations.length === 0 ? (
        <div className="card p-6 text-center">
          <p className="text-text-muted mb-3 text-sm">No GitHub organizations connected</p>
          <a
            href="/api/github/install"
            className="btn btn-primary"
          >
            Connect your first org
          </a>
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
                    {syncing === inst.id ? 'Syncing...' : 'Sync'}
                  </button>
                  <button
                    onClick={() => setDisconnecting({ id: inst.id, login: inst.accountLogin })}
                    className="btn btn-danger"
                  >
                    Disconnect
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-text-secondary mt-3">
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

      <ConfirmDialog
        open={!!disconnecting}
        title={`Disconnect ${disconnecting?.login}?`}
        message="This will remove all synced repos from buildd (not from GitHub)."
        confirmLabel="Disconnect"
        variant="warning"
        loading={disconnectLoading}
        onConfirm={handleDisconnect}
        onCancel={() => setDisconnecting(null)}
      />
    </SettingsSection>
  );
}
