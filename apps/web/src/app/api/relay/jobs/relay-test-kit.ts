/**
 * Shared mocks for the three relay route tests. Each test file runs in its own
 * process (scripts/run-unit-tests.ts), so these module mocks never leak.
 */
import { mock } from 'bun:test';
import { randomUUID } from 'crypto';
import { NextRequest } from 'next/server';

// Fresh ids per process: nothing here names a real row.
export const TEAM = randomUUID();
export const RUNNER = randomUUID();
export const OTHER_RUNNER = randomUUID();
export const JOB = randomUUID();

export interface RelayKit {
  account: { id: string; teamId: string; level: string } | null;
  /** The heartbeat rows the calling account owns; empty = the runnerId sent is someone else's. */
  ownRunnerIds: string[];
  pick: Record<string, unknown> | null;
  calls: Array<{ fn: string; args: unknown[] }>;
  claim: (input: any) => Promise<unknown[]>;
  complete: (input: any) => Promise<unknown>;
  progress: (input: any) => Promise<boolean>;
  job: Record<string, unknown> | null;
  sweep: () => Promise<unknown>;
}

export function installRelayMocks(): RelayKit {
  const kit: RelayKit = {
    account: { id: 'acc-1', teamId: TEAM, level: 'worker' },
    ownRunnerIds: [RUNNER],
    pick: { teamId: TEAM, runnerId: RUNNER, chatModel: 'llama3.1:8b', embeddingModel: 'nomic-embed-text', chatAssigned: true, runner: null },
    calls: [],
    claim: async () => [],
    complete: async () => ({ outcome: 'done' }),
    progress: async () => true,
    job: null,
    sweep: async () => ({ expired: 0, requeued: 0, lost: 0, pruned: 0 }),
  };
  const record = <T,>(fn: string, impl: (...args: any[]) => T) => (...args: any[]) => {
    kit.calls.push({ fn, args });
    return impl(...args);
  };

  mock.module('@/lib/api-auth', () => ({ authenticateApiKey: async () => kit.account }));
  mock.module('@buildd/core/db', () => ({
    db: {
      query: {
        workerHeartbeats: {
          // The route's WHERE is (id, accountId): a row only when the account owns that runner.
          findFirst: async () => (kit.ownRunnerIds.length > 0 ? { id: kit.ownRunnerIds[0] } : undefined),
        },
      },
    },
  }));
  mock.module('@buildd/core/model-relay', () => ({
    relayLeaseOwner: (runnerId: string, leaseId: string) => `${runnerId}:${leaseId}`,
    loadLocalRunnerPick: record('loadLocalRunnerPick', async () => kit.pick),
    pickUsesRelay: (p: any) => !!p && !!p.runnerId && (p.embeddingModel !== null || (p.chatAssigned && p.chatModel !== null)),
    sweepRelayJobs: record('sweepRelayJobs', () => kit.sweep()),
    claimRelayJobs: record('claimRelayJobs', (input: any) => kit.claim(input)),
    completeRelayJob: record('completeRelayJob', (input: any) => kit.complete(input)),
    progressRelayJob: record('progressRelayJob', (input: any) => kit.progress(input)),
    getRelayJob: record('getRelayJob', async () => kit.job),
  }));
  return kit;
}

export function post(path: string, body: unknown, bearer = 'bld_key'): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
