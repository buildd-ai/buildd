'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

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

  async function disconnect(installationId: string, accountLogin: string) {
    if (!confirm(`Disconnect ${accountLogin}? This will remove all synced repos from buildd (not from GitHub).`)) {
      return;
    }

    setMessage(null);
    try {
      const res = await fetch(`/api/github/installations/${installationId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setMessage({ type: 'success', text: `Disconnected ${accountLogin}` });
        loadInstallations();
      } else {
        const err = await res.json();
        setMessage({ type: 'error', text: err.error || 'Disconnect failed' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: 'Failed to disconnect' });
    }
  }

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-2xl mx-auto">
        <Link href="/app/dashboard" className="text-sm text-gray-500 hover:text-gray-700 mb-2 block">
          &larr; Dashboard
        </Link>
        <h1 className="text-3xl font-bold mb-8">Settings</h1>

        {message && (
          <div className={`mb-6 p-4 rounded-lg ${
            message.type === 'success'
              ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 border border-green-200 dark:border-green-800'
              : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800'
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
              className="px-4 py-2 text-sm bg-black dark:bg-white text-white dark:text-black rounded-lg hover:opacity-80"
            >
              + Connect Org
            </a>
          </div>

          {loading ? (
            <div className="text-gray-500">Loading...</div>
          ) : installations.length === 0 ? (
            <div className="border border-dashed border-gray-300 dark:border-gray-700 rounded-lg p-8 text-center">
              <p className="text-gray-500 mb-4">No GitHub organizations connected</p>
              <a
                href="/api/github/install"
                className="text-blue-600 hover:underline"
              >
                Connect your first org
              </a>
            </div>
          ) : (
            <div className="border border-gray-200 dark:border-gray-800 rounded-lg divide-y divide-gray-200 dark:divide-gray-800">
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
                        <span className="text-xs text-gray-500 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded">
                          {inst.accountType}
                        </span>
                        {inst.suspendedAt && (
                          <span className="text-xs text-red-500 bg-red-100 dark:bg-red-900/30 px-2 py-0.5 rounded">
                            Suspended
                          </span>
                        )}
                      </div>
                      <div className="text-sm text-gray-500">
                        {inst.repoCount} repos &bull; {inst.repositorySelection === 'all' ? 'All repos' : 'Selected repos'}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => syncRepos(inst.id)}
                        disabled={syncing === inst.id}
                        className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
                      >
                        {syncing === inst.id ? 'Syncing...' : 'Sync'}
                      </button>
                      <button
                        onClick={() => disconnect(inst.id, inst.accountLogin)}
                        className="px-3 py-1.5 text-sm text-red-600 border border-red-300 dark:border-red-800 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20"
                      >
                        Disconnect
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          <p className="text-xs text-gray-500 mt-3">
            To modify repo access, visit{' '}
            <a
              href="https://github.com/settings/installations"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              GitHub Settings
            </a>
          </p>
        </section>

        {/* Account Section */}
        <section>
          <h2 className="text-xl font-semibold mb-4">Account</h2>
          <div className="border border-gray-200 dark:border-gray-800 rounded-lg p-4">
            <p className="text-gray-600 dark:text-gray-400 text-sm">
              Manage API keys and billing on the{' '}
              <Link href="/app/accounts" className="text-blue-600 hover:underline">
                Accounts page
              </Link>
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
