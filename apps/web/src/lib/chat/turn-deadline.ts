/**
 * A chat turn's wall clock (knowledge-base: buildd/design/agent-chat.md → The limits on each turn).
 *
 * Three pieces, all measured from when the turn started (the request), not
 * from when the model call started, so routing, limits and the docked-object
 * reads count against the same budget the route's `maxDuration` bounds:
 *
 * 1. **Wrap-up** (`TURN_WRAP_UP_MS`): after this, a new step may not call a
 *    tool and is told to answer with what it has. A slow reasoning model used
 *    to spend the whole budget calling tools and was cut off mid-thought with
 *    no answer at all.
 * 2. **Deadline** (`TURN_BUDGET_MS`): the model call's abort signal.
 * 3. **Watchdog** (`TURN_WATCHDOG_GRACE_MS` past the deadline): the abort
 *    signal only works if whatever is running honours it. A tool that ignores
 *    it, or a provider stream that never closes, kept the turn open until the
 *    platform killed the function, and then nothing was saved and the person
 *    saw a reply that simply stopped. The watchdog ends the stream itself.
 *
 * Whatever ends a turn early, the person sees `TURN_STOPPED_NOTE` in the
 * stream (`withStoppedNote`), the same words saved on the message.
 */
import type { UIMessageChunk } from 'ai';

/** The whole turn, from the request. The route's maxDuration must cover this plus the grace and persistence. */
export const TURN_BUDGET_MS = 120_000;
/** After this, no new tool calls: the next step answers. */
export const TURN_WRAP_UP_MS = 85_000;
/** How long past the deadline a stream that ignored the abort may stay open. */
export const TURN_WATCHDOG_GRACE_MS = 5_000;
/** How long persistence waits for usage numbers a stopped stream may never report. */
export const USAGE_SETTLE_MS = 2_000;

export const TURN_STOPPED_NOTE = '_Stopped: this turn hit its time limit before it finished. Ask again to pick up from here, or narrow the question._';
export const WRAP_UP_INSTRUCTION = 'Time for this turn is nearly up. Do not call any more tools. Answer now with what you already have, and say plainly what you could not check.';

export interface TurnTiming {
  budgetMs: number;
  wrapUpMs: number;
  graceMs: number;
}

export const DEFAULT_TURN_TIMING: TurnTiming = {
  budgetMs: TURN_BUDGET_MS,
  wrapUpMs: TURN_WRAP_UP_MS,
  graceMs: TURN_WATCHDOG_GRACE_MS,
};

/**
 * `prepareStep` for the wrap-up: past `wrapUpMs`, a step after the first gets
 * no tools and the wrap-up instruction. Returns undefined otherwise.
 */
export function wrapUpStep(opts: {
  stepNumber: number;
  elapsedMs: number;
  wrapUpMs: number;
  instructions: string;
}): { toolChoice: 'none'; instructions: string } | undefined {
  if (opts.stepNumber === 0 || opts.elapsedMs < opts.wrapUpMs) return undefined;
  return { toolChoice: 'none', instructions: `${opts.instructions}\n\n${WRAP_UP_INSTRUCTION}` };
}

/**
 * Ends `source` at `hardStopAt` (epoch ms) if it hasn't ended by then: an
 * `abort` part, then close, so the UI stream's onEnd still runs and saves the
 * turn. `onFire` is called once when that happens.
 */
export function withDeadlineWatchdog<T>(
  source: ReadableStream<T>,
  hardStopAt: number,
  onFire: () => void,
  now: () => number = Date.now,
): ReadableStream<T> {
  const reader = source.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fired = false;
  const expiry = new Promise<'expired'>(resolve => {
    timer = setTimeout(() => resolve('expired'), Math.max(0, hardStopAt - now()));
  });
  return new ReadableStream<T>({
    async pull(controller) {
      const next = await Promise.race([reader.read(), expiry]);
      if (next === 'expired') {
        if (!fired) {
          fired = true;
          onFire();
          controller.enqueue({ type: 'abort', reason: 'turn deadline watchdog' } as T);
        }
        controller.close();
        // Never awaited: a source that ignored the abort may ignore this too.
        reader.cancel('turn deadline watchdog').catch(() => {});
        return;
      }
      if (next.done) {
        clearTimeout(timer);
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
    cancel(reason) {
      clearTimeout(timer);
      return reader.cancel(reason).catch(() => {});
    },
  });
}

/** Before an `abort` chunk, the stopped note as a text part, so the person sees why the reply ended. */
export function withStoppedNote<C extends UIMessageChunk>(stream: ReadableStream<C>, note: string = TURN_STOPPED_NOTE): ReadableStream<C> {
  let noted = false;
  return stream.pipeThrough(new TransformStream<C, C>({
    transform(chunk, controller) {
      if ((chunk as { type?: string }).type === 'abort' && !noted) {
        noted = true;
        const id = 'turn-stopped';
        controller.enqueue({ type: 'text-start', id } as C);
        controller.enqueue({ type: 'text-delta', id, delta: note } as C);
        controller.enqueue({ type: 'text-end', id } as C);
      }
      controller.enqueue(chunk);
    },
  }));
}

/** `p`'s value, or undefined if it hasn't settled (or failed) within `ms`. */
export async function settleWithin<T>(p: PromiseLike<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(p).catch(() => undefined),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
