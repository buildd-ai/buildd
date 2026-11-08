import type { Marker, RawTask } from './types';

/** The marker source: full context first, then the page's digest. */
export function markerOf(t: RawTask): Marker | null {
  return t.context ?? t.contextDigest ?? null;
}
