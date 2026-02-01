'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import RepoPicker from './RepoPicker';

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

type NameMode = 'repo' | 'full' | 'custom';

function NameModal({
  repo,
  currentName,
  onSelect,
  onClose,
}: {
  repo: { name: string; fullName: string } | null;
  currentName: string;
  onSelect: (name: string, mode: NameMode) => void;
  onClose: () => void;
}) {
  const [customName, setCustomName] = useState(currentName);
  const [mode, setMode] = useState<NameMode>('repo');

  const repoName = repo?.name || '';
  const fullName = repo?.fullName || '';

  useEffect(() => {
    if (currentName === repoName) setMode('repo');
    else if (currentName === fullName) setMode('full');
    else setMode('custom');
  }, [currentName, repoName, fullName]);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-md p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">Workspace Name</h2>
        <p className="text-sm text-gray-500">Choose how to name this workspace</p>

        <div className="space-y-2">
          {repo && (
            <>
              <label
                className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                  mode === 'repo'
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                    : 'border-gray-200 dark:border-gray-700 hover:border-gray-300'
                }`}
                onClick={() => setMode('repo')}
              >
                <input
                  type="radio"
                  name="nameMode"
                  checked={mode === 'repo'}
                  onChange={() => setMode('repo')}
                  className="w-4 h-4"
                />
                <div>
                  <div className="font-medium">{repoName}</div>
                  <div className="text-xs text-gray-500">Repository name only</div>
                </div>
              </label>

              <label
                className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                  mode === 'full'
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                    : 'border-gray-200 dark:border-gray-700 hover:border-gray-300'
                }`}
                onClick={() => setMode('full')}
              >
                <input
                  type="radio"
                  name="nameMode"
                  checked={mode === 'full'}
                  onChange={() => setMode('full')}
                  className="w-4 h-4"
                />
                <div>
                  <div className="font-medium">{fullName}</div>
                  <div className="text-xs text-gray-500">Include organization</div>
                </div>
              </label>
            </>
          )}

          <label
            className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
              mode === 'custom'
                ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                : 'border-gray-200 dark:border-gray-700 hover:border-gray-300'
            }`}
            onClick={() => setMode('custom')}
          >
            <input
              type="radio"
              name="nameMode"
              checked={mode === 'custom'}
              onChange={() => setMode('custom')}
              className="w-4 h-4"
            />
            <div className="flex-1">
              <div className="font-medium">Custom</div>
              {mode === 'custom' && (
                <input
                  type="text"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder="Enter custom name"
                  autoFocus
                  className="mt-2 w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              )}
            </div>
          </label>
        </div>

        <div className="flex gap-3 pt-2">
          <button
            onClick={() => {
              const name = mode === 'repo' ? repoName : mode === 'full' ? fullName : customName;
              onSelect(name, mode);
            }}
            className="flex-1 px-4 py-2 bg-black dark:bg-white text-white dark:text-black rounded-lg hover:opacity-80"
          >
            Apply
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
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

  // Workspace name
  const [workspaceName, setWorkspaceName] = useState('');
  const [showNameModal, setShowNameModal] = useState(false);
  const [manualRepoUrl, setManualRepoUrl] = useState('');

  // Access control
  const [accessMode, setAccessMode] = useState<'open' | 'restricted'>('open');

  // Extract repo info from URL for manual entry
  function extractRepoInfo(url: string): { name: string; fullName: string } | null {
    if (!url) return null;
    const cleaned = url
      .replace(/\.git$/, '')
      .replace(/^https?:\/\/[^/]+\//, '')
      .replace(/^git@[^:]+:/, '');
    const parts = cleaned.split('/');
    if (parts.length >= 2) {
      return { name: parts[parts.length - 1], fullName: cleaned };
    } else if (parts.length === 1 && parts[0]) {
      return { name: parts[0], fullName: parts[0] };
    }
    return null;
  }

  // Auto-update name when repo changes
  useEffect(() => {
    if (selectedRepo) {
      setWorkspaceName(selectedRepo.name);
    }
  }, [selectedRepo]);

  // Auto-update name when manual URL changes
  useEffect(() => {
    if (useManual && manualRepoUrl) {
      const info = extractRepoInfo(manualRepoUrl);
      if (info && !workspaceName) {
        setWorkspaceName(info.name);
      }
    }
  }, [manualRepoUrl, useManual]);

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
    const manualRepoUrl = formData.get('repoUrl') as string;

    // Determine final name
    let finalName = workspaceName;
    if (!finalName && selectedRepo) {
      finalName = selectedRepo.name;
    } else if (!finalName && manualRepoUrl) {
      finalName = extractRepoInfo(manualRepoUrl)?.name || '';
    }

    const data: Record<string, unknown> = {
      name: finalName || undefined, // Let server auto-derive if empty
      accessMode,
    };

    if (selectedRepo && !useManual) {
      data.repoUrl = selectedRepo.fullName;
      data.githubRepoId = selectedRepo.id;
      data.githubInstallationId = selectedInstallation;
    } else {
      data.repoUrl = manualRepoUrl;
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
              {installations.length > 1 && (
                <div>
                  <label className="block text-sm font-medium mb-2">
                    GitHub Account
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {installations.map((inst) => (
                      <button
                        key={inst.id}
                        type="button"
                        onClick={() => {
                          setSelectedInstallation(inst.id);
                          setSelectedRepo(null);
                        }}
                        className={`px-3 py-2 rounded-lg border text-sm transition-all ${
                          selectedInstallation === inst.id
                            ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300'
                            : 'border-gray-300 dark:border-gray-700 hover:border-gray-400'
                        }`}
                      >
                        {inst.accountLogin}
                        <span className="text-xs text-gray-500 ml-1">({inst.repoCount})</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium mb-2">
                  Repository
                </label>
                <RepoPicker
                  repos={repos}
                  selectedRepo={selectedRepo}
                  onSelect={setSelectedRepo}
                  loading={loadingRepos}
                />
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
                  value={manualRepoUrl}
                  onChange={(e) => {
                    setManualRepoUrl(e.target.value);
                    // Auto-derive name from URL
                    const info = extractRepoInfo(e.target.value);
                    if (info) {
                      setWorkspaceName(info.name);
                    }
                  }}
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

          {/* Workspace Name - shown when repo is selected or manual URL entered */}
          {(selectedRepo || manualRepoUrl || workspaceName) && (
            <div>
              <label className="block text-sm font-medium mb-2">
                Workspace Name
              </label>
              <div className="flex items-center gap-2">
                <div className="flex-1 px-4 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg font-mono text-sm">
                  {workspaceName || selectedRepo?.name || extractRepoInfo(manualRepoUrl)?.name || 'unnamed'}
                </div>
                <button
                  type="button"
                  onClick={() => setShowNameModal(true)}
                  className="px-3 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                >
                  Edit
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-1">Auto-derived from repository</p>
            </div>
          )}

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

        {/* Name editing modal */}
        {showNameModal && (
          <NameModal
            repo={selectedRepo || extractRepoInfo(manualRepoUrl)}
            currentName={workspaceName || selectedRepo?.name || extractRepoInfo(manualRepoUrl)?.name || ''}
            onSelect={(name) => {
              setWorkspaceName(name);
              setShowNameModal(false);
            }}
            onClose={() => setShowNameModal(false)}
          />
        )}
      </div>
    </main>
  );
}
