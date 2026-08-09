import { timeAgo } from './mission-helpers';

/**
 * Presentation helpers for the initiative rail / list cards. Pure — no DB, no
 * JSX — so ordering and labelling are unit-testable and shared by every surface.
 *
 * Three orthogonal dimensions (borrowing Linear's model):
 *   status     — explicit lifecycle from DB: active | paused | completed | archived
 *   progress   — derived: n/m missions, % tasks (never the word "Completed")
 *   health     — derived/evaluated: on mission cards, not initiative cards
 *
 * The rollup vocabulary from computeInitiativeProgress is an internal metric:
 * 'empty' | 'active' | 'blocked' | 'paused' | 'completed'.
 * It must NOT be used directly as a display label — use deriveInitiativeDisplayStatus instead.
 */

export type InitiativeDisplayStatus =
  | 'active'
  | 'blocked'
  | 'awaiting_verification'
  | 'paused'
  | 'archived'
  | 'completed'
  | 'empty';

/**
 * Derive the display status for an initiative chip.
 *
 * Priority rules:
 * - DB lifecycle status (paused / completed / archived) always wins — these are
 *   deliberate human transitions, never auto-derived from mission counts.
 * - For active DB status, the rollup from child missions overrides:
 *   - budget_exhausted child → 'blocked'
 *   - all missions terminal but initiative not yet completed → 'awaiting_verification'
 *   - otherwise → 'active'
 */
export function deriveInitiativeDisplayStatus(opts: {
  status: 'active' | 'paused' | 'completed' | 'archived';
  rollupStatus: 'empty' | 'active' | 'blocked' | 'paused' | 'completed';
}): InitiativeDisplayStatus {
  if (opts.status === 'completed') return 'completed';
  if (opts.status === 'paused') return 'paused';
  if (opts.status === 'archived') return 'archived';
  // DB status is 'active' — derive from child mission rollup
  if (opts.rollupStatus === 'blocked') return 'blocked';
  // All missions terminal but organizer has not yet marked the initiative complete
  if (opts.rollupStatus === 'completed') return 'awaiting_verification';
  if (opts.rollupStatus === 'empty') return 'empty';
  return 'active';
}

// Blocked floats to the top; awaiting_verification between active and paused; archived before completed.
const DISPLAY_RANK: Record<string, number> = {
  blocked: 0,
  active: 1,
  awaiting_verification: 1.5,
  paused: 2,
  archived: 2.5,
  completed: 3,
  empty: 4,
};

type Sortable = {
  /** DB initiative status. */
  status: string;
  /** Rollup from computeInitiativeProgress. */
  progress: { status: string };
  lastMotionAt: string | null;
};

/**
 * Sort blocked-first, then by derived display status; within a band, newest
 * motion first (no-motion sinks). Non-mutating.
 */
export function sortInitiatives<T extends Sortable>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const da = deriveInitiativeDisplayStatus({ status: a.status as any, rollupStatus: a.progress.status as any });
    const db = deriveInitiativeDisplayStatus({ status: b.status as any, rollupStatus: b.progress.status as any });
    const ra = DISPLAY_RANK[da] ?? 5;
    const rb = DISPLAY_RANK[db] ?? 5;
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

/** Map a derived display status to a chip style. Never invents colours outside the token set. */
export function initiativeStatusChip(status: string): StatusChipStyle {
  switch (status) {
    case 'blocked':
      return { label: 'BLOCKED', className: 'bg-status-warning text-text-primary border-status-warning' };
    case 'active':
      return { label: 'ACTIVE', className: 'bg-accent-soft text-accent-text border-accent-border' };
    case 'paused':
      return { label: 'PAUSED', className: 'bg-card text-accent-text border-accent-border' };
    case 'awaiting_verification':
      return { label: 'AWAITING', className: 'bg-card text-status-warning border-status-warning/40' };
    case 'completed':
      return { label: 'COMPLETED', className: 'bg-status-success text-text-primary border-status-success' };
    case 'archived':
      return { label: 'ARCHIVED', className: 'bg-card text-text-muted border-border-default' };
    default:
      return { label: 'EMPTY', className: 'bg-card text-text-muted border-border-default' };
  }
}

/**
 * "moved 2h ago" / "shipped 1d ago" / "blocked 5h ago" / "paused 2d ago", or
 * "no activity yet" when the initiative has no child-mission motion. The verb is
 * driven by derived display status so the line never contradicts the status chip.
 */
export function motionLabel(item: Sortable): string {
  if (!item.lastMotionAt) return 'no activity yet';
  const display = deriveInitiativeDisplayStatus({
    status: item.status as any,
    rollupStatus: item.progress.status as any,
  });
  const verb =
    display === 'completed' ? 'shipped'
    : display === 'blocked' ? 'blocked'
    : display === 'paused' ? 'paused'
    : display === 'archived' ? 'archived'
    : 'moved';
  return `${verb} ${timeAgo(item.lastMotionAt)}`;
}
