'use client';

import Link from 'next/link';
import type { BlockRef } from '@/lib/task-presentation';

interface DependencyRailProps {
  /**
   * The blockers to name — pass `chain.blockedByFrontier`, not `chain.blockedBy`.
   * The frontier is already transitively reduced, so these are the deps the task
   * is *directly* waiting on.
   */
  blockedBy: BlockRef[];
  /**
   * Total blocker count (`chain.blockedBy.length`). When it exceeds the number
   * of named chips, the difference is summarised as a "+N upstream" tail.
   */
  totalBlocked?: number;
  /** How many blockers to name before collapsing the rest into the tail. */
  max?: number;
}

/** Titles longer than this are truncated; keeps the rail on one line in row density. */
const MAX_TITLE_CHARS = 46;

const truncate = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;

/**
 * Blocker reference rail.
 *
 * Renders one `← {title}` chip per direct blocker, plus `#{pr}` when the blocker
 * is the half state (completed, PR still open) — the case that looks finished but
 * silently gates everything downstream. Chips link to the blocking task.
 *
 * Prose (`← blocked on {title} because …`) is still banned; chip form is the only
 * output. Naming the blocker inside the chip is not prose — it replaces the bare
 * `← afa5b0` hash, which told a reader nothing they could act on.
 */
export function DependencyRail({ blockedBy, totalBlocked, max = 2 }: DependencyRailProps) {
  if (blockedBy.length === 0) return null;

  const named = blockedBy.slice(0, max);
  // Blockers hidden by the cap, plus blockers the frontier reduction folded away.
  const hidden = Math.max(totalBlocked ?? blockedBy.length, blockedBy.length) - named.length;

  return (
    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono text-[10px] text-status-warning min-w-0 mt-0.5">
      {named.map((blocker) => (
        <Link
          key={blocker.id}
          href={`/app/tasks/${blocker.id}`}
          onClick={(e) => e.stopPropagation()}
          className="relative z-10 pointer-events-auto inline-flex items-baseline gap-1 min-w-0 hover:underline"
        >
          <span className="shrink-0">←</span>
          <span className="truncate">{truncate(blocker.title, MAX_TITLE_CHARS)}</span>
          {blocker.prNumber != null && (
            <span className="shrink-0 text-text-muted">#{blocker.prNumber}</span>
          )}
        </Link>
      ))}
      {hidden > 0 && (
        <span className="shrink-0 text-text-muted" title={`${hidden} more blocking task(s) upstream`}>
          +{hidden} upstream
        </span>
      )}
    </span>
  );
}
