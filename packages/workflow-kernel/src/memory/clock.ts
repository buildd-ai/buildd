import type { Clock } from '../ports';

export interface ControllableClock extends Clock {
  advance(ms: number): void;
  set(iso: string): void;
  /** Milliseconds since the epoch, for stores that compare times. */
  ms(): number;
}

export function controllableClock(start = '2026-01-01T00:00:00.000Z'): ControllableClock {
  let t = Date.parse(start);
  return {
    now: () => new Date(t).toISOString(),
    ms: () => t,
    advance: (ms) => { t += ms; },
    set: (iso) => { t = Date.parse(iso); },
  };
}

/** `id1`, `id2`, ... : the same run always allocates the same ids. */
export function sequentialIds(prefix = 'id'): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}
