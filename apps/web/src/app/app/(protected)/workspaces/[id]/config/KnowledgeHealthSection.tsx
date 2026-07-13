'use client';

import { useState, useEffect } from 'react';

interface CorpusStat {
  corpus: string;
  currentChunks: number;
}

interface LastIngestJob {
  repo: string;
  sha: string | null;
  status: 'queued' | 'running' | 'done' | 'error';
  scope: 'diff' | 'full';
  trigger: string;
  prNumber: number | null;
  finishedAt: string | null;
  createdAt: string | null;
  error: string | null;
}

interface KnowledgeHealth {
  workspaceId: string;
  corpora: CorpusStat[];
  totalCurrentChunks: number;
  lastIngestByRepo: LastIngestJob[];
  pendingEntityRefs: number;
  hasCodeIndex: boolean;
  lastSuccessfulIngestAt: string | null;
  staleAfterDays: number;
  freshness: 'fresh' | 'stale' | 'no-index';
}

interface Props {
  workspaceId: string;
}

const FRESHNESS_META: Record<
  KnowledgeHealth['freshness'],
  { label: string; dot: string; text: string; blurb: string }
> = {
  fresh: {
    label: 'Fresh',
    dot: 'bg-status-success',
    text: 'text-status-success',
    blurb: 'Code index reflects a recent successful ingest.',
  },
  stale: {
    label: 'Stale',
    dot: 'bg-status-warning',
    text: 'text-status-warning',
    blurb: 'No successful ingest recently — knowledge may lag behind the repo.',
  },
  'no-index': {
    label: 'No index',
    dot: 'bg-status-error',
    text: 'text-status-error',
    blurb: 'This workspace has no code index yet. It will backfill after the next merged PR.',
  },
};

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (isNaN(then)) return 'unknown';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : '—';
}

export default function KnowledgeHealthSection({ workspaceId }: Props) {
  const [health, setHealth] = useState<KnowledgeHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/workspaces/${workspaceId}/knowledge-health`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`Failed to load (${r.status})`);
        return r.json();
      })
      .then((data) => {
        if (!cancelled) setHealth(data.health);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const fresh = health ? FRESHNESS_META[health.freshness] : null;

  return (
    <div
      data-testid="knowledge-health-panel"
      className="mt-8 border border-border-subtle rounded-lg p-6"
    >
      <div className="flex items-start justify-between gap-4 mb-1">
        <h2 className="text-lg font-semibold">Knowledge Health</h2>
        {health && fresh && (
          <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${fresh.text}`}>
            <span className={`w-2 h-2 rounded-full inline-block ${fresh.dot}`} />
            {fresh.label}
          </span>
        )}
      </div>
      <p className="text-sm text-text-muted mb-4">
        Retrievable knowledge indexed for this workspace — chunks per corpus, latest ingest, and
        index freshness.
      </p>

      {loading && <p className="text-sm text-text-muted">Loading…</p>}

      {error && !loading && (
        <p className="text-sm text-status-error">Could not load knowledge health: {error}</p>
      )}

      {health && !loading && !error && (
        <div className="space-y-5">
          {fresh && <p className="text-sm text-text-secondary">{fresh.blurb}</p>}

          {/* Corpus / chunk table */}
          {health.corpora.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left font-mono text-[10px] uppercase tracking-[1.5px] text-text-muted border-b border-border-subtle">
                    <th className="py-2 font-normal">Corpus</th>
                    <th className="py-2 font-normal text-right">Current chunks</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {health.corpora.map((c) => (
                    <tr key={c.corpus}>
                      <td className="py-2 text-text-secondary">{c.corpus}</td>
                      <td className="py-2 text-right tabular-nums">{c.currentChunks.toLocaleString()}</td>
                    </tr>
                  ))}
                  <tr className="font-medium">
                    <td className="py-2">Total</td>
                    <td className="py-2 text-right tabular-nums">
                      {health.totalCurrentChunks.toLocaleString()}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-text-muted">No indexed chunks yet.</p>
          )}

          {/* Last ingest per repo */}
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[1.5px] text-text-muted mb-2">
              Last ingest
            </div>
            {health.lastIngestByRepo.length === 0 ? (
              <p className="text-sm text-text-muted">No ingest jobs recorded.</p>
            ) : (
              <ul className="space-y-1.5">
                {health.lastIngestByRepo.map((job) => (
                  <li
                    key={`${job.repo}-${job.sha ?? job.createdAt}`}
                    className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-secondary"
                  >
                    <span className="font-medium text-text-primary break-all">{job.repo}</span>
                    <span className="font-mono text-xs bg-surface-3 rounded px-1.5 py-0.5">
                      {shortSha(job.sha)}
                    </span>
                    <span
                      className={
                        job.status === 'done'
                          ? 'text-status-success'
                          : job.status === 'error'
                            ? 'text-status-error'
                            : 'text-text-muted'
                      }
                    >
                      {job.status}
                    </span>
                    <span className="text-text-muted">({job.scope})</span>
                    <span className="text-text-muted">
                      {timeAgo(job.finishedAt ?? job.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Pending entity refs */}
          <div className="flex items-center gap-2 text-sm text-text-secondary">
            <span className="tabular-nums font-medium text-text-primary">
              {health.pendingEntityRefs.toLocaleString()}
            </span>
            <span className="text-text-muted">
              pending entity {health.pendingEntityRefs === 1 ? 'ref' : 'refs'} awaiting resolution
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
