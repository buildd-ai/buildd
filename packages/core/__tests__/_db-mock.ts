/**
 * Shared DB mock for core unit tests.
 *
 * Bun's `mock.module` is process-global: if two test files each register their
 * own '../db' / 'drizzle-orm' mock, the last one loaded wins and silently
 * clobbers the other file's bindings. To stay deterministic, every test file
 * that needs the DB installs THIS identical mock (idempotent — last-wins is a
 * no-op) and drives behaviour per-test through the mutable `dbState`.
 *
 * Not a *.test.ts file, so the runner won't collect it as a suite.
 */
import { mock } from 'bun:test';

/** Per-test knob: what the insert chain's `.returning()` resolves to (or rejects with). */
export const dbState: { returning: () => Promise<any> } = {
  returning: () => Promise.resolve([]),
};

const insertChain: any = {
  values: () => insertChain,
  onConflictDoUpdate: () => insertChain,
  returning: () => dbState.returning(),
  // reset path awaits the chain directly (no .returning()) — make it thenable
  then: (res: any) => res(undefined),
};

export const db = { insert: () => insertChain };

/** Register the shared db/schema/drizzle mocks. Safe to call repeatedly. */
export function installDbMock() {
  mock.module('../db', () => ({ db }));
  mock.module('../db/schema', () => ({
    systemCache: { key: 'key', value: 'value', expiresAt: 'expires_at' },
  }));
  mock.module('drizzle-orm', () => ({
    lt: (a: any, b: any) => ({ a, b, type: 'lt' }),
    sql: (...a: any[]) => ({ _sql: a }),
  }));
}
