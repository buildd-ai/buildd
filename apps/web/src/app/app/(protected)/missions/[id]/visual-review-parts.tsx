/**
 * Pieces shared by `VisualReviewStrip` and `VisualReviewLightbox`: the verdict
 * dot colour, the frame proportions per viewport, and the expired tile.
 */
import type { QaVerdict } from '@/lib/mission-visual-review';

export const VERDICT_DOT: Record<QaVerdict, string> = {
  ok: 'bg-status-success',
  issue: 'bg-status-error',
  unsure: 'bg-status-info',
};

/** Frame proportions per capture viewport (`scripts/qa/viewport.ts`). */
export function viewportAspect(viewport: string): string {
  if (viewport === 'mobile') return 'aspect-[390/844]';
  if (viewport === 'desktop') return 'aspect-[1280/900]';
  return 'aspect-square';
}

export function ExpiredTile({ large = false }: { large?: boolean }) {
  return (
    <span
      data-testid="visual-review-expired"
      className="flex h-full w-full flex-col items-center justify-center gap-1 border-2 border-dashed border-border-strong bg-surface-2 text-center font-mono uppercase text-text-secondary"
    >
      <span className={large ? 'text-[13px] tracking-[2px]' : 'text-[11px] md:text-[9px] tracking-[1.5px]'}>expired</span>
      {large && <span className="text-[11px] normal-case text-text-muted">The screenshot aged out; the finding is kept.</span>}
    </span>
  );
}
