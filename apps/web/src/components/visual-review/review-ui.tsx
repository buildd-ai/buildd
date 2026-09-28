'use client';

/**
 * Small pieces the visual review components share: button styles, the route
 * grouping (phone and desktop of one route side by side), and an async action
 * button that shows its own busy and error state.
 */
import { useState, type ReactNode } from 'react';
import type { VisualReviewCell, VisualReviewModel } from '@buildd/shared';

export const BTN_BASE =
  'inline-flex items-center justify-center gap-2 border-2 font-mono font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text-primary';
export const BTN_SIZE = 'min-h-10 px-3.5 text-[13px]';
/** The one orange: the primary action of a surface. */
export const BTN_PRIMARY = 'border-accent bg-accent text-white hover:bg-primary-hover hover:border-primary-hover';
export const BTN_SECONDARY = 'border-border-strong bg-surface-3 text-text-primary hover:bg-surface-4';
export const BTN_GHOST = 'border-transparent bg-transparent text-text-secondary hover:text-text-primary hover:bg-surface-3';

export const CHIP = 'inline-flex items-center gap-1 border border-border-default px-1.5 py-px font-mono text-[11px] uppercase tracking-[1px] text-text-secondary';

/** One route (and variant): its phone and desktop cells. */
export interface RouteGroup {
  key: string;
  route: string;
  variant: string | null;
  mobile: VisualReviewCell | null;
  desktop: VisualReviewCell | null;
}

export const groupKeyOf = (c: Pick<VisualReviewCell, 'route' | 'variant'>) => `${c.route}|${c.variant ?? ''}`;

/** Cells grouped by route and variant, in the order the cells come. */
export function groupCells(cells: readonly VisualReviewCell[]): RouteGroup[] {
  const groups = new Map<string, RouteGroup>();
  for (const c of cells) {
    const key = groupKeyOf(c);
    const g = groups.get(key) ?? { key, route: c.route, variant: c.variant, mobile: null, desktop: null };
    g[c.viewport] = c;
    groups.set(key, g);
  }
  return [...groups.values()];
}

export const groupCellsOf = (g: RouteGroup): VisualReviewCell[] => [g.mobile, g.desktop].filter((c): c is VisualReviewCell => !!c);

/** Groups in triage order: a group ranks where its first cell sits in `model.queue`. */
export function groupsInQueueOrder(model: Pick<VisualReviewModel, 'cells' | 'queue'>): RouteGroup[] {
  const byKey = new Map(model.cells.map(c => [c.key, c]));
  const ordered = model.queue.map(k => byKey.get(k)).filter((c): c is VisualReviewCell => !!c);
  const all = groupCells(model.cells);
  const rank = new Map<string, number>();
  ordered.forEach((c, i) => { const k = groupKeyOf(c); if (!rank.has(k)) rank.set(k, i); });
  return all.sort((a, b) => (rank.get(a.key) ?? Infinity) - (rank.get(b.key) ?? Infinity));
}

export interface ActionButtonProps {
  testId: string;
  onAction: () => void | Promise<void>;
  children: ReactNode;
  tone?: 'primary' | 'secondary' | 'ghost';
  busyLabel?: string;
  onError?: (message: string) => void;
  className?: string;
}

/** A button for an async callback: disabled while it runs, errors reported up. */
export function ActionButton({ testId, onAction, children, tone = 'secondary', busyLabel = 'Working…', onError, className = '' }: ActionButtonProps) {
  const [busy, setBusy] = useState(false);
  const toneCls = tone === 'primary' ? BTN_PRIMARY : tone === 'ghost' ? BTN_GHOST : BTN_SECONDARY;
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onAction();
        } catch (e) {
          onError?.(e instanceof Error && e.message ? e.message : 'That did not work. Try again.');
        } finally {
          setBusy(false);
        }
      }}
      className={`${BTN_BASE} ${BTN_SIZE} ${toneCls} ${className}`}
    >
      {busy ? busyLabel : children}
    </button>
  );
}
