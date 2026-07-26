import { timeAgo } from './mission-helpers';

/**
 * Presentation helpers for the initiative rail / list cards. Pure — no DB, no
 * JSX — so ordering and labelling are unit-testable and shared by every surface.
 * The rollup status vocabulary is `empty | active | blocked | paused | completed`
 * (from `computeInitiativeProgress`).
 */

type Sortable = { progress: { status: string }; lastMotionAt: string | null };

// Blocked floats to the top; then active, paused, completed; empty (no work) last.
const STATUS_RANK: Record<string, number> = { blocked: 0, active: 1, paused: 2, completed: 3, empty: 4 };

/**
 * Sort blocked-first, then by recency of motion (newest first); initiatives with
 * no motion sink within their status band. Non-mutating.
 */
export function sortInitiatives<T extends Sortable>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const ra = STATUS_RANK[a.progress.status] ?? 5;
    const rb = STATUS_RANK[b.progress.status] ?? 5;
    if (ra !== rb) return ra - rb;
    const ta = a.lastMotionAt ?? '';
    const tb = b.lastMotionAt ?? '';
    if (ta === tb) return 0;
    if (!ta) return 1; // a has no motion → sinks
    if (!tb) return -1;
    return ta < tb ? 1 : -1; // larger (newer) ISO string first
  });
}

export interface StatusChipStyle {
  label: string;
  /** Token-only Tailwind classes; square corners, no off-palette hex. */
  className: string;
}

/** Map a rollup status to a chip. Never invents colours outside the token set. */
export function initiativeStatusChip(status: string): StatusChipStyle {
  switch (status) {
    case 'blocked':
      return { label: 'BLOCKED', className: 'bg-status-warning text-text-primary border-status-warning' };
    case 'active':
      return { label: 'ACTIVE', className: 'bg-accent-soft text-accent-text border-accent-border' };
    case 'paused':
      return { label: 'PAUSED', className: 'bg-card text-accent-text border-accent-border' };
    case 'completed':
      return { label: 'COMPLETED', className: 'bg-status-success text-text-primary border-status-success' };
    default:
      return { label: 'EMPTY', className: 'bg-card text-text-muted border-border-default' };
  }
}

/**
 * "moved 2h ago" / "shipped 1d ago" / "blocked 5h ago" / "paused 2d ago", or
 * "no activity yet" when the initiative has no child-mission motion. The verb is
 * driven by rollup status so the line never contradicts the status chip.
 */
export function motionLabel(item: Sortable): string {
  if (!item.lastMotionAt) return 'no activity yet';
  const verb =
    item.progress.status === 'completed' ? 'shipped'
    : item.progress.status === 'blocked' ? 'blocked'
    : item.progress.status === 'paused' ? 'paused'
    : 'moved';
  return `${verb} ${timeAgo(item.lastMotionAt)}`;
}
