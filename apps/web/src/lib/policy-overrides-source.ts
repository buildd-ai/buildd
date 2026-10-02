/**
 * Server-side loader for the private policy-overrides record (format and
 * semantics: `policy-overrides.ts`). The record is one `system_cache` row,
 * key `policy_overrides`, with no `expiresAt`: a system-level config row, not a
 * new table and not a credential, so it stays out of `secrets` (whose rows are
 * team-scoped and whose purposes are credentials — docs/credentials-architecture.md).
 *
 * Read at most once per `POLICY_OVERRIDES_TTL_MS` per process. A failed read
 * keeps whatever was installed before (defaults on a cold process) and logs.
 */
import { db } from '@buildd/core/db';
import { systemCache } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import {
  installPolicyOverrides,
  currentPolicyOverrides,
  parsePolicyOverrides,
  setPolicyRefresher,
  type PolicyOverrides,
} from './policy-overrides';

export const POLICY_OVERRIDES_KEY = 'policy_overrides';
export const POLICY_OVERRIDES_TTL_MS = 60_000;

type ReadRecord = () => Promise<unknown | undefined>;

async function readRecordFromDb(): Promise<unknown | undefined> {
  const [row] = await db
    .select({ value: systemCache.value })
    .from(systemCache)
    .where(eq(systemCache.key, POLICY_OVERRIDES_KEY))
    .limit(1);
  return row?.value;
}

let lastLoadAt = 0;
let inflight: Promise<PolicyOverrides> | null = null;
let loggedMissing = false;

/**
 * Load (or reuse, within the TTL) the override record and install it.
 * Never throws. `read` and `now` are injectable for tests.
 */
export function loadPolicyOverrides(opts: { force?: boolean; read?: ReadRecord; now?: () => number } = {}): Promise<PolicyOverrides> {
  const now = opts.now ?? Date.now;
  if (!opts.force && lastLoadAt > 0 && now() - lastLoadAt < POLICY_OVERRIDES_TTL_MS) {
    return Promise.resolve(currentPolicyOverrides());
  }
  if (inflight && !opts.force) return inflight;

  // Stamp before reading, so a burst of stale reads triggers one query.
  lastLoadAt = now();
  const read = opts.read ?? readRecordFromDb;
  const run = (async () => {
    try {
      const raw = await read();
      if (raw === undefined || raw === null) {
        if (!loggedMissing) {
          console.info(`[policy-overrides] no "${POLICY_OVERRIDES_KEY}" record; using public defaults`);
          loggedMissing = true;
        }
        installPolicyOverrides(parsePolicyOverrides(null));
      } else {
        loggedMissing = false;
        installPolicyOverrides(parsePolicyOverrides(raw));
      }
    } catch (err) {
      console.warn(
        '[policy-overrides] could not read the override record; keeping the values in effect:',
        err instanceof Error ? err.message : err,
      );
    }
    return currentPolicyOverrides();
  })();
  inflight = run;
  return run.finally(() => {
    if (inflight === run) inflight = null;
  });
}

/** Forget the TTL and the missing-record log state. For tests. */
export function resetPolicyOverridesLoader(): void {
  lastLoadAt = 0;
  inflight = null;
  loggedMissing = false;
}

/**
 * Load the record now and keep the sync getters fresh from here on: a read past
 * the TTL starts a background reload (itself rate-limited above). Called once
 * per server process from instrumentation.ts; never from tests or the client.
 */
export async function startPolicyOverrides(): Promise<void> {
  setPolicyRefresher(() => {
    if (lastLoadAt > 0 && Date.now() - lastLoadAt < POLICY_OVERRIDES_TTL_MS) return;
    void loadPolicyOverrides();
  });
  await loadPolicyOverrides({ force: true });
}
