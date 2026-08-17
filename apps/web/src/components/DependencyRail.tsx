'use client';

import type { BlockRef } from '@/lib/task-presentation';

interface DependencyRailProps {
  blockedBy: BlockRef[];
  /**
   * When true the blocker task is visible directly above this row in the same
   * group and the parent has already applied the elbow-rail indentation CSS
   * (ml-4 + border-l). This component renders nothing — the geometry is the
   * signal.
   *
   * When false the blocker is in a different group or off-screen: render a
   * compact reference chip.
   */
  blockerVisible: boolean;
}

/**
 * Replaces the `← blocked on {title}` prose div in TaskCard.
 *
 * Primary form (blockerVisible=true): renders nothing — indentation from the
 * parent wrapper carries the signal.
 *
 * Secondary form (blockerVisible=false): compact `← #N` chip that identifies
 * the blocker without repeating its full title.
 *
 * Last-resort fallback (no id/prNumber): a short muted id reference.
 */
export function DependencyRail({ blockedBy, blockerVisible }: DependencyRailProps) {
  if (blockedBy.length === 0) return null;
  if (blockerVisible) return null;

  const refs = blockedBy.map((b) => {
    if (b.prNumber) return `← #${b.prNumber}`;
    return `← ${b.id.slice(0, 6)}`;
  });

  return (
    <span className="font-mono text-[10px] text-status-warning shrink-0 mt-0.5">
      {refs.join(', ')}
    </span>
  );
}
