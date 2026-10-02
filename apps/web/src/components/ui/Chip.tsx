import type { ReactNode } from 'react';

export type ChipTone = 'success' | 'running' | 'warning' | 'error' | 'info' | 'accent' | 'muted';
export type ChipVariant = 'outline' | 'soft' | 'solid';

// Full class strings (no interpolation) so Tailwind sees every one.
const TONE: Record<ChipTone, Record<ChipVariant, string>> = {
  success: {
    outline: 'border-status-success text-status-success',
    soft: 'border-status-success/20 bg-status-success/10 text-status-success',
    solid: 'border-status-success bg-status-success text-surface-1',
  },
  running: {
    outline: 'border-status-running text-status-running',
    soft: 'border-status-running/20 bg-status-running/10 text-status-running',
    solid: 'border-status-running bg-status-running text-surface-1',
  },
  warning: {
    outline: 'border-status-warning text-status-warning',
    soft: 'border-status-warning/20 bg-status-warning/10 text-status-warning',
    solid: 'border-status-warning bg-status-warning text-surface-1',
  },
  error: {
    outline: 'border-status-error text-status-error',
    soft: 'border-status-error/20 bg-status-error/10 text-status-error',
    solid: 'border-status-error bg-status-error text-surface-1',
  },
  info: {
    outline: 'border-status-info text-status-info',
    soft: 'border-status-info/20 bg-status-info/10 text-status-info',
    solid: 'border-status-info bg-status-info text-surface-1',
  },
  accent: {
    outline: 'border-accent text-accent-text',
    soft: 'border-accent/20 bg-accent-soft text-accent-text',
    solid: 'border-accent bg-accent text-surface-1',
  },
  muted: {
    outline: 'border-border-strong text-text-muted',
    soft: 'border-border-default bg-surface-3 text-text-muted',
    solid: 'border-surface-4 bg-surface-4 text-text-primary',
  },
};

export interface ChipProps {
  tone: ChipTone;
  variant?: ChipVariant;
  /** Leading square dot in the text colour. Default true. */
  dot?: boolean;
  /** Pulse the dot: live states only. */
  pulse?: boolean;
  children: ReactNode;
  /** A muted suffix after the label, e.g. a relative time `3m`. */
  trailing?: ReactNode;
  className?: string;
  'data-testid'?: string;
  title?: string;
}

/**
 * The one way to show a state word (docs/design/design-system.md §4 Chip):
 * square, 1px border, mono uppercase, optional leading square dot.
 */
export default function Chip({
  tone,
  variant = 'outline',
  dot = true,
  pulse = false,
  children,
  trailing,
  className = '',
  'data-testid': testId,
  title,
}: ChipProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 px-2 py-[3px] border font-mono text-chip font-semibold uppercase tracking-[0.5px] ${TONE[tone][variant]} ${className}`}
      data-tone={tone}
      data-testid={testId}
      title={title}
    >
      {dot && (
        <span aria-hidden="true" className={`w-1.5 h-1.5 shrink-0 bg-current ${pulse ? 'animate-status-pulse' : ''}`} />
      )}
      {children}
      {trailing != null && trailing !== false && <span className="opacity-60">{trailing}</span>}
    </span>
  );
}

export { Chip };
