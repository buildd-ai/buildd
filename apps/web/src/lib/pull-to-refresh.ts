/**
 * Gesture math for the shell's pull-to-refresh (components/AppFreshness.tsx).
 *
 * The protected shell scrolls inside `<main data-scroll-root>`, not the
 * document, so the browser's own pull-to-refresh never triggers there — and a
 * native one would be a full reload anyway. This tracks one touch from the top
 * of the scroll root and decides whether it is a pull, how far the indicator
 * travels, and whether release should refresh. Free of the DOM so it is
 * testable with plain numbers.
 */

/** Indicator travel (px, after damping) at which release refreshes. */
export const PULL_THRESHOLD_PX = 64;
/** Indicator never travels further than this. */
export const PULL_MAX_PX = 96;
/** Finger travel is divided by this, so the pull feels weighted. */
const DAMPING = 2;
/** Vertical travel needed before we decide it's a pull rather than a tap/scroll. */
const SLOP_PX = 6;

export type PullPhase = 'idle' | 'tracking' | 'pulling' | 'ignored';

export interface PullMove {
  /** Indicator offset to render, 0..PULL_MAX_PX. */
  distance: number;
  /** Past the threshold: release will refresh. */
  armed: boolean;
  /** The gesture is ours: preventDefault the touchmove so the page doesn't scroll. */
  consume: boolean;
}

export interface PullTracker {
  readonly phase: PullPhase;
  /**
   * A touch began. `atTop` = the scroll root (and any scroller under the
   * finger) is at scrollTop 0; `enabled` = no overlay holds the scroll lock and
   * no refresh is in flight. Anything else and this gesture is ignored.
   */
  start(x: number, y: number, ctx: { atTop: boolean; enabled: boolean; touches: number }): void;
  move(x: number, y: number): PullMove;
  /** Touch ended: true when the release should refresh. */
  end(): boolean;
  cancel(): void;
}

export function pullDistance(dy: number): number {
  if (dy <= 0) return 0;
  return Math.min(PULL_MAX_PX, dy / DAMPING);
}

const NONE: PullMove = { distance: 0, armed: false, consume: false };

export function createPullTracker(): PullTracker {
  let phase: PullPhase = 'idle';
  let startX = 0;
  let startY = 0;
  let distance = 0;

  return {
    get phase() {
      return phase;
    },
    start(x, y, ctx) {
      startX = x;
      startY = y;
      distance = 0;
      phase = ctx.atTop && ctx.enabled && ctx.touches === 1 ? 'tracking' : 'ignored';
    },
    move(x, y) {
      if (phase !== 'tracking' && phase !== 'pulling') return NONE;
      const dy = y - startY;
      const dx = x - startX;
      if (phase === 'tracking') {
        if (Math.abs(dy) < SLOP_PX && Math.abs(dx) < SLOP_PX) return NONE;
        // Upward or mostly-sideways (a carousel, a swipe) is not a pull.
        if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) {
          phase = 'ignored';
          return NONE;
        }
        phase = 'pulling';
      }
      distance = pullDistance(dy);
      return { distance, armed: distance >= PULL_THRESHOLD_PX, consume: true };
    },
    end() {
      const fire = phase === 'pulling' && distance >= PULL_THRESHOLD_PX;
      phase = 'idle';
      distance = 0;
      return fire;
    },
    cancel() {
      phase = 'idle';
      distance = 0;
    },
  };
}
