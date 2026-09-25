'use client';

// Client component: the "Shipped" link stops propagation so a click inside a
// clickable TaskCard row does not also trigger the row. The task detail page
// (a server component) mounts it too, and a server module cannot hand an
// onClick to next/link — that failed the whole page render.
import Link from 'next/link';

// Spec: docs/specs/surface-ia-home-missions-initiatives.md §10.3 — task-level
// ship state is badge-only annotation, never a rail segment. States are
// additive: a force-released task whose release later goes healthy shows
// both "Force release" and "Shipped" at once.
export type TaskShipBadgeProps = {
  release: 'true' | 'false' | 'inherit' | null | undefined;
  /** Set when release_tasks attributes this task to a release in state 'healthy'. */
  shippedReleaseId?: string | null;
};

export function TaskShipBadge({ release, shippedReleaseId }: TaskShipBadgeProps) {
  const showSkip = release === 'false';
  const showForce = release === 'true';
  const showShipped = !!shippedReleaseId;

  // 'inherit' with no attribution is the default, silent case (AC-49) — no
  // chrome, not even a wrapper span.
  if (!showSkip && !showForce && !showShipped) return null;

  return (
    <span className="inline-flex items-center gap-1 shrink-0">
      {showSkip && (
        <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-text-muted/10 text-text-muted">
          Skip release
        </span>
      )}
      {showForce && (
        <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-status-warning/10 text-status-warning">
          Force release
        </span>
      )}
      {showShipped && (
        <Link
          href={`/app/releases/${shippedReleaseId}`}
          onClick={(e) => e.stopPropagation()}
          className="relative z-10 pointer-events-auto px-1.5 py-0.5 text-[10px] font-medium rounded bg-status-success/10 text-status-success hover:bg-status-success/20 transition-colors"
        >
          Shipped
        </Link>
      )}
    </span>
  );
}

export default TaskShipBadge;
