/**
 * Runtime overrides for policy thresholds and default role text.
 *
 * The values in this repo are working public defaults. A hosted deployment can
 * replace any of them at runtime with one private record: the `system_cache` row
 * keyed `policy_overrides` (see `policy-overrides-source.ts`, which loads it).
 * Nothing about the override is committed — the record is written to the
 * deployment's database by an operator, out of band.
 *
 * Record shape (all fields optional):
 *
 *   {
 *     "values": { "<PolicyKey>": <integer>, ... },
 *     "roles":  { "<role slug>": { "content"?, "description"?, "version"?, "supersededContentHashes"? } }
 *   }
 *
 * A missing record, a missing key, or an invalid value resolves to the default
 * below, and anything invalid is logged. This module is pure and client-safe
 * (auto-merge-grace.ts is client-bundled): it holds the defaults, the validator
 * and an in-process snapshot. Only the server installs a snapshot, so a client
 * bundle always sees the defaults.
 */

/** Public defaults. Every overridable threshold is listed here and only here. */
export const POLICY_DEFAULTS = {
  /** pr-landing: a refreshed head lands if the base gained at most this many commits since. */
  treadmillMaxBaseCommits: 3,
  /** pr-landing: refreshes per landing cycle before a person is asked. */
  treadmillMaxRefreshes: 3,
  /** conflict-retry: conflict-resolution attempts per PR before escalating. */
  maxConflictIterations: 3,
  /** auto-merge-grace: how long a `ci_green` PR stays the platform's before it counts as held. */
  autoMergeGreenGraceMs: 5 * 60_000,
  /** ci-retry: CI fix attempts per PR when the workspace sets no gitConfig.maxCiRetries. */
  maxCiRetries: 3,
} as const;

export type PolicyKey = keyof typeof POLICY_DEFAULTS;

/** Accepted range per key. Values must be integers within [min, max]. */
const POLICY_BOUNDS: Record<PolicyKey, { min: number; max: number }> = {
  treadmillMaxBaseCommits: { min: 0, max: 1_000 },
  treadmillMaxRefreshes: { min: 0, max: 100 },
  maxConflictIterations: { min: 0, max: 100 },
  autoMergeGreenGraceMs: { min: 0, max: 24 * 60 * 60_000 },
  maxCiRetries: { min: 0, max: 100 },
};

export interface RoleOverride {
  content?: string;
  description?: string;
  /** Raises the role's version so a resync reaches existing unedited rows. */
  version?: number;
  /** Extra hashes of earlier content a resync may overwrite (added to the public list). */
  supersededContentHashes?: string[];
}

export interface PolicyOverrides {
  values: Partial<Record<PolicyKey, number>>;
  roles: Record<string, RoleOverride>;
}

export const EMPTY_POLICY_OVERRIDES: PolicyOverrides = Object.freeze({ values: {}, roles: {} }) as PolicyOverrides;

type Log = (message: string) => void;
const defaultLog: Log = (m) => console.warn(`[policy-overrides] ${m}`);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Validate a raw override record. Never throws: anything that does not fit is
 * dropped with a log line, so the affected value falls back to its default.
 * Logs name the key and the reason, never the rejected value.
 */
export function parsePolicyOverrides(raw: unknown, log: Log = defaultLog): PolicyOverrides {
  if (raw === null || raw === undefined) return EMPTY_POLICY_OVERRIDES;
  if (!isPlainObject(raw)) {
    log('record is not an object; using defaults');
    return EMPTY_POLICY_OVERRIDES;
  }

  const values: Partial<Record<PolicyKey, number>> = {};
  if (raw.values !== undefined) {
    if (!isPlainObject(raw.values)) {
      log('"values" is not an object; using default thresholds');
    } else {
      for (const [key, value] of Object.entries(raw.values)) {
        if (!(key in POLICY_DEFAULTS)) {
          log(`unknown threshold "${key}" ignored`);
          continue;
        }
        const k = key as PolicyKey;
        const { min, max } = POLICY_BOUNDS[k];
        if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
          log(`invalid value for "${k}" (want an integer in [${min}, ${max}]); using default`);
          continue;
        }
        values[k] = value;
      }
    }
  }

  const roles: Record<string, RoleOverride> = {};
  if (raw.roles !== undefined) {
    if (!isPlainObject(raw.roles)) {
      log('"roles" is not an object; using default role text');
    } else {
      for (const [slug, entry] of Object.entries(raw.roles)) {
        if (!isPlainObject(entry)) {
          log(`role "${slug}" override is not an object; ignored`);
          continue;
        }
        const out: RoleOverride = {};
        for (const field of ['content', 'description'] as const) {
          const v = entry[field];
          if (v === undefined) continue;
          if (typeof v !== 'string' || v.trim() === '') log(`role "${slug}" ${field} must be a non-empty string; using default`);
          else out[field] = v;
        }
        if (entry.version !== undefined) {
          if (typeof entry.version !== 'number' || !Number.isInteger(entry.version) || entry.version < 1) log(`role "${slug}" version must be a positive integer; ignored`);
          else out.version = entry.version;
        }
        if (entry.supersededContentHashes !== undefined) {
          const h = entry.supersededContentHashes;
          if (!Array.isArray(h) || !h.every(x => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x))) log(`role "${slug}" supersededContentHashes must be sha256 hex strings; ignored`);
          else out.supersededContentHashes = h as string[];
        }
        if (Object.keys(out).length > 0) roles[slug] = out;
      }
    }
  }

  return { values, roles };
}

// ── In-process snapshot ────────────────────────────────────────────────────────

let snapshot: PolicyOverrides = EMPTY_POLICY_OVERRIDES;
let refresher: (() => void) | null = null;

/** Replace the active overrides. Called by the server loader; tests may call it directly. */
export function installPolicyOverrides(overrides: PolicyOverrides): void {
  snapshot = overrides;
}

/** The overrides currently in effect (empty until the server has loaded a record). */
export function currentPolicyOverrides(): PolicyOverrides {
  return snapshot;
}

/**
 * Register a callback the sync getters poke on every read, so a server process
 * picks up a changed record without each call site awaiting a load. The server
 * loader registers itself and rate-limits the actual reads.
 */
export function setPolicyRefresher(fn: (() => void) | null): void {
  refresher = fn;
}

/** Back to defaults with no refresher. For tests. */
export function resetPolicyOverrides(): void {
  snapshot = EMPTY_POLICY_OVERRIDES;
  refresher = null;
}

/** THE read path for a threshold: the installed override, else the public default. */
export function policyValue(key: PolicyKey): number {
  refresher?.();
  return snapshot.values[key] ?? POLICY_DEFAULTS[key];
}
