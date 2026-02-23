'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

interface Agent {
  localUiUrl: string;
  accountName: string;
}

interface MatchedRepo {
  path: string;
  remoteUrl: string | null;
  owner: string | null;
  repo: string | null;
  workspaceId: string;
  workspaceName: string;
}

interface UnmatchedRepo {
  path: string;
  remoteUrl: string | null;
  owner: string | null;
  repo: string | null;
  inOrg: boolean;
}

interface DiscoveredData {
  matched: MatchedRepo[];
  unmatchedInOrg: UnmatchedRepo[];
  unmatchedExternal: UnmatchedRepo[];
}

interface Props {
  agents: Agent[];
}

export default function DiscoveredRepos({ agents }: Props) {
  const [data, setData] = useState<DiscoveredData | null>(null);
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (agents.length === 0) {
      setLoading(false);
      return;
    }

    // Fetch discovered repos from the first connected agent
    const agent = agents[0];
    const fetchRepos = async () => {
      try {
        const res = await fetch(`${agent.localUiUrl}/api/discovered-repos`, {
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) throw new Error('Failed to fetch');
        const result = await res.json();
        setData(result);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchRepos();
  }, [agents]);

  if (dismissed) return null;
  if (loading || !data) return null;

  const { unmatchedInOrg, unmatchedExternal } = data;
  const hasUnmatched = unmatchedInOrg.length > 0 || unmatchedExternal.length > 0;

  if (!hasUnmatched) return null;

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between pb-2 border-b border-border-default mb-6">
        <span className="font-mono text-[10px] uppercase tracking-[2.5px] text-text-muted">
          Discovered Repos
        </span>
        <button
          onClick={() => setDismissed(true)}
          className="text-[11px] text-text-muted hover:text-text-primary"
        >
          Dismiss
        </button>
      </div>

      {unmatchedInOrg.length > 0 && (
        <div className="mb-4">
          <div className="text-[12px] font-medium text-text-secondary mb-2">In your org</div>
          <div className="border border-border-default rounded-[10px] overflow-hidden">
            {unmatchedInOrg.map((repo) => (
              <RepoRow key={repo.path} repo={repo} />
            ))}
          </div>
        </div>
      )}

      {unmatchedExternal.length > 0 && (
        <div>
          <div className="text-[12px] font-medium text-text-secondary mb-2">Other repos</div>
          <div className="border border-border-default rounded-[10px] overflow-hidden">
            {unmatchedExternal.slice(0, 5).map((repo) => (
              <RepoRow key={repo.path} repo={repo} />
            ))}
            {unmatchedExternal.length > 5 && (
              <div className="px-4 py-2 text-[11px] text-text-muted border-t border-border-default/40">
                +{unmatchedExternal.length - 5} more repos
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RepoRow({ repo }: { repo: UnmatchedRepo }) {
  const displayName = repo.owner && repo.repo
    ? `${repo.owner}/${repo.repo}`
    : repo.path.split('/').pop() || 'Unknown';

  const repoParam = repo.remoteUrl
    ? encodeURIComponent(repo.remoteUrl)
    : '';

  return (
    <div className="flex items-center gap-4 px-4 py-3 border-b border-border-default/40 last:border-b-0">
      <div className="w-7 h-7 rounded-[6px] flex items-center justify-center text-[13px] flex-shrink-0 bg-surface-3 text-text-muted">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
          <path d="M9 18c-4.51 2-5-2-7-2" />
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-text-primary truncate">{displayName}</div>
        <div className="font-mono text-[11px] text-text-muted truncate">{repo.path}</div>
      </div>
      <Link
        href={`/app/workspaces/new${repoParam ? `?repo=${repoParam}` : ''}`}
        className="px-3 py-[5px] text-xs bg-primary/10 text-primary rounded-[6px] hover:bg-primary/20 whitespace-nowrap"
      >
        Create Workspace
      </Link>
    </div>
  );
}
