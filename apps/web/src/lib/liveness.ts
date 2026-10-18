/**
 * Liveness in Redis, the database as a durable, slightly stale record.
 *
 * The hottest database callers are not pages but pings: a local session's hook
 * touch, an ingest job's lease beat, a runner's heartbeat. Each says "still
 * here" every 30-60 s, and each used to be an UPDATE. Here the beat stamps a
 * Redis key with a TTL, and the database is written only when liveness starts,
 * when it ends, or at most once per LIVENESS_DB_WRITE_INTERVAL_MS per subject.
 *
 * Two rules keep every database reader correct:
 *
 *  1. An expiry column written on a throttled beat is pushed out by the write
 *     interval as well (`dbLeaseUntil`): the next database write is due before
 *     it, so the stored lease never lapses while beats keep arriving, and a
 *     reaper or lease guard reading only the database never reaps a live
 *     subject. A subject that stops beating keeps that row, so it is still
 *     reaped, at most one interval later than before.
 *  2. A "last seen" column read against a window shorter than the interval
 *     (a runner's 3-minute "online now") is read through `readBeats` and
 *     `latestBeat`: the newer of the database value and the Redis stamp.
 *
 * Fail open, everywhere: no Redis, or a Redis error, makes every beat write the
 * database (with the caller's own SQL guard as before) and makes every reader
 * use the database alone. Answers stay correct; only the database load returns.
 */
import * as redis from './redis';

/** At most one database write per subject in this window while it keeps beating. */
export const LIVENESS_DB_WRITE_INTERVAL_MS = 5 * 60 * 1000;

export type LivenessKind = 'session' | 'runner' | 'ingest';

/** The Redis half. `undefined` / `null` / `false` returns mean "could not ask". */
export interface LivenessStore {
  /** Stamp a subject's latest beat. False: not stored. */
  mark(key: string, atMs: number, ttlSec: number): Promise<boolean>;
  /** Latest beat per key (null: none). Undefined: could not ask. */
  read(keys: string[]): Promise<Array<number | null> | undefined>;
  /** SET NX EX. True: this caller writes the database now. False: written this interval. Null: could not ask. */
  claim(key: string, ttlSec: number): Promise<boolean | null>;
  /** Close the gate for a full interval (a start just wrote the database). */
  hold(key: string, ttlSec: number): Promise<void>;
  forget(keys: string[]): Promise<void>;
}

// Namespace import: a test that stubs '@/lib/redis' with a partial module
// leaves these undefined, which reads as "no Redis" and fails open.
const r = redis as Partial<typeof redis>;

export const redisLivenessStore: LivenessStore = {
  async mark(key, atMs, ttlSec) {
    return (await r.setWithTtl?.(key, atMs, ttlSec)) ?? false;
  },
  async read(keys) {
    const vals = await r.getKeys?.<unknown>(keys);
    if (!vals) return undefined;
    return vals.map(v => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null));
  },
  async claim(key, ttlSec) {
    return (await r.tryLock?.(key, ttlSec)) ?? null;
  },
  async hold(key, ttlSec) {
    await r.setWithTtl?.(key, 1, ttlSec);
  },
  async forget(keys) {
    for (const k of keys) await r.delKey?.(k);
  },
};

export const beatKey = (kind: LivenessKind, id: string) => `buildd:live:${kind}:${id}`;
const gateKey = (kind: LivenessKind, id: string) => `buildd:live-db:${kind}:${id}`;
const sec = (ms: number) => Math.max(1, Math.ceil(ms / 1000));
const INTERVAL_SEC = sec(LIVENESS_DB_WRITE_INTERVAL_MS);

export interface LivenessGate {
  /**
   * One "still here" beat. Stamps Redis; true when the caller must also write
   * the database now (gate open, or Redis unavailable).
   */
  beat(kind: LivenessKind, id: string, now: Date, ttlMs: number): Promise<boolean>;
  /** Liveness started and the caller wrote the database: next write is an interval away. */
  started(kind: LivenessKind, id: string, now: Date, ttlMs: number): Promise<void>;
  /** The caller's database write failed: let the next beat try again. */
  writeFailed(kind: LivenessKind, id: string): Promise<void>;
  /** Liveness ended (the database already says so). */
  ended(kind: LivenessKind, id: string): Promise<void>;
  /** Latest Redis beat per id. Null: could not ask (read the database alone). */
  readBeats(kind: LivenessKind, ids: readonly string[]): Promise<Map<string, number> | null>;
}

export function livenessGate(store: LivenessStore = redisLivenessStore): LivenessGate {
  const quiet = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  };
  return {
    async beat(kind, id, now, ttlMs) {
      const marked = await quiet(() => store.mark(beatKey(kind, id), now.getTime(), sec(ttlMs)), false);
      if (!marked) return true;
      return (await quiet(() => store.claim(gateKey(kind, id), INTERVAL_SEC), null)) !== false;
    },
    async started(kind, id, now, ttlMs) {
      if (await quiet(() => store.mark(beatKey(kind, id), now.getTime(), sec(ttlMs)), false)) {
        await quiet(() => store.hold(gateKey(kind, id), INTERVAL_SEC), undefined);
      }
    },
    async writeFailed(kind, id) {
      await quiet(() => store.forget([gateKey(kind, id)]), undefined);
    },
    async ended(kind, id) {
      await quiet(() => store.forget([beatKey(kind, id), gateKey(kind, id)]), undefined);
    },
    async readBeats(kind, ids) {
      if (ids.length === 0) return new Map();
      const vals = await quiet(() => store.read(ids.map(id => beatKey(kind, id))), undefined);
      if (!vals) return null;
      const out = new Map<string, number>();
      ids.forEach((id, i) => {
        const v = vals[i];
        if (typeof v === 'number') out.set(id, v);
      });
      return out;
    },
  };
}

export const liveness = livenessGate();

/**
 * An expiry column written on a throttled beat: the lease plus one write
 * interval, so it outlives the gap until the next database write (rule 1).
 */
export function dbLeaseUntil(now: Date, leaseMs: number): Date {
  return new Date(now.getTime() + leaseMs + LIVENESS_DB_WRITE_INTERVAL_MS);
}

/** The newer of a stored "last seen" and its Redis beat, in the stored value's own type. */
export function latestBeat<T extends Date | string>(stored: T, beatMs: number | undefined): T {
  if (beatMs === undefined) return stored;
  const storedMs = new Date(stored).getTime();
  if (!(beatMs > storedMs)) return stored;
  return (stored instanceof Date ? new Date(beatMs) : new Date(beatMs).toISOString()) as T;
}

/**
 * In-memory store with a clock, for tests: keys expire like Redis's do.
 * `unavailable` mimics no Redis.
 */
export function memoryLivenessStore(clock: () => number, opts: { unavailable?: boolean } = {}) {
  const keys = new Map<string, { value: number; expiresAt: number }>();
  const live = (k: string) => {
    const e = keys.get(k);
    if (e && e.expiresAt <= clock()) keys.delete(k);
    return keys.get(k);
  };
  const store: LivenessStore = {
    async mark(key, atMs, ttlSec) {
      if (opts.unavailable) return false;
      keys.set(key, { value: atMs, expiresAt: clock() + ttlSec * 1000 });
      return true;
    },
    async read(ks) {
      if (opts.unavailable) return undefined;
      return ks.map(k => live(k)?.value ?? null);
    },
    async claim(key, ttlSec) {
      if (opts.unavailable) return null;
      if (live(key)) return false;
      keys.set(key, { value: 1, expiresAt: clock() + ttlSec * 1000 });
      return true;
    },
    async hold(key, ttlSec) {
      if (!opts.unavailable) keys.set(key, { value: 1, expiresAt: clock() + ttlSec * 1000 });
    },
    async forget(ks) {
      for (const k of ks) keys.delete(k);
    },
  };
  return { store, keys };
}
