/**
 * The one status → colour mapping. Brand rule: orange (`accent`) = moving /
 * in progress, green (`success`) = done / success, amber (`warning`) = needs a
 * human or is held, red (`error`) = broken, muted = quiet.
 *
 * Every status chip, word, square and edge reads its classes from here, so a
 * state cannot be green on one surface and orange on another (RUNNING was
 * green on the mission page and orange on Home).
 */
import type { MissionDisplayState } from './mission-helpers';

export type StatusTone = 'accent' | 'success' | 'warning' | 'error' | 'muted' | 'info';

/** Bordered chip: border + text. */
export const STATUS_TONE_CHIP: Record<StatusTone, string> = {
  accent: 'border-accent text-accent-text',
  success: 'border-status-success text-status-success',
  warning: 'border-status-warning text-status-warning',
  error: 'border-status-error text-status-error',
  muted: 'border-border-default text-text-muted',
  info: 'border-status-info text-status-info',
};

/** A bare status word. */
export const STATUS_TONE_TEXT: Record<StatusTone, string> = {
  accent: 'text-accent-text',
  success: 'text-status-success',
  warning: 'text-status-warning',
  error: 'text-status-error',
  muted: 'text-text-secondary',
  info: 'text-status-info',
};

/** The small square before a status word. */
export const STATUS_TONE_SQUARE: Record<StatusTone, string> = {
  accent: 'bg-accent',
  success: 'bg-status-success',
  warning: 'bg-status-warning',
  error: 'bg-status-error',
  muted: 'border-2 border-text-secondary',
  info: 'bg-status-info',
};

/** A card's left edge. */
export const STATUS_TONE_EDGE: Record<StatusTone, string> = {
  accent: 'border-l-accent',
  success: 'border-l-status-success',
  warning: 'border-l-status-warning',
  error: 'border-l-status-error',
  muted: 'border-l-border-strong',
  info: 'border-l-status-info',
};

/** A mission's display state → its tone. */
export function missionStateTone(state: MissionDisplayState): StatusTone {
  switch (state) {
    case 'running':
    case 'local': return 'accent';
    case 'review':
    case 'complete': return 'success';
    case 'held':
    case 'stranded':
    case 'stalled':
    case 'awaiting_verification':
    case 'waiting_decision': return 'warning';
    case 'blocked':
    case 'failed': return 'error';
    case 'manual': return 'muted';
    case 'active': return 'info';
  }
}
