'use client';

/**
 * One audit screenshot, full size, with what the auditor said about it: the
 * route, viewport, theme, verdict, finding and the fix task it filed
 * (docs/design/visual-qa-auditor.md, "Where the screenshots show").
 *
 * Built on the shared `Dialog` (Escape, focus trap, focus restore, backdrop
 * dismiss); ←/→ walk the run and wrap, which `Dialog` does not do.
 */
import { useEffect, useRef } from 'react';
import Dialog from '@/components/ui/Dialog';
import type { VisualShot } from '@/lib/mission-visual-review';
import { taskPageHref } from '@/lib/mission-task-href';
import { ExpiredTile, VERDICT_DOT, viewportAspect } from './visual-review-parts';

export interface VisualReviewLightboxProps {
  shots: readonly VisualShot[];
  /** The open shot; null when closed. */
  index: number | null;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  expired: ReadonlySet<string>;
  onExpired: (id: string) => void;
  missionId?: string | null;
}

const TITLE_ID = 'visual-review-lightbox-route';
const NAV_BUTTON =
  'flex-1 border-2 border-border-strong bg-surface-2 px-2 py-1.5 font-mono text-[11px] uppercase tracking-[1.5px] text-text-primary hover:bg-surface-4';

export default function VisualReviewLightbox({
  shots,
  index,
  onIndexChange,
  onClose,
  expired,
  onExpired,
  missionId,
}: VisualReviewLightboxProps) {
  const open = index != null && index >= 0 && index < shots.length;
  const n = shots.length;
  const step = (delta: number) => {
    if (index == null || n === 0) return;
    onIndexChange((index + delta + n) % n);
  };

  // Keep the listener stable across renders; read the latest step through a ref.
  const stepRef = useRef(step);
  stepRef.current = step;
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        stepRef.current(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        stepRef.current(1);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  if (!open) return null;
  const shot = shots[index];
  const { qa } = shot;
  const isExpired = expired.has(shot.id);

  return (
    <Dialog
      open
      onClose={onClose}
      labelledBy={TITLE_ID}
      className="relative mx-4 grid max-h-[calc(100vh-3rem)] w-full max-w-[min(1100px,calc(100vw-2rem))] overflow-auto border-2 border-border-strong bg-card shadow-lg outline-none md:grid-cols-[minmax(0,1fr)_320px]"
    >
      <div className="flex min-h-[260px] items-center justify-center border-b-2 border-border-strong bg-surface-3 p-4 md:min-h-[420px] md:border-b-0 md:border-r-2 md:p-6">
        {isExpired ? (
          <span className={`block w-full max-w-[600px] ${viewportAspect('desktop')}`}>
            <ExpiredTile large />
          </span>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- signed R2 redirect; next/image would proxy it
          <img
            src={shot.src}
            alt={`${qa.route} at ${qa.viewport}`}
            onError={() => onExpired(shot.id)}
            // Capped lower on phones so the finding and its fix-task link stay above the fold.
            className="block max-h-[42vh] max-w-full border-2 border-border-strong shadow-lg md:max-h-[66vh]"
          />
        )}
      </div>

      <div className="flex flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <p className="section-label">{`Shot ${index + 1} / ${n}`}</p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center border-2 border-border-strong bg-card font-mono text-[16px] leading-none text-text-primary shadow-sm hover:bg-surface-3"
          >
            ×
          </button>
        </div>
        <h2 id={TITLE_ID} data-testid="visual-review-lightbox-route" className="break-all font-mono text-[16px] font-semibold text-text-primary">
          {qa.route}
        </h2>
        <dl className="grid grid-cols-[88px_1fr] gap-x-2.5 gap-y-1.5 font-mono text-[12px]">
          <dt className="pt-px text-[10.5px] uppercase tracking-[1.5px] text-text-muted">Viewport</dt>
          <dd className="text-text-primary">{qa.viewport}</dd>
          {qa.theme && (
            <>
              <dt className="pt-px text-[10.5px] uppercase tracking-[1.5px] text-text-muted">Theme</dt>
              <dd className="text-text-primary">{qa.theme}</dd>
            </>
          )}
          <dt className="pt-px text-[10.5px] uppercase tracking-[1.5px] text-text-muted">Verdict</dt>
          <dd className="inline-flex items-center gap-1.5 text-text-primary">
            <i aria-hidden="true" className={`inline-block h-2 w-2 ${VERDICT_DOT[qa.verdict]}`} />
            {qa.verdict}
          </dd>
        </dl>
        <div>
          <p className="section-label mb-1.5">Finding</p>
          <p className="border-l-[3px] border-border-strong py-1 pl-3 text-[14px] text-text-primary">{qa.finding}</p>
        </div>
        {qa.fixTaskId && (
          <a
            data-testid="visual-review-fix-task"
            href={taskPageHref({ taskId: qa.fixTaskId, missionId })}
            className="border-2 border-border-default bg-surface-2 px-3 py-2 text-[13px] font-medium text-accent-text hover:border-border-strong"
          >
            Open the fix task →
          </a>
        )}
        {n > 1 && (
          <div className="mt-auto flex gap-2">
            <button type="button" onClick={() => step(-1)} className={NAV_BUTTON}>← Prev</button>
            <button type="button" onClick={() => step(1)} className={NAV_BUTTON}>Next →</button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
