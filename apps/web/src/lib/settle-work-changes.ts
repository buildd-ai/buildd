/**
 * Read-your-writes for list reads (spec 3ef37387 R-20): a write route wrapped
 * in this answers only after the change version of the work it noted is
 * bumped (lib/work-changed.ts `settleWorkChangeVersions`: one SQL lookup and
 * one Upstash pipeline, fail-open, capped). So a caller that creates a task
 * and then lists tasks never gets the list body cached before its write.
 *
 *   export const POST = settlesWorkChanges(createTask);
 *
 * A namespace read: a route test that mocks lib/work-changed without the
 * settle function settles nothing rather than crashing.
 */
import * as workChanged from './work-changed';

export function settlesWorkChanges<A extends unknown[], R>(handler: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A) => {
    try {
      return await handler(...args);
    } finally {
      await (workChanged as Partial<typeof workChanged>).settleWorkChangeVersions?.();
    }
  };
}
