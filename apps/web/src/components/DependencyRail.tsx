'use client';

import type { BlockRef } from '@/lib/task-presentation';

interface DependencyRailProps {
  blockedBy: BlockRef[];
}

/**
 * Cross-group / off-screen blocker reference chip.
 *
 * Renders a compact `← #N` chip for each blocker. Used when the blocker is in
 * a different section (fan-in) or not visible in the current render tree.
 *
 * Prose (`← blocked on {title}`) is banned — chip form is the only output.
 */
export function DependencyRail({ blockedBy }: DependencyRailProps) {
  if (blockedBy.length === 0) return null;

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
