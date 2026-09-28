/**
 * `@builddai/ai-kit/surfaces`: Jev picks which of the app's own chips and cards
 * to show, and in what order (server; builds on `/decide`).
 *
 * P0 SKELETON: types only. `defineSurface` ships in P7.
 *
 * Safety property: the output space is closed. Jev returns only candidate ids
 * and labels the app registered; chip text, card props and URLs come from app
 * code. A low-confidence answer, a timeout or shadow mode renders `default`.
 */

import type { DecisionMode } from '@builddai/ai-kit/decide';

export interface SurfaceCandidate {
  id: string;
}

export type SurfaceSlot<C extends SurfaceCandidate = SurfaceCandidate> =
  /** One `score` question per candidate; the top `max` above the threshold, then `default`. */
  | { type: 'rank'; candidates: readonly C[]; max: number; default: readonly string[] }
  /** One `choice` question over registered labels. */
  | { type: 'choice'; labels: readonly string[]; default: string };

export interface SurfaceDefinition<Ctx = unknown> {
  id: string;
  slots: Record<string, SurfaceSlot>;
  /** The app decides what Jev sees. */
  state: (ctx: Ctx) => Promise<unknown> | unknown;
  decision: { mode: DecisionMode; minConfidence: number };
}

/** What a surface resolves to: ids per slot, always from the registered set. */
export type SurfacePick = Record<string, readonly string[] | string>;
