'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import ConfirmDialog from '@/components/ConfirmDialog';

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

export default function SettingsPage() {
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
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
        setMessage({ type: 'success', text: `Synced ${data.synced} repositories` });
        loadInstallations(); // Refresh counts
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
    <main className="min-h-screen p-8">
      <div className="max-w-2xl mx-auto">
        <Link href="/app/dashboard" className="text-sm text-text-secondary hover:text-text-primary mb-2 block">
          &larr; Dashboard
        </Link>
        <h1 className="text-3xl font-bold mb-8">Settings</h1>

        {message && (
          <div className={`mb-6 p-4 rounded-lg ${
            message.type === 'success'
              ? 'bg-status-success/10 text-status-success border border-status-success/30'
              : 'bg-status-error/10 text-status-error border border-status-error/30'
          }`}>
            {message.text}
          </div>
        )}

        {/* GitHub Section */}
        <section className="mb-8">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-semibold">GitHub</h2>
            <a
              href="/api/github/install"
              className="px-4 py-2 text-sm bg-primary text-white rounded-md hover:bg-primary-hover"
            >
              + Connect Org
            </a>
          </div>

          {loading ? (
            <div className="text-text-secondary">Loading...</div>
          ) : installations.length === 0 ? (
            <div className="border border-dashed border-border-default rounded-lg p-8 text-center">
              <p className="text-text-secondary mb-4">No GitHub organizations connected</p>
              <a
                href="/api/github/install"
                className="text-primary hover:underline"
              >
                Connect your first org
              </a>
            </div>
          ) : (
            <div className="border border-border-default rounded-lg divide-y divide-border-default">
              {installations.map((inst) => (
                <div key={inst.id} className="p-4">
                  <div className="flex items-center gap-4">
                    {inst.accountAvatarUrl && (
                      <img
                        src={inst.accountAvatarUrl}
                        alt={inst.accountLogin}
                        className="w-10 h-10 rounded-full"
                      />
                    )}
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{inst.accountLogin}</span>
                        <span className="text-xs text-text-secondary bg-surface-3 px-2 py-0.5 rounded">
                          {inst.accountType}
                        </span>
                        {inst.suspendedAt && (
                          <span className="text-xs text-status-error bg-status-error/10 px-2 py-0.5 rounded">
                            Suspended
                          </span>
                        )}
                      </div>
                      <div className="text-sm text-text-secondary">
                        {inst.repoCount} repos &bull; {inst.repositorySelection === 'all' ? 'All repos' : 'Selected repos'}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => syncRepos(inst.id)}
                        disabled={syncing === inst.id}
                        className="px-3 py-1.5 text-sm border border-border-default rounded-md hover:bg-surface-3 disabled:opacity-50"
                      >
                        {syncing === inst.id ? 'Syncing...' : 'Sync'}
                      </button>
                      <button
                        onClick={() => setDisconnecting({ id: inst.id, login: inst.accountLogin })}
                        className="px-3 py-1.5 text-sm text-status-error border border-status-error/30 rounded-md hover:bg-status-error/10"
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
        </section>

        {/* Account Section */}
        <section>
          <h2 className="text-xl font-semibold mb-4">Account</h2>
          <div className="border border-border-default rounded-lg p-4">
            <p className="text-text-secondary text-sm">
              Manage API keys and billing on the{' '}
              <Link href="/app/accounts" className="text-primary hover:underline">
                Accounts page
              </Link>
            </p>
          </div>
        </section>
      </div>

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
    </main>
  );
}
