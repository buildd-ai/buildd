/**
 * Read-your-writes for list reads (spec 3ef37387 R-20): a write route calls
 * this before it answers, so the change version of the work it noted is
 * bumped first (lib/work-changed.ts `settleWorkChangeVersions`: one SQL lookup
 * and one Upstash pipeline, fail-open, capped). So a caller that creates a
 * task and then lists tasks never gets a list body cached before its write.
 *
 *   export async function POST(req) {
 *     try { ...the handler... } finally { await settleWorkChanges(); }
 *   }
 *
 * The handler stays an exported function, so the structural route checks
 * (uuid guards, dev data gates) still see its body. A namespace read: a route
 * test that mocks lib/work-changed without the settle function settles
 * nothing rather than crashing. Never throws.
 */
import * as workChanged from './work-changed';

export async function settleWorkChanges(): Promise<void> {
  try {
    await (workChanged as Partial<typeof workChanged>).settleWorkChangeVersions?.();
  } catch { /* fail-open: the after() bump and the time bucket still bound it */ }
}
