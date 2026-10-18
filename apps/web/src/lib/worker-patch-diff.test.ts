import { describe, expect, test, mock } from 'bun:test';
let available = true;
let configured = false;
let batchReads = 0;
const values = new Map<string, number>();
mock.module('@/lib/redis', () => ({
  setWithTtl: async (key: string, value: number) => { if (!available) return false; values.set(key, value); return true; },
  isRedisConfigured: () => configured,
  getKeys: async (keys: string[]) => { batchReads++; return available ? keys.map(key => values.get(key) ?? null) : undefined; },
  getKey: async (key: string) => available ? values.get(key) ?? null : undefined,
}));
const { withRecentWorkerHeartbeat, markWorkerHeartbeat, workerHeartbeatAt, withoutRecentWorkerHeartbeat, changedFields, markParkedWorkerSeen, parkedWorkerSeenAt } = await import('./worker-patch-diff');
describe('worker PATCH Redis liveness', () => {
  test('unchanged heartbeats can skip durable writes and readers see the newer beat', async () => {
    const now = new Date('2026-01-01T12:00:00Z');
    expect(await markWorkerHeartbeat('live', now)).toBe(true);
    expect(await workerHeartbeatAt('live', new Date(0))).toEqual(now);
    const candidates = [{ id: 'live' }, { id: 'dead' }];
    expect(await withoutRecentWorkerHeartbeat(candidates, () => now.getTime() - 300_000)).toEqual([{ id: 'dead' }]);
    expect(await withoutRecentWorkerHeartbeat(candidates, () => now.getTime() + 1)).toEqual(candidates);
  });
  test('Redis unavailable preserves database fallback', async () => {
    available = false;
    try {
      expect(await markWorkerHeartbeat('live')).toBe(false);
      const stored = new Date(0);
      expect(await workerHeartbeatAt('live', stored)).toEqual(stored);
      expect(await withoutRecentWorkerHeartbeat([{ id: 'live' }], () => 1)).toEqual([{ id: 'live' }]);
    } finally { available = true; }
  });
});

test('explicit turn counts are changes but automatic increments are bookkeeping', () => {
  expect(changedFields({ turns: 5 }, { turns: 4 })).toEqual(['turns']);
  expect(changedFields({ turns: { getSQL() {} } }, { turns: 4 })).toEqual([]);
});
test('configured Redis outage never confirms a stale candidate as dead', async () => {
  configured = true;
  available = false;
  try { expect(await withoutRecentWorkerHeartbeat([{ id: 'live' }], () => 1)).toEqual([]); }
  finally { configured = false; available = true; }
});

test('parked session beat stays separate from the question expiry clock', async () => {
  const parked = new Date('2026-01-01T12:00:00Z');
  expect(await markParkedWorkerSeen('parked', parked)).toBe(true);
  expect(await parkedWorkerSeenAt('parked', null)).toEqual(parked);
  expect(await workerHeartbeatAt('parked', new Date(0))).toEqual(new Date(0));
  available = false;
  try {
    expect(await markParkedWorkerSeen('parked')).toBe(false);
    expect(await parkedWorkerSeenAt('parked', parked)).toEqual(parked);
  } finally { available = true; }
});

test('candidate liveness is read in one batch regardless of candidate count', async () => {
  batchReads = 0;
  const rows = Array.from({ length: 20 }, (_, i) => ({ id: `candidate-${i}` }));
  expect(await withoutRecentWorkerHeartbeat(rows, () => 1)).toEqual(rows);
  expect(batchReads).toBe(1);
});


test('diff compares JSON, timestamps and numeric columns as Postgres returns them', () => {
  const row = { costUsd: '0.500000', startedAt: new Date('2026-01-01T00:00:00Z'),
    waitingFor: { type: 'question', prompt: 'Continue?' }, localUiUrl: null };
  expect(changedFields({ costUsd: '0.5', startedAt: new Date('2026-01-01T00:00:00Z'),
    waitingFor: { prompt: 'Continue?', type: 'question' }, localUiUrl: undefined, updatedAt: new Date() }, row)).toEqual([]);
  expect(changedFields({ costUsd: '0.6', waitingFor: null }, row)).toEqual(['costUsd', 'waitingFor']);
});

test('atomic field expressions are retained while equal explicit values are omitted', () => {
  const expression = { getSQL() {} };
  expect(changedFields({ instructionHistory: expression, status: 'running', turns: 4 },
    { instructionHistory: [], status: 'running', turns: 4 })).toEqual(['instructionHistory']);
});


test('live candidate readers retain Redis-only activity beyond the durable window', async () => {
  const now = new Date('2026-01-02T12:00:00Z');
  await markWorkerHeartbeat('old-but-live', now);
  const rows = [{ id: 'old-but-live', updatedAt: new Date(0) },
    { id: 'recent', updatedAt: now }, { id: 'gone', updatedAt: new Date(0) }];
  expect(await withRecentWorkerHeartbeat(rows, now.getTime() - 1000)).toEqual(rows.slice(0, 2));
});
