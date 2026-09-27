/**
 * Where the client keeps buildd's last answer per plan key.
 *
 * In memory by default: on serverless that is per warm instance, so a cold
 * start during a buildd outage goes straight to the fixed defaults. Pass a
 * persistent store (KV, Redis, a DB row) to keep the last good plan across
 * cold starts. Values are small JSON; a store may serialise them.
 */

import type { WirePlan } from './types.js';

export interface StoredPlan {
  /** buildd's answer, verbatim. */
  plan: WirePlan;
  /** Epoch ms when the client received it. */
  receivedAt: number;
}

/**
 * A plan cache. Methods may be sync or async. A store that throws or rejects
 * is treated as a miss (get) or ignored (set): the cache never fails a call.
 */
export interface PlanStore {
  get(key: string): StoredPlan | undefined | null | Promise<StoredPlan | undefined | null>;
  set(key: string, value: StoredPlan): void | Promise<void>;
}

/** The default store: a Map, per process / warm instance. */
export function memoryPlanStore(): PlanStore {
  const map = new Map<string, StoredPlan>();
  return {
    get: (key) => map.get(key),
    set: (key, value) => { map.set(key, value); },
  };
}
