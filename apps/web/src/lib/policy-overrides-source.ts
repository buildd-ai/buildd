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
import { createSnapshotLoader, type LoadOptions } from '@buildd/core/runtime-snapshot';
import { eq } from 'drizzle-orm';
import { parsePolicyOverrides, policyOverridesSnapshot, type PolicyOverrides } from './policy-overrides';

export const POLICY_OVERRIDES_KEY = 'policy_overrides';
export const POLICY_OVERRIDES_TTL_MS = 60_000;

async function readRecordFromDb(): Promise<unknown | undefined> {
  const [row] = await db
    .select({ value: systemCache.value })
    .from(systemCache)
    .where(eq(systemCache.key, POLICY_OVERRIDES_KEY))
    .limit(1);
  return row?.value;
}

const loader = createSnapshotLoader<PolicyOverrides>({
  name: 'policy-overrides',
  ttlMs: POLICY_OVERRIDES_TTL_MS,
  snapshot: policyOverridesSnapshot,
  read: readRecordFromDb,
  parse: raw => parsePolicyOverrides(raw),
  missingMessage: `no "${POLICY_OVERRIDES_KEY}" record; using public defaults`,
});

/**
 * Load (or reuse, within the TTL) the override record and install it.
 * Never throws. `read` and `now` are injectable for tests.
 */
export function loadPolicyOverrides(opts: LoadOptions = {}): Promise<PolicyOverrides> {
  return loader.load(opts);
}

/** Forget the TTL and the missing-record log state. For tests. */
export function resetPolicyOverridesLoader(): void {
  loader.reset();
}

/**
 * Load the record now and keep the sync getters fresh from here on: a read past
 * the TTL starts a background reload (itself rate-limited above). Called once
 * per server process from instrumentation.ts; never from tests or the client.
 */
export function startPolicyOverrides(): Promise<void> {
  return loader.start();
}
