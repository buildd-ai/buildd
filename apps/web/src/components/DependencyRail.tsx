'use client';

import Link from 'next/link';
import type { BlockRef } from '@/lib/task-presentation';

/**
 * Edge classes the rail draws (timeline-mobile-rail.md §3). Each survives
 * greyscale on its own: solid line / dashed line.
 *
 * There are **two**, not three. An edge on this rail answers "what had to happen
 * before this could start" — a retry answers "this node ran more than once",
 * which is a property of a node, not a branch between nodes. v1's `'retry'`
 * member borrowed the graph's vocabulary to say something the graph does not
 * mean, and cost a lane slot to do it; the fact now lives in the right column's
 * outcome mark (§6.4). Red is freed as an edge colour and is not reassigned to
 * one (Rule D3-7).
 */
export type RailEdgeKind = 'hard' | 'soft' | 'none';

interface DependencyRailProps {
  /**
   * The blockers to name — pass `chain.blockedByFrontier`, not `chain.blockedBy`.
   * The frontier is already transitively reduced, so these are the deps the task
   * is *directly* waiting on.
   */
  blockedBy?: BlockRef[];
  /**
   * Total blocker count (`chain.blockedBy.length`). When it exceeds the number
   * of named chips, the difference is summarised as a "+N upstream" tail.
   */
  totalBlocked?: number;
  /** How many blockers to name before collapsing the rest into the tail. */
  max?: number;
  /**
   * `chips` (default) is the desktop treatment: one `← {title}` chip per direct
   * blocker. `line` is the mobile rail's treatment of the SAME edge — the rail's
   * premise is that vertical adjacency *is* the chip, so the edge becomes a line
   * segment instead of text.
   */
  mode?: 'chips' | 'line';
  /** Line mode: the class of the segment entering the node below this one. */
  edge?: RailEdgeKind;
}

/** Titles longer than this are truncated; keeps the rail on one line in row density. */
const MAX_TITLE_CHARS = 46;

const truncate = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;

/**
 * Line-mode stroke classes. Amber solid is the hard `dependsOn` edge — the same
 * token the chips below use, so "hard dependency" reads identically on both
 * surfaces. Grey dashed is advisory pathManifest ordering. The two do not share
 * a greyscale pattern (§3.4).
 */
const EDGE_STROKE: Record<Exclude<RailEdgeKind, 'none'>, string> = {
  hard: 'border-status-warning',
  soft: 'border-text-muted border-dashed',
};

/**
 * Blocker reference rail — two render modes over the same `dependsOn` edge.
 *
 * `chips` (desktop): one `← {title}` chip per direct blocker, plus `#{pr}` when
 * the blocker is the half state (completed, PR still open) — the case that looks
 * finished but silently gates everything downstream. Chips link to the blocking
 * task. Prose (`← blocked on {title} because …`) is still banned; chip form is
 * the only output. Naming the blocker inside the chip is not prose — it replaces
 * the bare `← afa5b0` hash, which told a reader nothing they could act on.
 *
 * `line` (mobile rail): the same edge as a vertical stroke between adjacent rail
 * nodes, classed per `EDGE_STROKE`. On the rail, adjacency IS the chip.
 */
export function DependencyRail({ blockedBy = [], totalBlocked, max = 2, mode = 'chips', edge = 'none' }: DependencyRailProps) {
  if (mode === 'line') {
    return (
      <span
        className={`block w-0 h-full ${edge === 'none' ? 'border-l border-border-default' : `border-l ${EDGE_STROKE[edge]}`}`}
        aria-hidden="true"
      />
    );
  }

  if (blockedBy.length === 0) return null;

  const named = blockedBy.slice(0, max);
  // Blockers hidden by the cap, plus blockers the frontier reduction folded away.
  const hidden = Math.max(totalBlocked ?? blockedBy.length, blockedBy.length) - named.length;

  return (
    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono text-[11px] md:text-[10px] text-status-warning min-w-0 mt-0.5">
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
