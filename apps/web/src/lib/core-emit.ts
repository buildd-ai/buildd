/**
 * `emit()`: fan a core event out to the module subscribers the composition
 * root (`apps/web/src/modules.ts`) lists. Contract and semantics:
 * `lib/core-events.ts`.
 */
import { reportOps } from '@buildd/core/report-ops';
import { SUBSCRIBERS } from '@/modules';
import type { AnySubscriber, CoreEvent, CoreEventType } from './core-events';

/** Runs one subscriber with its own try/catch. */
export type Isolate = (label: string, fn: () => Promise<void>) => Promise<void>;

function defaultIsolate(type: CoreEventType): Isolate {
  return async (label, fn) => {
    try {
      await fn();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[core-event ${type}] ${label} failed:`, err);
      void reportOps({ source: `core-event:${label}`, severity: 'error', message: `${label} failed`, detail });
    }
  };
}

export interface EmitOptions {
  /**
   * The caller's own isolation wrapper, when it already pages failures under
   * a source of its own (the worker PATCH's `runStep`). Defaults to try/catch,
   * log, and `reportOps({ source: 'core-event:<label>' })`.
   */
  isolate?: Isolate;
  /** Override the composition root's list (tests). */
  subscribers?: readonly AnySubscriber[];
}

/** Fan an event out to its subscribers, in order, each isolated. Never throws. */
export async function emit(event: CoreEvent, opts: EmitOptions = {}): Promise<void> {
  const isolate = opts.isolate ?? defaultIsolate(event.type);
  for (const s of opts.subscribers ?? SUBSCRIBERS) {
    if (s.on !== event.type) continue;
    try {
      await isolate(s.label, async () => { await (s.run as (e: CoreEvent) => Promise<void> | void)(event); });
    } catch (err) {
      // A caller's isolate that itself throws must not stop the fan-out.
      console.error(`[core-event ${event.type}] isolate for ${s.label} threw:`, err);
    }
  }
}
