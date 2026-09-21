/**
 * Route-side convenience over `recordSessionTerminal`.
 *
 * The writer lives in `@buildd/core/terminal-records` (the runner and other
 * core helpers may eventually record terminal outcomes too). This file is
 * fire-and-forget only — nothing here returns a value the request path uses,
 * and nothing rejects. Mirrors `gate-ledger.ts`'s `fireGateEvent` on purpose.
 */
import { recordSessionTerminal, type RecordSessionTerminalInput } from '@buildd/core/terminal-records';

export { TERMINAL_OUTCOMES, type TerminalOutcome } from '@buildd/core/terminal-records';

/**
 * Record a session terminal outcome without awaiting it.
 *
 * `recordSessionTerminal` already swallows its own errors; the extra `.catch`
 * is for the pathological case where the module itself throws synchronously,
 * which would otherwise surface as an unhandled rejection in the route.
 */
export function fireTerminalRecord(input: RecordSessionTerminalInput): void {
  void recordSessionTerminal(input).catch(() => {});
}
