import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SEAT_CAP,
  EMPTY_SEAT_GATE,
  OAUTH_BETA,
  SEAT_CAP_REASON,
  SEAT_HOLD_TTL_MS,
  SEAT_WALL_DEFAULT_MS,
  SEAT_WALL_MAX_MS,
  SEAT_WALL_MIN_MS,
  SEAT_WALL_REASON,
  acquireSeat,
  markSeatWall,
  ownerSeatCap,
  ownerSeatEnabled,
  ownerSeatToken,
  releaseSeat,
  wallUntilFromHeaders,
  withOauthBeta,
} from './owner-seat';

const NOW = 1_000_000_000_000;
const h = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });

describe('ownerSeatEnabled', () => {
  test('off when the secret is absent or blank', () => {
    expect(ownerSeatEnabled({})).toBe(false);
    expect(ownerSeatEnabled({ CLAUDE_CODE_OAUTH_TOKEN: '' })).toBe(false);
    expect(ownerSeatEnabled({ CLAUDE_CODE_OAUTH_TOKEN: '   ' })).toBe(false);
  });
  test('on when the secret is present', () => {
    expect(ownerSeatToken({ CLAUDE_CODE_OAUTH_TOKEN: ' tok ' })).toBe('tok');
  });
  test('a managed runner never enables it, even with a secret', () => {
    expect(ownerSeatEnabled({ CLAUDE_CODE_OAUTH_TOKEN: 'tok', MANAGED_CLOUD_RUNNER: '1' })).toBe(false);
  });
});

describe('ownerSeatCap', () => {
  test('defaults to 2', () => {
    expect(ownerSeatCap({})).toBe(DEFAULT_SEAT_CAP);
    expect(DEFAULT_SEAT_CAP).toBe(2);
  });
  test('reads a positive integer, clamped; junk falls back', () => {
    expect(ownerSeatCap({ OWNER_SEAT_MAX_CONCURRENT: '4' })).toBe(4);
    expect(ownerSeatCap({ OWNER_SEAT_MAX_CONCURRENT: '500' })).toBe(20);
    expect(ownerSeatCap({ OWNER_SEAT_MAX_CONCURRENT: '0' })).toBe(2);
    expect(ownerSeatCap({ OWNER_SEAT_MAX_CONCURRENT: 'many' })).toBe(2);
  });
});

describe('seat gate', () => {
  test('grants up to the cap, then defers with owner_seat_cap', () => {
    let s = EMPTY_SEAT_GATE;
    for (const id of ['a', 'b']) {
      const r = acquireSeat(s, id, NOW, 2);
      expect(r.result.granted).toBe(true);
      s = r.state;
    }
    const third = acquireSeat(s, 'c', NOW, 2);
    expect(third.result).toMatchObject({ granted: false, reason: SEAT_CAP_REASON });
  });

  test('acquire is idempotent for a holder and does not use a second slot', () => {
    let s = acquireSeat(EMPTY_SEAT_GATE, 'a', NOW, 2).state;
    s = acquireSeat(s, 'a', NOW, 2).state;
    expect(Object.keys(s.holders)).toEqual(['a']);
  });

  test('release frees the slot', () => {
    let s = acquireSeat(EMPTY_SEAT_GATE, 'a', NOW, 1).state;
    expect(acquireSeat(s, 'b', NOW, 1).result.granted).toBe(false);
    s = releaseSeat(s, 'a', NOW);
    expect(acquireSeat(s, 'b', NOW, 1).result.granted).toBe(true);
  });

  test('a hold that was never released lapses', () => {
    const s = acquireSeat(EMPTY_SEAT_GATE, 'a', NOW, 1).state;
    expect(acquireSeat(s, 'b', NOW + SEAT_HOLD_TTL_MS + 1, 1).result.granted).toBe(true);
  });

  test('a wall pauses new seat runs with owner_seat_wall, and lifts on time', () => {
    const walled = markSeatWall(EMPTY_SEAT_GATE, NOW + 10 * 60 * 1000, NOW);
    const r = acquireSeat(walled, 'a', NOW, 2);
    expect(r.result).toMatchObject({ granted: false, reason: SEAT_WALL_REASON, retryAfterMs: 10 * 60 * 1000 });
    expect(acquireSeat(walled, 'a', NOW + 10 * 60 * 1000 + 1, 2).result.granted).toBe(true);
  });

  test('a wall does not evict a run already holding a slot', () => {
    const held = acquireSeat(EMPTY_SEAT_GATE, 'a', NOW, 2).state;
    const walled = markSeatWall(held, NOW + 600_000, NOW);
    expect(acquireSeat(walled, 'a', NOW, 2).result.granted).toBe(true);
  });

  test('wall length is clamped and never shortened by a later report', () => {
    expect(markSeatWall(EMPTY_SEAT_GATE, NOW, NOW).wallUntil).toBe(NOW + SEAT_WALL_MIN_MS);
    expect(markSeatWall(EMPTY_SEAT_GATE, NOW + 10 * SEAT_WALL_MAX_MS, NOW).wallUntil).toBe(NOW + SEAT_WALL_MAX_MS);
    const long = markSeatWall(EMPTY_SEAT_GATE, NOW + 3_600_000, NOW);
    expect(markSeatWall(long, NOW + 120_000, NOW).wallUntil).toBe(NOW + 3_600_000);
  });
});

describe('wallUntilFromHeaders', () => {
  test('retry-after seconds', () => {
    expect(wallUntilFromHeaders(h({ 'retry-after': '120' }), NOW)).toBe(NOW + 120_000);
  });
  test('retry-after HTTP date', () => {
    const at = new Date(NOW + 5000).toUTCString();
    expect(wallUntilFromHeaders(h({ 'retry-after': at }), NOW)).toBe(Date.parse(at));
  });
  test('unified reset in epoch seconds', () => {
    expect(wallUntilFromHeaders(h({ 'anthropic-ratelimit-unified-reset': String(Math.floor((NOW + 90_000) / 1000)) }), NOW)).toBe(Math.floor((NOW + 90_000) / 1000) * 1000);
  });
  test('no hint: the default', () => {
    expect(wallUntilFromHeaders(h({}), NOW)).toBe(NOW + SEAT_WALL_DEFAULT_MS);
  });
});

describe('withOauthBeta', () => {
  test('adds the flag once and keeps the container betas', () => {
    expect(withOauthBeta(null)).toBe(OAUTH_BETA);
    expect(withOauthBeta('a,b')).toBe(`a,b,${OAUTH_BETA}`);
    expect(withOauthBeta(`a,${OAUTH_BETA}`)).toBe(`a,${OAUTH_BETA}`);
  });
});

import { OwnerSeatRun, type SeatGatePort } from './owner-seat';

function gateFake(cap: number, now: () => number) {
  let state = EMPTY_SEAT_GATE;
  const port: SeatGatePort = {
    acquire: async (id) => { const r = acquireSeat(state, id, now(), cap); state = r.state; return r.result; },
    release: async (id) => { state = releaseSeat(state, id, now()); },
    wall: async (until) => { state = markSeatWall(state, until, now()); },
  };
  return { port, get state() { return state; } };
}

describe('OwnerSeatRun', () => {
  test('a seat run keeps its slot; a metered run gives it back at the first model call', async () => {
    const g = gateFake(1, () => NOW);
    const seat = new OwnerSeatRun({ taskId: 'a', gate: g.port, now: () => NOW });
    const metered = new OwnerSeatRun({ taskId: 'b', gate: g.port, now: () => NOW });
    expect((await seat.acquire()).granted).toBe(true);
    expect((await metered.acquire()).granted).toBe(false);
    await seat.noteRoute(true);
    expect(seat.modelAuth()).toBe('owner_seat');
    expect(Object.keys(g.state.holders)).toEqual(['a']);
    await seat.release();
    expect((await metered.acquire()).granted).toBe(true);
    await metered.noteRoute(false);
    expect(metered.modelAuth()).toBe('metered');
    expect(g.state.holders).toEqual({});
  });

  test('a seat request with no slot (agent restarted) asks for one, and waits when the cap is full', async () => {
    const g = gateFake(1, () => NOW);
    await new OwnerSeatRun({ taskId: 'a', gate: g.port, now: () => NOW }).acquire();
    const late = new OwnerSeatRun({ taskId: 'b', gate: g.port, now: () => NOW });
    expect(await late.noteRoute(true)).toMatchObject({ proceed: false, reason: SEAT_CAP_REASON });
    expect(late.modelAuth()).toBeNull();
  });

  test('a 429 on the seat raises the wall: the next seat run waits with owner_seat_wall', async () => {
    const g = gateFake(2, () => NOW);
    const a = new OwnerSeatRun({ taskId: 'a', gate: g.port, now: () => NOW });
    await a.acquire();
    await a.noteRoute(true);
    await a.noteWall({ retryAfter: '600', reset: null });
    const b = new OwnerSeatRun({ taskId: 'b', gate: g.port, now: () => NOW });
    expect(await b.acquire()).toMatchObject({ granted: false, reason: SEAT_WALL_REASON, retryAfterMs: 600_000 });
    // The run already in flight keeps its slot.
    expect(g.state.holders.a).toBeDefined();
  });

  test('release without a slot is a no-op', async () => {
    const g = gateFake(1, () => NOW);
    await new OwnerSeatRun({ taskId: 'a', gate: g.port, now: () => NOW }).release();
    expect(g.state.holders).toEqual({});
  });
});

describe('the seat token has one reader', () => {
  test('only the model-route resolver reads it; no log, report, state or RPC code touches the secret', async () => {
    const { readdirSync, readFileSync } = await import('fs');
    const { join } = await import('path');
    const dir = import.meta.dir;
    const readers = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => /ownerSeatToken|CLAUDE_CODE_OAUTH_TOKEN|OWNER_SEAT_SECRET/.test(readFileSync(join(dir, f), 'utf8')))
      .sort();
    // owner-seat.ts defines it, outbound.ts injects it, env.ts documents it, deploy-plan.ts names the secret to put.
    expect(readers).toEqual(['deploy-plan.ts', 'env.ts', 'outbound.ts', 'owner-seat.ts']);
    for (const f of ['outbound.ts']) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src).not.toMatch(/console\.\w+\([^)]*(ownerSeatToken|CLAUDE_CODE_OAUTH_TOKEN)/);
    }
  });
});
