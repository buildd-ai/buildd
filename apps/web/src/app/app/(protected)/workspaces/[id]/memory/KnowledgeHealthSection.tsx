'use client';

import { useState, useEffect } from 'react';
import Section from '@/components/ui/Section';
import { TonePill } from '@/components/ui/StatePill';
import type { StateTone } from '@/components/ui/states';

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
  { label: string; tone: StateTone; blurb: string }
> = {
  fresh: {
    label: 'Fresh',
    tone: 'ok',
    blurb: 'The code index is up to date with a recent ingest.',
  },
  stale: {
    label: 'Stale',
    tone: 'dec',
    blurb: 'No recent ingest. Knowledge may lag behind the repo.',
  },
  'no-index': {
    label: 'No index',
    tone: 'bad',
    blurb: 'No code index. Built after the next merged PR.',
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
  return sha ? sha.slice(0, 7) : 'none';
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
    <Section
      title="Knowledge health"
      className="mt-8"
      action={health && fresh ? <TonePill tone={fresh.tone}>{fresh.label}</TonePill> : undefined}
    >
      <div data-testid="knowledge-health-panel">
      <p className="text-sm text-text-secondary mb-4">
        Indexed knowledge for this workspace: chunks per corpus, latest ingest, and index freshness.
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
                  <tr className="text-left text-xs text-text-muted border-b border-border-default">
                    <th className="py-2 font-normal">Corpus</th>
                    <th className="py-2 font-normal text-right">Current chunks</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-default">
                  {health.corpora.map((c) => (
                    <tr key={c.corpus}>
                      <td className="py-2 text-text-secondary">{c.corpus}</td>
                      <td className="py-2 text-right font-mono tabular-nums">{c.currentChunks.toLocaleString()}</td>
                    </tr>
                  ))}
                  <tr className="font-medium">
                    <td className="py-2">Total</td>
                    <td className="py-2 text-right font-mono tabular-nums">
                      {health.totalCurrentChunks.toLocaleString()}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-text-muted">No indexed chunks.</p>
          )}

          {/* Last ingest per repo */}
          <div>
            <h3 className="text-sm font-medium text-text-primary mb-2">Last ingest</h3>
            {health.lastIngestByRepo.length === 0 ? (
              <p className="text-sm text-text-muted">No ingest jobs recorded.</p>
            ) : (
              <ul className="divide-y divide-border-default">
                {health.lastIngestByRepo.map((job) => (
                  <li
                    key={`${job.repo}-${job.sha ?? job.createdAt}`}
                    className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2 text-sm text-text-secondary"
                  >
                    <span className="font-medium text-text-primary break-all">{job.repo}</span>
                    <span className="font-mono text-xs text-text-muted">
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
            <span className="font-mono tabular-nums font-medium text-text-primary">
              {health.pendingEntityRefs.toLocaleString()}
            </span>
            <span className="text-text-muted">
              unresolved entity {health.pendingEntityRefs === 1 ? 'ref' : 'refs'}
            </span>
          </div>
        </div>
      )}
      </div>
    </Section>
  );
}
