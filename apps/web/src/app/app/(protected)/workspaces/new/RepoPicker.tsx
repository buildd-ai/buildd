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
      <div className="border border-gray-200 dark:border-gray-800 rounded-lg p-8 text-center">
        <div className="animate-pulse text-gray-500">Loading repositories...</div>
      </div>
    );
  }

  if (repos.length === 0) {
    return (
      <div className="border border-dashed border-gray-300 dark:border-gray-700 rounded-lg p-8 text-center">
        <p className="text-gray-500">No repositories found</p>
        <p className="text-xs text-gray-400 mt-1">Make sure the GitHub App has access to your repos</p>
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
        className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
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
                ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                : repo.hasWorkspace
                ? 'border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 opacity-50 cursor-not-allowed'
                : 'border-gray-200 dark:border-gray-800 hover:border-gray-400 dark:hover:border-gray-600'
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium truncate">{repo.name}</span>
                  {repo.private && (
                    <span className="px-1.5 py-0.5 text-xs bg-gray-200 dark:bg-gray-700 rounded">
                      private
                    </span>
                  )}
                </div>
                <div className="text-xs text-gray-500 truncate">{repo.owner}</div>
                {repo.description && (
                  <p className="text-xs text-gray-500 mt-1 line-clamp-2">{repo.description}</p>
                )}
              </div>
              {repo.hasWorkspace && (
                <span className="text-xs text-gray-400 whitespace-nowrap">already linked</span>
              )}
              {selectedRepo?.id === repo.id && (
                <svg className="w-5 h-5 text-blue-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
              )}
            </div>
          </button>
        ))}
      </div>

      {filteredRepos.length === 0 && search && (
        <p className="text-sm text-gray-500 text-center py-4">
          No repos matching "{search}"
        </p>
      )}
    </div>
  );
}
