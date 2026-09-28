/**
 * The memory use ledger writer for code running inside a Next.js request.
 *
 * A bare fire-and-forget promise is not guaranteed to finish on Vercel: the
 * function can be frozen as soon as the response is sent. `after()` keeps the
 * invocation alive until the write settles, still without delaying the
 * response. Outside a request scope (a script, a test) `after()` throws, and
 * the write falls back to fire-and-forget.
 */
import { after } from 'next/server';
import { writeMemoryUses, type MemoryLedgerWriter } from '@buildd/core/memory-retrieval';
import { installMemoryRelevanceShadow } from './memory-decisions';

// Every web read path loads this module, so the relevance shadow (log-only
// Jev verdicts on pushed hits, run after the response) is installed here.
installMemoryRelevanceShadow();

export function createAfterResponseMemoryLedger(
  schedule: (task: () => Promise<void>) => void = after,
  write: typeof writeMemoryUses = writeMemoryUses,
): MemoryLedgerWriter {
  return (rows) => {
    if (rows.length === 0) return;
    try {
      schedule(() => write(rows));
    } catch {
      void write(rows);
    }
  };
}

export const afterResponseMemoryLedger: MemoryLedgerWriter = createAfterResponseMemoryLedger();
