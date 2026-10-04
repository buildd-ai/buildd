/**
 * Bulk-read monitor for role and skill bodies.
 *
 * Role and skill text reaches agents on customer machines, so it cannot be
 * secret; the aim is that nobody extracts it casually. The signal for that is
 * one caller (an API key, or an OAuth token's account) reading many DIFFERENT
 * bodies in a short window. A runner claiming tasks reads the same handful of
 * roles and skills over and over, so its distinct count stays small however
 * busy it is.
 *
 * Every surface that hands out a body reports it here (`noteBodyReads`): the
 * workspace skills list and single-skill reads (which MCP `get_skill` goes
 * through), and claim-time role/skill delivery, including the role bundle's
 * presigned download URL. Per caller, distinct bodies are counted over
 * `BODY_READ_WINDOW_SEC`:
 *
 * - at `BODY_READ_ALERT_THRESHOLD` the platform operator is alerted once per
 *   window and a `[body-read]` line is logged (caller id and counts, never
 *   text or body ids);
 * - at `BODY_READ_LIMIT` an API read is refused (the route answers 429).
 *   Claim delivery is never refused: it is counted and alerted on only, so a
 *   runner never fails a claim because of this.
 *
 * Redis holds the window when configured, so it spans instances; otherwise a
 * per-instance map bounds a single hot loop. Fails open: a counting error
 * allows the read.
 */
import { notifyOperator } from './pushover';
import { isRedisConfigured, setOnce, windowMembersAdd } from './redis';

/** The window distinct bodies are counted over. */
export const BODY_READ_WINDOW_SEC = 15 * 60;
/** Distinct bodies per caller per window at which the operator is alerted. */
export const BODY_READ_ALERT_THRESHOLD = 40;
/** Distinct bodies per caller per window past which an API read is refused. */
export const BODY_READ_LIMIT = 120;

export type BodyReadSurface = 'skills_list' | 'skill_get' | 'claim_role' | 'claim_role_bundle' | 'claim_skills';

export interface BodyReadVerdict {
  /** False only for an API read past `BODY_READ_LIMIT`. */
  allowed: boolean;
  /** Distinct bodies this caller read in the window, this read included. Null when uncounted. */
  distinct: number | null;
}

const local = new Map<string, Map<string, number>>();
const LOCAL_MAX_CALLERS = 5_000;
const localAlerted = new Map<string, number>();

/** Test hook. */
export function resetBodyReadMonitor(): void {
  local.clear();
  localAlerted.clear();
}

function countLocally(callerId: string, bodies: readonly string[], nowMs: number): number {
  let seen = local.get(callerId);
  if (!seen) {
    if (local.size >= LOCAL_MAX_CALLERS) local.clear();
    seen = new Map();
    local.set(callerId, seen);
  }
  const expires = nowMs + BODY_READ_WINDOW_SEC * 1000;
  for (const [id, exp] of seen) if (exp <= nowMs) seen.delete(id);
  for (const id of bodies) seen.set(id, expires);
  return seen.size;
}

async function alertOnce(callerId: string, distinct: number, surface: BodyReadSurface, nowMs: number): Promise<void> {
  if (isRedisConfigured()) {
    // First instance to cross the line in this window alerts; the rest stay quiet.
    if (!(await setOnce(`buildd:body-read-alerted:${callerId}`, BODY_READ_WINDOW_SEC))) return;
  } else {
    const prev = localAlerted.get(callerId);
    if (prev !== undefined && nowMs - prev < BODY_READ_WINDOW_SEC * 1000) return;
    if (localAlerted.size >= LOCAL_MAX_CALLERS) localAlerted.clear();
    localAlerted.set(callerId, nowMs);
  }
  const minutes = BODY_READ_WINDOW_SEC / 60;
  console.warn(`[body-read] caller ${callerId} read ${distinct} distinct role/skill bodies in ${minutes}m (surface: ${surface}; alert at ${BODY_READ_ALERT_THRESHOLD}, refuse at ${BODY_READ_LIMIT})`);
  notifyOperator({
    app: 'alerts',
    title: 'Bulk role/skill body reads',
    message: `Caller ${callerId} read ${distinct} distinct role/skill bodies in ${minutes} minutes (via ${surface}).`,
    priority: 0,
  });
}

/**
 * Record that `callerId` was handed these bodies (row ids; repeats are free)
 * and say whether the read may go ahead. `enforce: false` (claim delivery)
 * counts and alerts but always allows.
 */
export async function noteBodyReads(
  callerId: string | null | undefined,
  bodyIds: readonly string[],
  surface: BodyReadSurface,
  opts: { enforce?: boolean; nowMs?: number } = {},
): Promise<BodyReadVerdict> {
  if (!callerId || bodyIds.length === 0) return { allowed: true, distinct: null };
  const nowMs = opts.nowMs ?? Date.now();
  const enforce = opts.enforce ?? true;
  try {
    const unique = [...new Set(bodyIds)];
    const remote = await windowMembersAdd(
      `buildd:body-reads:${callerId}`,
      unique,
      nowMs + BODY_READ_WINDOW_SEC * 1000,
      BODY_READ_WINDOW_SEC,
      nowMs,
    );
    const distinct = remote ?? countLocally(callerId, unique, nowMs);
    if (distinct >= BODY_READ_ALERT_THRESHOLD) await alertOnce(callerId, distinct, surface, nowMs);
    const allowed = !enforce || distinct <= BODY_READ_LIMIT;
    if (!allowed) console.warn(`[body-read] refused ${surface} for caller ${callerId}: ${distinct} distinct bodies in window`);
    return { allowed, distinct };
  } catch {
    return { allowed: true, distinct: null };
  }
}

/** The 429 a route answers for a refused read. */
export function bodyReadRefused(): Response {
  return Response.json(
    { error: 'Too many distinct role or skill bodies read in a short window. Try again later.' },
    { status: 429, headers: { 'Retry-After': String(BODY_READ_WINDOW_SEC) } },
  );
}
