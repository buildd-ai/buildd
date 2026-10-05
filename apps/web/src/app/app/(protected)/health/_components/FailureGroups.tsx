'use client';

/**
 * What is failing, one row per cause (lib/health-failure-groups.ts).
 *
 * `FailureGroupsSection` is the Failures page body: the headline rate, then
 * every group with its drill-down. `TopFailureGroups` is the short version for
 * Overview: the top few groups and a link to Failures.
 */
import Link from 'next/link';
import { useState } from 'react';
import Chip from '@/components/ui/Chip';
import type { FailureGroup, FailureGroupsView } from '@/lib/health-failure-groups';
import { observedAgo } from '@/lib/health-metric-grammar';

type GroupsData = FailureGroupsView & { truncated: boolean };

export interface FailureHeadline {
  /** failed / finished, 0-100. */
  failureRatePct: number;
  failed: number;
  terminal: number;
}

const KIND_CHIP: Record<FailureGroup['kind'], { tone: 'warning' | 'error' | 'muted'; label: string }> = {
  platform: { tone: 'warning', label: 'Platform' },
  work: { tone: 'error', label: 'Task' },
  stopped: { tone: 'muted', label: 'Stopped' },
};

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function GroupMeta({ g, now }: { g: FailureGroup; now: number }) {
  const where = g.workspaces.length === 1 ? g.workspaces[0] : plural(g.workspaces.length, 'workspace');
  return (
    <p className="text-meta text-text-muted">
      {plural(g.count, 'failure')} · {where} · last {observedAgo(g.lastSeen, now) ?? 'unknown'}
    </p>
  );
}

function GroupRow({ g, now, expanded, onToggle }: { g: FailureGroup; now: number; expanded: boolean; onToggle: () => void }) {
  const chip = KIND_CHIP[g.kind];
  return (
    <li data-testid="failure-group" data-group-key={g.key}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-surface-2 transition-colors min-h-11"
      >
        <span className="text-title font-semibold tabular-nums text-text-primary w-8 shrink-0">{g.count}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 flex-wrap">
            <span className="text-body text-text-primary break-words">{g.label}</span>
            <Chip tone={chip.tone} dot={false}>{chip.label}</Chip>
          </span>
          <GroupMeta g={g} now={now} />
        </span>
        <span aria-hidden="true" className="text-text-muted text-meta shrink-0">{expanded ? '−' : '+'}</span>
      </button>
      {expanded && (
        <div className="px-4 pb-4 md:pl-15 space-y-3 text-body" data-testid="failure-group-detail">
          {g.hint && <p className="text-text-secondary">{g.hint}</p>}
          {g.tasks.length > 0 && (
            <div>
              <p className="section-label mb-1">Tasks</p>
              <ul className="space-y-1">
                {g.tasks.map(t => (
                  <li key={t.taskId} className="flex items-baseline justify-between gap-3">
                    <Link href={`/app/tasks/${t.taskId}`} className="truncate text-text-primary hover:underline">{t.title}</Link>
                    {t.failedWorkers > 1 && <span className="text-meta text-text-muted shrink-0 tabular-nums">{t.failedWorkers}×</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {g.sampleError && (
            <div>
              <p className="section-label mb-1">Latest error</p>
              <pre className="text-meta text-text-secondary whitespace-pre-wrap break-words font-mono max-h-40 overflow-auto">{g.sampleError}</pre>
            </div>
          )}
          {g.patterns.length > 0 && (
            <div>
              <p className="section-label mb-1">Seen in the agent&apos;s output</p>
              <ul className="space-y-0.5">
                {g.patterns.map(p => (
                  <li key={p.pattern} className="flex items-baseline justify-between gap-3 text-meta">
                    <span className="font-mono text-text-secondary truncate">{p.pattern}</span>
                    <span className="text-text-muted tabular-nums shrink-0">{plural(p.workers, 'failure')}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {g.variants.length > 1 && (
            <p className="text-meta text-text-muted">{plural(g.variants.length, 'variant')} of this error grouped together.</p>
          )}
        </div>
      )}
    </li>
  );
}

/** Failures page: headline rate, then every group. */
export function FailureGroupsSection({
  groups, headline, windowLabel, now,
}: {
  groups: GroupsData | null;
  headline: FailureHeadline | null;
  windowLabel: string;
  now: number;
}) {
  const [open, setOpen] = useState<string | null>(null);
  if (!groups) {
    return <p className="text-body text-text-muted" data-testid="failure-groups-unavailable">Failures couldn&apos;t be loaded right now.</p>;
  }
  return (
    <section data-testid="health-section-failure-groups" className="space-y-4">
      {headline && headline.terminal > 0 && (
        <div className="card px-4 py-3" data-testid="failure-groups-headline">
          <p className="section-label">Failure rate · {windowLabel}</p>
          <p className="text-heading font-bold tabular-nums text-text-primary">{headline.failureRatePct}%</p>
          <p className="text-meta text-text-muted">
            {headline.failed} of {headline.terminal} agent runs failed
            {groups.platformFailures > 0 && <> · {plural(groups.platformFailures, 'was', 'were')} platform problems, not the task</>}
            {groups.stopped > 0 && <> · {groups.stopped} stopped by a person (not counted)</>}
          </p>
        </div>
      )}

      {groups.groups.length === 0 ? (
        <div className="card px-4 py-3">
          <p className="text-body text-text-muted">Nothing failed in this window.</p>
        </div>
      ) : (
        <ul className="card divide-y divide-border-default" data-testid="failure-groups">
          {groups.groups.map(g => (
            <GroupRow key={g.key} g={g} now={now} expanded={open === g.key} onToggle={() => setOpen(open === g.key ? null : g.key)} />
          ))}
        </ul>
      )}
      {groups.truncated && (
        <p className="text-meta text-text-muted">Showing the most recent failures only; older ones in this window aren&apos;t counted.</p>
      )}
    </section>
  );
}

/** Overview: the top few groups and a link to Failures. */
export function TopFailureGroups({
  groups, limit = 4, now, href = '/app/health/failures',
}: {
  groups: GroupsData | null;
  /** How many groups to show (3-5 reads best). */
  limit?: number;
  now: number;
  href?: string;
}) {
  if (!groups || groups.groups.length === 0) return null;
  const top = groups.groups.slice(0, limit);
  const rest = groups.groups.length - top.length;
  return (
    <div data-testid="top-failure-groups">
      <ul className="card divide-y divide-border-default">
        {top.map(g => (
          <li key={g.key} className="px-4 py-3 flex items-start gap-3" data-testid="top-failure-group">
            <span className="text-title font-semibold tabular-nums text-text-primary w-8 shrink-0">{g.count}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-body text-text-primary break-words">{g.label}</span>
              <GroupMeta g={g} now={now} />
            </span>
          </li>
        ))}
      </ul>
      <Link href={href} className="inline-block mt-2 text-meta text-accent-text hover:underline">
        {rest > 0 ? `See all failures (${rest} more) →` : 'See all failures →'}
      </Link>
    </div>
  );
}
