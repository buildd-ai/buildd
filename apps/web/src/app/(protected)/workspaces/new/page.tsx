'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

interface Installation {
  id: string;
  accountLogin: string;
  accountAvatarUrl: string;
  accountType: string;
  repoCount: number;
}

interface Repo {
  id: string;
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  description: string | null;
  hasWorkspace: boolean;
}

export default function NewWorkspacePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // GitHub state
  const [githubConfigured, setGithubConfigured] = useState(false);
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [selectedInstallation, setSelectedInstallation] = useState<string>('');
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [useManual, setUseManual] = useState(false);

  // Access control
  const [accessMode, setAccessMode] = useState<'open' | 'restricted'>('open');

  // Load GitHub installations on mount
  useEffect(() => {
    async function loadInstallations() {
      try {
        const res = await fetch('/api/github/installations');
        if (res.ok) {
          const data = await res.json();
          setGithubConfigured(data.configured);
          setInstallations(data.installations || []);
          if (data.installations?.length > 0) {
            setSelectedInstallation(data.installations[0].id);
          }
        }
      } catch {
        // GitHub not configured, that's fine
      }
    }
    loadInstallations();
  }, []);

  // Load repos when installation changes
  useEffect(() => {
    if (!selectedInstallation) {
      setRepos([]);
      return;
    }

    async function loadRepos() {
      setLoadingRepos(true);
      try {
        const res = await fetch(`/api/github/installations/${selectedInstallation}/repos`);
        if (res.ok) {
          const data = await res.json();
          setRepos(data.repos || []);
        }
      } catch {
        setRepos([]);
      } finally {
        setLoadingRepos(false);
      }
    }
    loadRepos();
  }, [selectedInstallation]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError('');

    const formData = new FormData(e.currentTarget);

    const data: Record<string, unknown> = {
      name: formData.get('name') as string,
      accessMode,
    };

    if (selectedRepo && !useManual) {
      data.repoUrl = selectedRepo.fullName;
      data.githubRepoId = selectedRepo.id;
      data.githubInstallationId = selectedInstallation;
    } else {
      data.repoUrl = formData.get('repoUrl') as string;
    }

    try {
      const res = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to create workspace');
      }

      router.push('/workspaces');
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  const hasGitHub = githubConfigured && installations.length > 0;

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-xl mx-auto">
        <Link href="/workspaces" className="text-sm text-gray-500 hover:text-gray-700 mb-2 block">
          &larr; Workspaces
        </Link>
        <h1 className="text-3xl font-bold mb-8">New Workspace</h1>

        <form onSubmit={handleSubmit} className="space-y-6">
          {error && (
            <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-400">
              {error}
            </div>
          )}

          {/* GitHub Repo Selection */}
          {hasGitHub && !useManual && (
            <>
              <div>
                <label className="block text-sm font-medium mb-2">
                  GitHub Organization
                </label>
                <select
                  value={selectedInstallation}
                  onChange={(e) => {
                    setSelectedInstallation(e.target.value);
                    setSelectedRepo(null);
                  }}
                  className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900"
                >
                  {installations.map((inst) => (
                    <option key={inst.id} value={inst.id}>
                      {inst.accountLogin} ({inst.repoCount} repos)
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">
                  Repository
                </label>
                {loadingRepos ? (
                  <div className="text-sm text-gray-500">Loading repositories...</div>
                ) : repos.length === 0 ? (
                  <div className="text-sm text-gray-500">No repositories found</div>
                ) : (
                  <select
                    value={selectedRepo?.id || ''}
                    onChange={(e) => {
                      const repo = repos.find((r) => r.id === e.target.value);
                      setSelectedRepo(repo || null);
                    }}
                    className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900"
                  >
                    <option value="">Select a repository...</option>
                    {repos.map((repo) => (
                      <option
                        key={repo.id}
                        value={repo.id}
                        disabled={repo.hasWorkspace}
                      >
                        {repo.fullName} {repo.private ? '(private)' : ''} {repo.hasWorkspace ? '- already linked' : ''}
                      </option>
                    ))}
                  </select>
                )}
                {selectedRepo && selectedRepo.description && (
                  <p className="text-xs text-gray-500 mt-1">{selectedRepo.description}</p>
                )}
              </div>

              <button
                type="button"
                onClick={() => setUseManual(true)}
                className="text-sm text-blue-600 hover:underline"
              >
                Or enter repository URL manually
              </button>
            </>
          )}

          {/* Manual Entry */}
          {(!hasGitHub || useManual) && (
            <>
              {hasGitHub && useManual && (
                <button
                  type="button"
                  onClick={() => setUseManual(false)}
                  className="text-sm text-blue-600 hover:underline"
                >
                  &larr; Back to repository picker
                </button>
              )}

              <div>
                <label htmlFor="repoUrl" className="block text-sm font-medium mb-2">
                  GitHub Repository
                </label>
                <input
                  type="text"
                  id="repoUrl"
                  name="repoUrl"
                  placeholder="org/repo or https://github.com/org/repo"
                  className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <p className="text-xs text-gray-500 mt-1">Optional - agents will clone this repo</p>
              </div>

              {!githubConfigured && (
                <div className="p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                  <p className="text-sm text-blue-700 dark:text-blue-300">
                    <a href="/api/github/install" className="font-medium hover:underline">
                      Connect GitHub
                    </a>
                    {' '}to auto-discover repositories and enable issue sync.
                  </p>
                </div>
              )}
            </>
          )}

          <div>
            <label htmlFor="name" className="block text-sm font-medium mb-2">
              Workspace Name
            </label>
            <input
              type="text"
              id="name"
              name="name"
              required
              placeholder={selectedRepo ? selectedRepo.name : 'my-project'}
              defaultValue={selectedRepo?.name || ''}
              key={selectedRepo?.id || 'manual'}
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">
              Token Access
            </label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="accessMode"
                  value="open"
                  checked={accessMode === 'open'}
                  onChange={() => setAccessMode('open')}
                  className="w-4 h-4"
                />
                <span className="text-sm">Open</span>
                <span className="text-xs text-gray-500">Any token can claim tasks</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="accessMode"
                  value="restricted"
                  checked={accessMode === 'restricted'}
                  onChange={() => setAccessMode('restricted')}
                  className="w-4 h-4"
                />
                <span className="text-sm">Restricted</span>
                <span className="text-xs text-gray-500">Only linked tokens</span>
              </label>
            </div>
          </div>

          <div className="flex gap-4">
            <button
              type="submit"
              disabled={loading || (hasGitHub && !useManual && !selectedRepo)}
              className="flex-1 px-4 py-2 bg-black dark:bg-white text-white dark:text-black rounded-lg hover:opacity-80 disabled:opacity-50"
            >
              {loading ? 'Creating...' : 'Create Workspace'}
            </button>
            <Link
              href="/workspaces"
              className="px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </main>
  );
}
