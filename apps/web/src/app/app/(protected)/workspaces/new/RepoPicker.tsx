'use client';

import { useState, useMemo } from 'react';

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

interface RepoPickerProps {
  repos: Repo[];
  selectedRepo: Repo | null;
  onSelect: (repo: Repo | null) => void;
  loading?: boolean;
}

export default function RepoPicker({ repos, selectedRepo, onSelect, loading }: RepoPickerProps) {
  const [search, setSearch] = useState('');

  const filteredRepos = useMemo(() => {
    if (!search) return repos;
    const lower = search.toLowerCase();
    return repos.filter(
      (r) =>
        r.name.toLowerCase().includes(lower) ||
        r.fullName.toLowerCase().includes(lower) ||
        r.description?.toLowerCase().includes(lower)
    );
  }, [repos, search]);

  // Sort: available first, then by name
  const sortedRepos = useMemo(() => {
    return [...filteredRepos].sort((a, b) => {
      if (a.hasWorkspace !== b.hasWorkspace) {
        return a.hasWorkspace ? 1 : -1;
      }
      return a.name.localeCompare(b.name);
    });
  }, [filteredRepos]);

  if (loading) {
    return (
      <div className="border border-border-default rounded-lg p-8 text-center">
        <div className="animate-pulse text-text-muted">Loading repositories...</div>
      </div>
    );
  }

  if (repos.length === 0) {
    return (
      <div className="border border-dashed border-border-default rounded-lg p-8 text-center">
        <p className="text-text-muted">No repositories found</p>
        <p className="text-xs text-text-muted mt-1">Make sure the GitHub App has access to your repos</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Search */}
      <input
        type="text"
        placeholder="Search repositories..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full px-3 py-2 text-sm border border-border-default rounded-lg bg-surface-1 focus:ring-2 focus:ring-primary-ring focus:border-primary"
      />

      {/* Repo list */}
      <div className="max-h-64 overflow-y-auto space-y-2">
        {sortedRepos.map((repo) => (
          <button
            key={repo.id}
            type="button"
            disabled={repo.hasWorkspace}
            onClick={() => onSelect(selectedRepo?.id === repo.id ? null : repo)}
            className={`w-full text-left p-3 rounded-lg border transition-all ${
              selectedRepo?.id === repo.id
                ? 'border-primary bg-primary/10'
                : repo.hasWorkspace
                ? 'border-border-default bg-surface-3 opacity-50 cursor-not-allowed'
                : 'border-border-default hover:border-primary/50'
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium truncate">{repo.name}</span>
                  {repo.private && (
                    <span className="px-1.5 py-0.5 text-xs bg-surface-4 rounded">
                      private
                    </span>
                  )}
                </div>
                <div className="text-xs text-text-muted truncate">{repo.owner}</div>
                {repo.description && (
                  <p className="text-xs text-text-muted mt-1 line-clamp-2">{repo.description}</p>
                )}
              </div>
              {repo.hasWorkspace && (
                <span className="text-xs text-text-muted whitespace-nowrap">already linked</span>
              )}
              {selectedRepo?.id === repo.id && (
                <svg className="w-5 h-5 text-primary flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
              )}
            </div>
          </button>
        ))}
      </div>

      {filteredRepos.length === 0 && search && (
        <p className="text-sm text-text-muted text-center py-4">
          No repos matching "{search}"
        </p>
      )}
    </div>
  );
}
