/**
 * The sea (knowledge-base: buildd/design/chat-canvas.md, "The sea"): the one soft element on the
 * chat surface. Round, blurred pools of colour drift slowly behind the canvas,
 * like water seen from above. They carry the mood (calm neutral, one decision-orange pool
 * when something needs the person, audit blue while a turn streams) and
 * never read as data: no lines, bars or streaks. Pure.
 */
import type { CanvasMood } from './canvas-empty';

export type SeaMood = CanvasMood | 'thinking';

export interface SeaPool {
  /** Centre, as a percentage of the layer. */
  x: number;
  y: number;
  /** Diameter in px. */
  size: number;
  /** Drift reach in px (the loop goes out and back). */
  dx: number;
  dy: number;
  /** The slow drift, always on. */
  calmSeconds: number;
  /** The faster current layered on top while a turn streams. */
  thinkingSeconds: number;
  /** Which of the four mood colours this pool takes. */
  slot: 1 | 2 | 3 | 4;
  /** Negative delay so pools start mid-loop, out of step. */
  delay: number;
}

/**
 * Fixed geometry: pools keep their place across moods, so a mood change is a
 * colour cross-fade, never a jump. Nine pools, overlapping.
 */
export const SEA_POOLS: readonly SeaPool[] = [
  { x: 18, y: 10, size: 300, dx: 36, dy: 28, calmSeconds: 41, thinkingSeconds: 17, slot: 1, delay: -7 },
  { x: 78, y: 16, size: 240, dx: -30, dy: 34, calmSeconds: 33, thinkingSeconds: 15, slot: 2, delay: -19 },
  { x: 50, y: 34, size: 320, dx: 26, dy: -38, calmSeconds: 52, thinkingSeconds: 22, slot: 4, delay: -3 },
  { x: 10, y: 52, size: 220, dx: 42, dy: 24, calmSeconds: 29, thinkingSeconds: 14, slot: 3, delay: -12 },
  { x: 86, y: 60, size: 280, dx: -38, dy: -26, calmSeconds: 46, thinkingSeconds: 20, slot: 1, delay: -25 },
  { x: 40, y: 70, size: 260, dx: 30, dy: 40, calmSeconds: 37, thinkingSeconds: 18, slot: 2, delay: -9 },
  { x: 70, y: 86, size: 300, dx: -44, dy: -30, calmSeconds: 49, thinkingSeconds: 23, slot: 4, delay: -31 },
  { x: 20, y: 90, size: 190, dx: 28, dy: -34, calmSeconds: 31, thinkingSeconds: 16, slot: 3, delay: -5 },
  { x: 60, y: 50, size: 170, dx: -24, dy: 36, calmSeconds: 43, thinkingSeconds: 19, slot: 2, delay: -15 },
];

/** The pool that turns copper while something needs the person: low, near the picked rows. */
const NEEDS_POOL = 6;

export interface SeaPoolView extends SeaPool {
  colour: string;
}

export function seaPools(mood: SeaMood): SeaPoolView[] {
  return SEA_POOLS.map((p, i) => {
    const family = mood === 'thinking' ? 'thinking' : 'calm';
    const colour = mood === 'needs' && i === NEEDS_POOL ? 'var(--sea-needs)' : `var(--sea-${family}-${p.slot})`;
    return { ...p, colour };
  });
}

/** A turn in flight is thinking; otherwise the canvas mood, calm when the page claims none. */
export function seaMood({ busy, mood }: { busy: boolean; mood: CanvasMood | null }): SeaMood {
  if (busy) return 'thinking';
  return mood ?? 'calm';
}

export type SeaMotion = 'running' | 'paused' | 'static';

/** Reduced motion: still pools. A hidden tab: paused where they are. */
export function seaMotion({ reducedMotion, hidden }: { reducedMotion: boolean; hidden: boolean }): SeaMotion {
  if (reducedMotion) return 'static';
  return hidden ? 'paused' : 'running';
}
