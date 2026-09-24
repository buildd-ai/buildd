'use client';

/**
 * MissionMasthead: title, one state chip, the situation sentence, the pulse and
 * a counts caption — one object carried from the Home card to the detail
 * header to the task sheet (docs/design/mission-feed-mobile-continuity.md,
 * "The shared object", W1–W4, W6).
 *
 * It renders what the accessors produced and phrases nothing itself:
 * - `chip` is `deriveMissionStateView(...).chip` (or `getMissionStateChip`), so
 *   STALLED reads STALLED here and on every other surface (D2).
 * - `situation` is `MissionStateView.situation`, rendered by `MissionSituationLine`.
 * - `segments` is `buildPulseSegments(...)`.
 *
 * Sizes:
 * - `card`     — Home and the missions list. Whole card links to the mission; the
 *                one primary line links to its task, never nested in the card link.
 * - `sticky`   — mission detail. `sticky top-0` inside `<main>`; folds on scroll to
 *                one title+chip line plus the pulse ({@link MISSION_MASTHEAD_FOLDED_PX}).
 *                Its pulse reads the enclosing `MissionFocusProvider`.
 * - `micro`    — the task sheet header and the task page's context bar:
 *                title, chip, context pulse ringed on the task, `n / N · PHASE`, ‹ ›.
 */
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PulseSegment } from '@/lib/mission-pulse';
import type { MissionSituation } from '@/lib/mission-state-view';
import MissionPulse from './MissionPulse';
import { MissionSituationLine } from './MissionSituationBlock';

/**
 * Height of the folded sticky masthead: a 44px title line plus the 40px pulse
 * band. Rows use it as `scroll-margin-top` so a focused row lands just under it.
 */
export const MISSION_MASTHEAD_FOLDED_PX = 84;

/** Fold once scrolled past this; unfold only back near the top (hysteresis, no flicker). */
const FOLD_AT_PX = 56;
const UNFOLD_AT_PX = 12;

export function nextMastheadFolded(prev: boolean, scrollTop: number): boolean {
  if (prev) return scrollTop > UNFOLD_AT_PX;
  return scrollTop > FOLD_AT_PX;
}

// Pure, so it lives in the plain model module where a server component can
// call it; re-exported here for the masthead's existing importers.
export { buildPulseCaption } from '@/lib/mission-pulse';

export interface MastheadChip {
  label: string;
  /** Token-only border/text classes from `getMissionStateChip`. */
  cls: string;
}

export interface MastheadPosition {
  n: number;
  total: number;
  phaseLabel: string | null;
  prevHref: string | null;
  nextHref: string | null;
}

export interface MissionMastheadProps {
  size: 'card' | 'sticky' | 'micro';
  title: string;
  chip: MastheadChip;
  segments: readonly PulseSegment[];
  situation?: MissionSituation | null;
  caption?: string | null;
  /** card: the mission. micro: the up-link to the mission (`#t-<task>`). */
  href?: string | null;
  /** card: the one primary line (top NEEDS YOU task, else top MOVING). */
  primary?: { label: string; href: string } | null;
  /** sticky: `‹ Home` / `‹ Missions` / initiative, from `?from=`. */
  back?: { label: string; href: string } | null;
  /** sticky: the Verified pill, beside the chip on first paint. */
  verified?: ReactNode;
  /** sticky: the ⋮ menu. card: an inline control beside the pulse (e.g. Arm). */
  actions?: ReactNode;
  /** sticky and card: the ⤢ control that opens the time-axis strip. */
  expand?: ReactNode;
  /** micro: the task this header is for — ringed on the pulse. */
  selectedTaskId?: string | null;
  /** micro: `n / N · PHASE` and the ‹ › siblings in pulse order. */
  position?: MastheadPosition | null;
  /** micro: step in place (the sheet uses replaceState) instead of following ‹ › hrefs. */
  onStep?: (dir: 'prev' | 'next') => void;
  /** taskId → label for the pulse's scrub label. */
  segmentLabels?: Readonly<Record<string, string>>;
  /**
   * sticky: classes for the header pulse alone (the caption stays). Mission
   * detail passes `md:hidden`, because at md+ the time-axis strip replaces it.
   */
  pulseClassName?: string;
  className?: string;
}

function StateChip({ chip }: { chip: MastheadChip }) {
  return (
    <span
      data-testid="mission-state-chip"
      className={`shrink-0 border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase leading-none tracking-wider ${chip.cls}`}
    >
      {chip.label}
    </span>
  );
}

/** Watch the nearest scroller (`<main>` in the app shell, else the window) and fold past the threshold. */
function useFoldOnScroll(enabled: boolean) {
  const ref = useRef<HTMLElement>(null);
  const [folded, setFolded] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const scroller: HTMLElement | null = ref.current?.closest('main') ?? null;
    const target: HTMLElement | Window = scroller ?? window;
    const read = () => (scroller ? scroller.scrollTop : window.scrollY);
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setFolded(prev => nextMastheadFolded(prev, read()));
      });
    };
    onScroll();
    target.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      target.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [enabled]);
  return { ref, folded };
}

function StepLink({ dir, href, onStep }: { dir: 'prev' | 'next'; href: string | null; onStep?: (dir: 'prev' | 'next') => void }) {
  const glyph = dir === 'prev' ? '‹' : '›';
  const label = dir === 'prev' ? 'Previous task' : 'Next task';
  const box = 'flex h-11 w-11 shrink-0 items-center justify-center font-mono text-[16px]';
  if (!href) {
    return (
      <button
        type="button"
        disabled
        data-testid={`mission-masthead-${dir}`}
        aria-disabled="true"
        aria-label={label}
        className={`${box} cursor-default text-text-muted opacity-40`}
      >
        {glyph}
      </button>
    );
  }
  return (
    <Link
      data-testid={`mission-masthead-${dir}`}
      href={href}
      aria-label={label}
      className={`${box} text-text-primary hover:text-accent-text`}
      onClick={onStep ? e => { e.preventDefault(); onStep(dir); } : undefined}
    >
      {glyph}
    </Link>
  );
}

export default function MissionMasthead(props: MissionMastheadProps) {
  const {
    size, title, chip, segments, situation, caption, href, primary, back, verified, actions, expand,
    selectedTaskId, position, onStep, segmentLabels, pulseClassName = '', className = '',
  } = props;
  const { ref, folded } = useFoldOnScroll(size === 'sticky');

  if (size === 'card') {
    return (
      <article
        data-testid="mission-masthead"
        data-size="card"
        className={`relative border-2 border-border-strong bg-card p-3 shadow-[var(--card-shadow)] transition-transform hover:-translate-y-px ${className}`}
      >
        <div className="flex items-start gap-2">
          <h3 className="min-w-0 flex-1 font-mono text-[14px] font-semibold leading-snug text-text-primary">
            {href ? (
              // Stretched link: the whole card opens the mission; the primary line sits above it.
              <Link href={href} className="after:absolute after:inset-0 after:content-[''] hover:underline">
                {title}
              </Link>
            ) : (
              title
            )}
          </h3>
          <StateChip chip={chip} />
        </div>
        {situation && (
          <div className="mt-1">
            <MissionSituationLine situation={situation} />
          </div>
        )}
        <div className="mt-2 flex items-center gap-3">
          <MissionPulse variant="card" segments={segments} className="flex-1" />
          {caption && <span className="shrink-0 font-mono text-[11px] text-text-muted">{caption}</span>}
          {/* Controls sit above the stretched card link, never inside it. */}
          {(expand || actions) && (
            <span className="relative z-10 flex shrink-0 items-center gap-1">
              {actions}
              {expand}
            </span>
          )}
        </div>
        {primary && (
          <Link
            data-testid="mission-masthead-primary"
            href={primary.href}
            className="relative z-10 mt-2 flex min-h-[44px] items-center gap-2 border-t border-border-default pt-2 font-mono text-[12px] text-accent-text hover:underline"
          >
            <span aria-hidden="true">▸</span>
            <span className="min-w-0 flex-1 truncate">{primary.label}</span>
            <span aria-hidden="true">›</span>
          </Link>
        )}
      </article>
    );
  }

  if (size === 'sticky') {
    return (
      <header
        ref={ref}
        data-testid="mission-masthead"
        data-size="sticky"
        data-folded={String(folded)}
        className={`sticky top-0 z-20 border-b-2 border-border-strong bg-surface-1 ${className}`}
      >
        <div className="flex min-h-[44px] items-center gap-2">
          {back && (
            <Link
              href={back.href}
              aria-label={`Back to ${back.label}`}
              className="flex h-11 shrink-0 items-center font-mono text-[12px] text-text-secondary hover:text-text-primary"
            >
              {folded ? '‹' : `‹ ${back.label}`}
            </Link>
          )}
          <h1 className="min-w-0 flex-1 truncate font-mono text-[16px] font-semibold text-text-primary">{title}</h1>
          {folded && <StateChip chip={chip} />}
          {actions}
        </div>
        {!folded && (
          <div className="flex min-h-[28px] flex-wrap items-center gap-2">
            <StateChip chip={chip} />
            {verified}
          </div>
        )}
        <div className="flex items-center gap-2">
          <MissionPulse variant="header" segments={segments} connected segmentLabels={segmentLabels} className={`flex-1 ${pulseClassName}`} />
          {caption && <span className="ml-auto shrink-0 font-mono text-[11px] text-text-muted">{caption}</span>}
          {expand}
        </div>
      </header>
    );
  }

  // micro
  return (
    <div data-testid="mission-masthead" data-size="micro" className={`bg-surface-1 ${className}`}>
      <div className="flex min-h-11 items-center gap-2">
        {href ? (
          <Link href={href} className="flex min-h-11 min-w-0 flex-1 items-center font-mono text-[13px] font-semibold text-text-primary hover:underline">
            <span className="min-w-0 truncate">{`‹ ${title}`}</span>
          </Link>
        ) : (
          <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-semibold text-text-primary">{title}</span>
        )}
        <StateChip chip={chip} />
      </div>
      <div className="flex items-center gap-2">
        <MissionPulse variant="context" segments={segments} selectedTaskId={selectedTaskId} className="flex-1" />
        {position && (
          <>
            <span className="shrink-0 font-mono text-[11px] text-text-muted">
              {`${position.n} / ${position.total}${position.phaseLabel ? ` · ${position.phaseLabel}` : ''}`}
            </span>
            <StepLink dir="prev" href={position.prevHref} onStep={onStep} />
            <StepLink dir="next" href={position.nextHref} onStep={onStep} />
          </>
        )}
      </div>
    </div>
  );
}
