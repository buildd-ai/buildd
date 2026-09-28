'use client';

/**
 * One audit screenshot, and the pieces every visual review surface shares:
 * the verdict dot colour, the frame proportions per viewport and the expired
 * tile (docs/design/visual-qa-human-review.md, part 2).
 *
 * The image always loads through the access-checked
 * `/api/artifacts/:id/download` route, never a signed URL or a share token:
 * audit shots are private. The only other source it accepts is an inline SVG
 * sketch, which is what the dev fixtures draw. An image that fails to load is
 * an object the storage lifecycle rule expired; the row outlives it, so the
 * tile says "expired" and the finding and the decision stay usable as text.
 */
import { useState } from 'react';
import type { VisualQaVerdict, VisualQaViewport, VisualReviewShot } from '@buildd/shared';

export const VERDICT_DOT: Record<VisualQaVerdict, string> = {
  ok: 'bg-status-success',
  issue: 'bg-status-error',
  unsure: 'bg-status-info',
};

export const VERDICT_TEXT: Record<VisualQaVerdict, string> = {
  ok: 'text-status-success',
  issue: 'text-status-error',
  unsure: 'text-status-info',
};

export const VERDICT_LABEL: Record<VisualQaVerdict, string> = {
  ok: 'ok',
  issue: 'issue',
  unsure: 'unsure',
};

export const VIEWPORT_LABEL: Record<VisualQaViewport, string> = {
  mobile: 'Phone',
  desktop: 'Desktop',
};

/** Frame proportions per capture viewport (`scripts/qa/viewport.ts`). */
export function viewportAspect(viewport: string): string {
  if (viewport === 'mobile') return 'aspect-[390/844]';
  if (viewport === 'desktop') return 'aspect-[1280/900]';
  return 'aspect-square';
}

/** The download route for a shot. An inline SVG sketch (fixtures) passes through. */
export function shotImageSrc(shot: Pick<VisualReviewShot, 'id' | 'src'>): string {
  if (shot.src.startsWith('data:image/svg+xml,')) return shot.src;
  return `/api/artifacts/${encodeURIComponent(shot.id)}/download`;
}

export function ExpiredTile({ large = false }: { large?: boolean }) {
  return (
    <span
      data-testid="visual-review-expired"
      className="flex h-full min-h-16 w-full flex-col items-center justify-center gap-1 border-2 border-dashed border-border-strong bg-surface-2 p-2 text-center font-mono uppercase text-text-secondary"
    >
      <span className={large ? 'text-[13px] tracking-[2px]' : 'text-[11px] md:text-[9px] tracking-[1.5px]'}>expired</span>
      {large && <span className="text-[12px] normal-case text-text-muted">Screenshot expired. The finding is kept.</span>}
    </span>
  );
}

export interface ShotImageProps {
  shot: Pick<VisualReviewShot, 'id' | 'src'>;
  alt: string;
  className?: string;
  /** The large expired tile (the deck), not the thumbnail one. */
  large?: boolean;
  /** Thumbnails load lazily; the deck's open shot eagerly. */
  eager?: boolean;
  onExpired?: (id: string) => void;
}

export default function ShotImage({ shot, alt, className = '', large = false, eager = false, onExpired }: ShotImageProps) {
  const src = shotImageSrc(shot);
  // Keyed by src: a new shot in the same slot gets a fresh try.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (failedSrc === src) return <ExpiredTile large={large} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- access-checked redirect to storage; next/image would proxy it
    <img
      src={src}
      alt={alt}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      draggable={false}
      data-testid="visual-review-img"
      onError={() => {
        setFailedSrc(src);
        onExpired?.(shot.id);
      }}
      className={className}
    />
  );
}
