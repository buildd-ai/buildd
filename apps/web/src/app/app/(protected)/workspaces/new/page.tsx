'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Select } from '@/components/ui/Select';
import RepoPicker from './RepoPicker';
import { defaultTeamId, readActiveTeamCookie } from '@/lib/active-team-client';
import { extractRepoInfo, plainCreateError, resolveWorkspaceName } from './new-workspace-form';

interface Installation {
  id: string;
  accountLogin: string;
  accountAvatarUrl: string;
  accountType: string;
}

interface Repo {
  id: string;
  repoId: number;
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  description: string | null;
  hasWorkspace: boolean;
}

export default function NewWorkspacePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Mode: connect an existing repo vs. create a brand-new repo
  const [mode, setMode] = useState<'connect' | 'create'>('connect');

  // GitHub state
  const [githubConfigured, setGithubConfigured] = useState(false);
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [selectedInstallation, setSelectedInstallation] = useState<string>('');
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedRepos, setSelectedRepos] = useState<Repo[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [useManual, setUseManual] = useState(false);

  // New-repo creation state (mode === 'create')
  const [newRepoName, setNewRepoName] = useState('');
  const [newRepoPrivate, setNewRepoPrivate] = useState(true);
  const [newRepoDescription, setNewRepoDescription] = useState('');
  // Track a workspace already created this submit so a retry doesn't duplicate it
  const createdWorkspaceIdRef = useRef<string | null>(null);

  // Workspace name (used for single-select and manual entry)
  const [workspaceName, setWorkspaceName] = useState('');
  // Once the person types a name, picking or pasting a repo stops overwriting it.
  const [nameTouched, setNameTouched] = useState(false);
  const [manualRepoUrl, setManualRepoUrl] = useState('');

  // Batch creation state
  const [batchErrors, setBatchErrors] = useState<string[]>([]);

  // Access control
  const [accessMode, setAccessMode] = useState<'open' | 'restricted'>('open');

  // Team selection
  const [userTeams, setUserTeams] = useState<{ id: string; name: string; slug: string }[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string>('');

  // Toggle repo selection
  function handleToggleRepo(repo: Repo) {
    setSelectedRepos((prev) => {
      const exists = prev.find((r) => r.id === repo.id);
      if (exists) {
        return prev.filter((r) => r.id !== repo.id);
      }
      return [...prev, repo];
    });
  }

  // Follow the picked repo's name until the person types their own.
  useEffect(() => {
    if (nameTouched) return;
    setWorkspaceName(selectedRepos.length === 1 ? selectedRepos[0].name : '');
  }, [selectedRepos, nameTouched]);

  // Load teams on mount
  useEffect(() => {
    async function loadTeams() {
      try {
        const res = await fetch('/api/teams');
        if (res.ok) {
          const data = await res.json();
          const teams: { id: string; slug: string }[] = data.teams || [];
          setUserTeams(data.teams || []);
          // Prefer the team the user is currently viewing (set by the team switcher)
          const initial = defaultTeamId(teams, readActiveTeamCookie());
          if (initial) setSelectedTeamId(initial);
        }
      } catch {
        // Teams not available
      }
    }
    loadTeams();
  }, []);

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
    setBatchErrors([]);

    // Create-new-repo mode: create a workspace shell, then create + link a fresh repo
    if (mode === 'create') {
      const repoName = newRepoName.trim();
      if (!repoName) {
        setError('Repository name is required');
        setLoading(false);
        return;
      }
      if (!selectedInstallation) {
        setError('Select the GitHub account that will own the repository');
        setLoading(false);
        return;
      }

      try {
        // 1. Reuse the workspace from a prior failed attempt, else create one (no repo yet)
        let workspaceId = createdWorkspaceIdRef.current;
        if (!workspaceId) {
          const wsData: Record<string, unknown> = {
            name: repoName,
            accessMode,
            githubInstallationId: selectedInstallation,
          };
          if (selectedTeamId) wsData.teamId = selectedTeamId;

          const wsRes = await fetch('/api/workspaces', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(wsData),
          });
          if (!wsRes.ok) {
            const err = await wsRes.json().catch(() => ({}));
            throw new Error(plainCreateError(wsRes.status, err.error));
          }
          const ws = await wsRes.json();
          workspaceId = ws.id as string;
          createdWorkspaceIdRef.current = workspaceId;
        }

        // 2. Create the GitHub repo via the installation and link it to the workspace
        const repoRes = await fetch(`/api/workspaces/${workspaceId}/create-repo`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: repoName,
            private: newRepoPrivate,
            description: newRepoDescription.trim() || undefined,
          }),
        });
        if (!repoRes.ok) {
          const err = await repoRes.json().catch(() => ({}));
          throw new Error(err.hint ? `${err.error}. ${err.hint}` : err.error || 'Failed to create repository');
        }

        router.push('/app/workspaces');
        router.refresh();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
      } finally {
        setLoading(false);
      }
      return;
    }

    const formData = new FormData(e.currentTarget);
    const manualUrl = formData.get('repoUrl') as string;

    // Batch creation for multiple repos
    if (selectedRepos.length > 1 && !useManual) {
      const errors: string[] = [];

      for (const repo of selectedRepos) {
        const data: Record<string, unknown> = {
          name: repo.name,
          accessMode,
          repoUrl: repo.fullName,
          githubRepo: repo,
          githubInstallationId: selectedInstallation,
        };
        if (selectedTeamId) data.teamId = selectedTeamId;

        try {
          const res = await fetch('/api/workspaces', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
          });
          if (!res.ok) {
            const err = await res.json();
            errors.push(`${repo.name}: ${err.error || 'Failed'}`);
          }
        } catch {
          errors.push(`${repo.name}: Network error`);
        }
      }

      if (errors.length > 0) {
        setBatchErrors(errors);
        setError(`${errors.length} of ${selectedRepos.length} workspaces failed to create`);
        if (errors.length < selectedRepos.length) {
          // Some succeeded - navigate after a delay so user sees errors
          setTimeout(() => {
            router.push('/app/workspaces');
            router.refresh();
          }, 2000);
        }
      } else {
        router.push('/app/workspaces');
        router.refresh();
      }
      setLoading(false);
      return;
    }

    // Single workspace creation. A repository is optional; a name is not.
    const selectedRepo = useManual ? null : selectedRepos[0] || null;
    const repoUrl = selectedRepo ? selectedRepo.fullName : (manualUrl ?? '').trim();
    const resolved = resolveWorkspaceName({
      typedName: workspaceName,
      repoName: selectedRepo?.name ?? extractRepoInfo(repoUrl)?.name ?? null,
    });
    if (!resolved.ok) {
      setError(resolved.error);
      setLoading(false);
      return;
    }
    const finalName = resolved.name;

    const data: Record<string, unknown> = {
      name: finalName,
      accessMode,
    };

    if (selectedTeamId) {
      data.teamId = selectedTeamId;
    }

    if (selectedRepo) {
      data.repoUrl = selectedRepo.fullName;
      data.githubRepo = selectedRepo;
      data.githubInstallationId = selectedInstallation;
    } else if (repoUrl) {
      data.repoUrl = repoUrl;
    }

    try {
      const res = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(plainCreateError(res.status, err.error));
      }

      router.push('/app/workspaces');
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
    } finally {
      setLoading(false);
    }
  }

  const hasGitHub = githubConfigured && installations.length > 0;

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-xl mx-auto">
        <Link href="/app/workspaces" className="text-sm text-text-muted hover:text-text-secondary mb-2 block">
          &larr; Workspaces
        </Link>
        <h1 className="text-3xl font-bold mb-8">New Workspace</h1>

        <form onSubmit={handleSubmit} className="space-y-6">
          {error && (
            <div className="p-4 bg-status-error/10 border border-status-error/30 rounded-lg text-status-error">
              <p>{error}</p>
              {batchErrors.length > 0 && (
                <ul className="mt-2 text-sm space-y-1">
                  {batchErrors.map((err, i) => (
                    <li key={i}>{err}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Mode toggle: connect existing repo vs. create a new one */}
          <div className="grid grid-cols-2 gap-2" role="tablist" aria-label="Workspace source">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'connect'}
              onClick={() => { setMode('connect'); setError(''); }}
              className={`px-4 py-3 rounded-lg border text-sm text-left transition-all ${
                mode === 'connect'
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border-default hover:border-primary/50'
              }`}
            >
              <div className="font-medium">Connect existing</div>
              <div className="text-xs text-text-muted mt-0.5">Use a repo you already have</div>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'create'}
              onClick={() => { setMode('create'); setError(''); createdWorkspaceIdRef.current = null; }}
              className={`px-4 py-3 rounded-lg border text-sm text-left transition-all ${
                mode === 'create'
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border-default hover:border-primary/50'
              }`}
            >
              <div className="font-medium">Create new repo</div>
              <div className="text-xs text-text-muted mt-0.5">Create a GitHub repo</div>
            </button>
          </div>

          {/* Team Selection */}
          {userTeams.length > 1 && (
            <div>
              <label className="block text-sm font-medium mb-2">
                Team
              </label>
              <Select
                value={selectedTeamId}
                onChange={setSelectedTeamId}
                options={userTeams.map((team) => ({
                  value: team.id,
                  label: team.name + (team.slug.startsWith('personal-') ? ' (Personal)' : ''),
                }))}
              />
              <p className="text-xs text-text-muted mt-1">
                The team that owns this workspace
              </p>
            </div>
          )}

          {/* Workspace name: always here. A repo fills it in until you type your own. */}
          {mode === 'connect' && selectedRepos.length <= 1 && (
            <div>
              <label htmlFor="workspaceName" className="block text-sm font-medium mb-2">
                Workspace name
              </label>
              <input
                type="text"
                id="workspaceName"
                data-testid="new-workspace-name"
                value={workspaceName}
                onChange={(e) => {
                  setWorkspaceName(e.target.value);
                  setNameTouched(e.target.value.trim() !== '');
                }}
                placeholder="My product"
                className="w-full px-4 py-2 border border-border-default bg-surface-1 focus:ring-2 focus:ring-primary-ring focus:border-primary text-base md:text-sm"
              />
              <p className="text-xs text-text-muted mt-1">
                {nameTouched ? 'You can rename it later.' : 'Filled in from the repository if you pick one.'}
              </p>
            </div>
          )}

          {/* GitHub Repo Selection */}
          {mode === 'connect' && hasGitHub && !useManual && (
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
                          setSelectedRepos([]);
                        }}
                        className={`px-3 py-2 rounded-lg border text-sm transition-all ${
                          selectedInstallation === inst.id
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border-default hover:border-primary/50'
                        }`}
                      >
                        {inst.accountLogin}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium mb-2">
                  Repositories
                </label>
                <RepoPicker
                  repos={repos}
                  selectedRepos={selectedRepos}
                  onToggle={handleToggleRepo}
                  loading={loadingRepos}
                />
              </div>

              <button
                type="button"
                onClick={() => setUseManual(true)}
                className="text-sm text-primary hover:underline"
              >
                Or enter a repository URL
              </button>
            </>
          )}

          {/* Manual Entry */}
          {mode === 'connect' && (!hasGitHub || useManual) && (
            <>
              {hasGitHub && useManual && (
                <button
                  type="button"
                  onClick={() => setUseManual(false)}
                  className="text-sm text-primary hover:underline"
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
                    if (!nameTouched) setWorkspaceName(extractRepoInfo(e.target.value)?.name ?? '');
                  }}
                  placeholder="org/repo or https://github.com/org/repo"
                  className="w-full px-4 py-2 border border-border-default rounded-lg bg-surface-1 focus:ring-2 focus:ring-primary-ring focus:border-primary text-base md:text-sm"
                />
                <p className="text-xs text-text-muted mt-1">Optional. Agents clone this repo and open pull requests on it. Leave it empty to start without one.</p>
              </div>

              {githubConfigured && installations.length === 0 && (
                <div className="p-3 bg-primary/10 border border-primary/30 rounded-lg">
                  <p className="text-sm text-primary">
                    <a href="/api/github/install" className="font-medium hover:underline">
                      Connect GitHub
                    </a>
                    {' '}to list your repositories and sync issues.
                  </p>
                </div>
              )}
            </>
          )}

          {/* Batch summary for multi-select */}
          {mode === 'connect' && selectedRepos.length > 1 && !useManual && (
            <div className="p-3 bg-primary/5 border border-primary/20 rounded-lg">
              <p className="text-sm font-medium">{selectedRepos.length} repositories selected</p>
              <p className="text-xs text-text-muted mt-1">Each workspace takes its repository&apos;s name</p>
            </div>
          )}

          {/* Create New Repo */}
          {mode === 'create' && (
            <>
              {!githubConfigured ? (
                <div className="p-3 border border-border-default" data-testid="new-workspace-github-unavailable">
                  <p className="text-sm text-text-secondary">
                    GitHub is not set up on this buildd server, so it cannot create repositories. Choose
                    {' '}<strong>Connect existing</strong> and paste a repository, or leave it empty to start without one.
                  </p>
                </div>
              ) : (
                <>
                  {installations.length > 1 && (
                    <div>
                      <label className="block text-sm font-medium mb-2">GitHub Account</label>
                      <div className="flex flex-wrap gap-2">
                        {installations.map((inst) => (
                          <button
                            key={inst.id}
                            type="button"
                            onClick={() => setSelectedInstallation(inst.id)}
                            className={`px-3 py-2 rounded-lg border text-sm transition-all ${
                              selectedInstallation === inst.id
                                ? 'border-primary bg-primary/10 text-primary'
                                : 'border-border-default hover:border-primary/50'
                            }`}
                          >
                            {inst.accountLogin}
                          </button>
                        ))}
                      </div>
                      <p className="text-xs text-text-muted mt-1">The org or user that owns the new repo</p>
                    </div>
                  )}

                  <div>
                    <label htmlFor="newRepoName" className="block text-sm font-medium mb-2">
                      Repository Name
                    </label>
                    <input
                      type="text"
                      id="newRepoName"
                      value={newRepoName}
                      onChange={(e) => setNewRepoName(e.target.value)}
                      placeholder="my-new-project"
                      className="w-full px-4 py-2 border border-border-default rounded-lg bg-surface-1 font-mono focus:ring-2 focus:ring-primary-ring focus:border-primary text-base md:text-sm"
                    />
                    <p className="text-xs text-text-muted mt-1">
                      {selectedInstallation
                        ? `Creates ${installations.find((i) => i.id === selectedInstallation)?.accountLogin}/${newRepoName || 'name'}`
                        : 'The workspace takes the repo\'s name'}
                    </p>
                  </div>

                  <div>
                    <label htmlFor="newRepoDescription" className="block text-sm font-medium mb-2">
                      Description <span className="text-text-muted font-normal">(optional)</span>
                    </label>
                    <input
                      type="text"
                      id="newRepoDescription"
                      value={newRepoDescription}
                      onChange={(e) => setNewRepoDescription(e.target.value)}
                      placeholder="What is this repo for?"
                      className="w-full px-4 py-2 border border-border-default rounded-lg bg-surface-1 focus:ring-2 focus:ring-primary-ring focus:border-primary text-base md:text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-2">Visibility</label>
                    <div className="space-y-2">
                      <label
                        className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                          newRepoPrivate ? 'border-primary bg-primary/5' : 'border-border-default hover:border-primary/50'
                        }`}
                      >
                        <input
                          type="radio"
                          name="visibility"
                          checked={newRepoPrivate}
                          onChange={() => setNewRepoPrivate(true)}
                          className="w-4 h-4 mt-0.5"
                        />
                        <div>
                          <span className="text-sm font-medium">Private</span>
                          <p className="text-xs text-text-muted mt-0.5">Only people with access can see this repo</p>
                        </div>
                      </label>
                      <label
                        className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                          !newRepoPrivate ? 'border-primary bg-primary/5' : 'border-border-default hover:border-primary/50'
                        }`}
                      >
                        <input
                          type="radio"
                          name="visibility"
                          checked={!newRepoPrivate}
                          onChange={() => setNewRepoPrivate(false)}
                          className="w-4 h-4 mt-0.5"
                        />
                        <div>
                          <span className="text-sm font-medium">Public</span>
                          <p className="text-xs text-text-muted mt-0.5">Anyone on the internet can see this repo</p>
                        </div>
                      </label>
                    </div>
                  </div>
                </>
              )}
            </>
          )}

          <div>
            <label className="block text-sm font-medium mb-2">
              Token Access
            </label>
            <div className="space-y-2">
              <label
                className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                  accessMode === 'open'
                    ? 'border-primary bg-primary/5'
                    : 'border-border-default hover:border-primary/50'
                }`}
              >
                <input
                  type="radio"
                  name="accessMode"
                  value="open"
                  checked={accessMode === 'open'}
                  onChange={() => setAccessMode('open')}
                  className="w-4 h-4 mt-0.5"
                />
                <div>
                  <span className="text-sm font-medium">Open</span>
                  <p className="text-xs text-text-muted mt-0.5">Any account in this team can claim tasks</p>
                </div>
              </label>
              <label
                className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                  accessMode === 'restricted'
                    ? 'border-primary bg-primary/5'
                    : 'border-border-default hover:border-primary/50'
                }`}
              >
                <input
                  type="radio"
                  name="accessMode"
                  value="restricted"
                  checked={accessMode === 'restricted'}
                  onChange={() => setAccessMode('restricted')}
                  className="w-4 h-4 mt-0.5"
                />
                <div>
                  <span className="text-sm font-medium">Restricted</span>
                  <p className="text-xs text-text-muted mt-0.5">Only accounts you link can claim tasks</p>
                </div>
              </label>
            </div>
          </div>

          <div className="flex gap-4">
            <button
              type="submit"
              disabled={
                loading ||
                (mode === 'create' && (!githubConfigured || !newRepoName.trim() || !selectedInstallation))
              }
              className="flex-1 px-4 py-2 bg-primary text-white hover:bg-primary-hover rounded-lg disabled:opacity-50"
            >
              {loading
                ? 'Creating…'
                : mode === 'create'
                ? 'Create Repo & Workspace'
                : selectedRepos.length > 1
                ? `Create ${selectedRepos.length} Workspaces`
                : 'Create Workspace'}
            </button>
            <Link
              href="/app/workspaces"
              className="px-4 py-2 border border-border-default rounded-lg hover:bg-surface-3"
            >
              Cancel
            </Link>
          </div>
        </form>

      </div>
    </main>
  );
}
