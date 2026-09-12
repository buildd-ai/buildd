/**
 * The database half of the memory-digest readout: three plain selects, and the
 * mapping from stored rows onto the analysis units in `memory-digest-readout.ts`.
 *
 * Kept separate from the arithmetic on purpose. Mocking `db` makes every WHERE
 * predicate in a file unobservable — the predicate builders return opaque
 * objects and nothing asserts which column they were keyed on — so a test that
 * mocks the client can prove an aggregation is correct while the aggregation
 * runs over the wrong cohort. Splitting the module means the arithmetic is
 * tested against literal rows with no mock at all, and the cohort filters are
 * tested by rendering them to SQL text through `PgDialect`, which is the only
 * way to see the column a predicate actually names.
 *
 * Three queries rather than one join:
 *
 *  1. every prompt build for the policy version,
 *  2. the worker sessions belonging to those tasks.
 *
 * There is deliberately no third query for `recall` usage.
 * `worker_action_events` records the bare action name off the `buildd` MCP
 * call and `recall` is a separate top-level tool, so it has never appeared in
 * that table: a scope filtering `action = 'recall'` returns zero rows for
 * every session in both arms, for ever, and renders as a measured 0% rather
 * than as a metric that cannot see. It is read off the session's own tool
 * histogram instead, where it is actually recorded.
 *
 * A single grouped query would push the era split, the straddle exclusion and
 * the per-task rollup into SQL, where none of it is testable without a live
 * cohort — and the era split is the one thing in this readout that must never
 * be wrong. The row volume is one row per prompt build, so the cost of doing
 * the join in memory is not a consideration.
 */

import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from './db';
import { systemCache, workerPromptCompositionEvents, workers } from './db/schema';
import {
  DEFAULT_BACKEND,
  computeReadout,
  type CompositionRow,
  type MemoryDigestArm,
  type Readout,
  type ReadoutOptions,
  type SessionRow,
} from './memory-digest-readout';

/**
 * The tool name `recall` is counted under in `resultMeta.toolCounts`.
 *
 * The fully-qualified MCP tool name, because that is what the histogram keys
 * on. A bare `'recall'` matches nothing.
 */
export const RECALL_TOOL = 'mcp__buildd__recall';

/**
 * Cohort filter for the prompt-build rows.
 *
 * `policy_version` is the one predicate that must never be missing: a version
 * bump redefines what the arms mean and re-randomises assignment, so pooling
 * two versions is not a slightly noisier comparison, it is a meaningless one.
 * The `(policy_version, arm)` index makes this a lookup rather than a scan.
 *
 * `task_id IS NOT NULL` because a build with no task cannot be attributed to a
 * randomisation unit — it is not a smaller observation, it is no observation.
 *
 * Backend segmentation is deliberately NOT here. Filtering it in SQL would make
 * the excluded rows invisible, and "how many rows did we drop for having no
 * backend recorded" is a number worth seeing: it is the difference between a
 * clean single-backend cohort and one quietly missing most of the fleet.
 */
export function compositionCohortScope(policyVersion: string) {
  return and(
    eq(workerPromptCompositionEvents.policyVersion, policyVersion),
    isNotNull(workerPromptCompositionEvents.taskId),
  );
}

/**
 * Scope for the worker sessions of cohort tasks.
 *
 * `started_at IS NOT NULL` drops never-started workers. Those rows are a
 * bookkeeping artifact of over-claim — a row minted at claim that no runner
 * ever picked up — and the schema says as much. Counting them would add a task
 * with zero turns, zero reads and no duration to whichever arm it fell in, and
 * that is not a small effect on a mean: it is a fabricated observation.
 */
export function sessionScope(taskIds: readonly string[]) {
  return and(inArray(workers.taskId, [...taskIds]), isNotNull(workers.startedAt));
}

/**
 * Read a count off a numeric/decimal column.
 *
 * `propensity`, `fraction` and `memory_share` are Postgres `decimal`, which the
 * driver hands back as a string to avoid silently losing precision. A bare
 * `Number(...)` on a null would produce 0 — a real value — so absence is
 * preserved as null here and handled as unknown downstream.
 */
function numeric(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** A count that is genuinely absent stays absent. */
function optionalCount(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

export interface LoadOptions {
  policyVersion: string;
  backend?: string;
  now?: Date;
  options?: ReadoutOptions;
}

/**
 * Pull the cohort and shape it into the pure layer's input.
 *
 * Returns the composition rows even when no task matched anything else, because
 * "rows exist but no sessions do" and "no rows at all" are different diagnoses
 * and the verdict distinguishes them.
 */
export async function loadReadoutInput(opts: LoadOptions) {
  const compositionRows = await db
    .select({
      taskId: workerPromptCompositionEvents.taskId,
      workerId: workerPromptCompositionEvents.workerId,
      buildIndex: workerPromptCompositionEvents.buildIndex,
      ts: workerPromptCompositionEvents.ts,
      policyVersion: workerPromptCompositionEvents.policyVersion,
      arm: workerPromptCompositionEvents.arm,
      taskMatchDerivedBy: workerPromptCompositionEvents.taskMatchDerivedBy,
      backend: workerPromptCompositionEvents.backend,
      promptBytes: workerPromptCompositionEvents.promptBytes,
      memoryBlockBytes: workerPromptCompositionEvents.memoryBlockBytes,
      digestBytes: workerPromptCompositionEvents.digestBytes,
      digestBytesAvailable: workerPromptCompositionEvents.digestBytesAvailable,
      memoryShare: workerPromptCompositionEvents.memoryShare,
    })
    .from(workerPromptCompositionEvents)
    .where(compositionCohortScope(opts.policyVersion));

  const composition: CompositionRow[] = compositionRows.map(r => ({
    taskId: r.taskId,
    workerId: r.workerId,
    buildIndex: r.buildIndex,
    ts: r.ts instanceof Date ? r.ts : new Date(r.ts as any),
    policyVersion: r.policyVersion,
    arm: r.arm as MemoryDigestArm,
    taskMatchDerivedBy: r.taskMatchDerivedBy,
    backend: r.backend,
    promptBytes: r.promptBytes,
    memoryBlockBytes: r.memoryBlockBytes,
    digestBytes: r.digestBytes,
    digestBytesAvailable: r.digestBytesAvailable,
    memoryShare: numeric(r.memoryShare),
  }));

  const taskIds = [...new Set(composition.map(c => c.taskId).filter((t): t is string => !!t))];

  // inArray with an empty list is a trap — depending on the drizzle version it
  // either throws or renders a clause that matches everything. Short-circuit.
  if (taskIds.length === 0) {
    return {
      composition,
      sessions: [] as SessionRow[],
      policyVersion: opts.policyVersion,
      backend: opts.backend ?? DEFAULT_BACKEND,
      now: opts.now ?? new Date(),
      options: opts.options,
    };
  }

  const workerRows = await db
    .select({
      id: workers.id,
      taskId: workers.taskId,
      status: workers.status,
      turns: workers.turns,
      resultMeta: workers.resultMeta,
    })
    .from(workers)
    .where(sessionScope(taskIds));

  const sessions: SessionRow[] = workerRows.map(w => {
    const meta = (w.resultMeta ?? null) as
      | {
          durationMs?: number;
          numTurns?: number;
          toolCounts?: Record<string, number>;
          bashCommandCounts?: { total?: number };
          cbm?: { readCount?: number };
        }
      | null;
    const toolCounts = meta?.toolCounts;
    // Absence of the histogram is UNKNOWN, not zero — see ResultMeta.toolCounts.
    // `cbm.readCount` is the older, narrower counter and only covers the Read
    // tool, which is exactly this metric, so it is a legitimate fallback.
    const readCalls = toolCounts
      ? (toolCounts.Read ?? 0)
      : optionalCount(meta?.cbm?.readCount);
    const shellCalls = toolCounts
      ? (toolCounts.Bash ?? 0)
      : optionalCount(meta?.bashCommandCounts?.total);
    return {
      taskId: w.taskId,
      workerId: w.id,
      status: w.status,
      turns: optionalCount(meta?.numTurns) ?? (w.turns > 0 ? w.turns : null),
      durationMs: optionalCount(meta?.durationMs),
      readCalls,
      shellCalls,
      // Absent histogram is unknown, not "did not call recall".
      calledRecall: toolCounts ? (toolCounts[RECALL_TOOL] ?? 0) > 0 : null,
    };
  });

  return {
    composition,
    sessions,
    policyVersion: opts.policyVersion,
    backend: opts.backend ?? DEFAULT_BACKEND,
    now: opts.now ?? new Date(),
    options: opts.options,
  };
}

/**
 * The importable entry point. A cron route, a CLI, a page loader and an MCP
 * action all call exactly this — there is one definition of the readout, and no
 * caller is in a position to compute a different one.
 */
export async function runMemoryDigestReadout(opts: LoadOptions): Promise<Readout> {
  return computeReadout(await loadReadoutInput(opts));
}

// ── Durable persistence ─────────────────────────────────────────────────────

/** `system_cache` key holding the most recent readout. */
export const READOUT_CACHE_KEY = 'memory-digest-readout:latest';

/** `system_cache` key prefix claiming "this verdict has been notified". */
export const READOUT_NOTIFIED_KEY_PREFIX = 'memory-digest-readout:notified:';

export function notifiedKey(notificationKey: string): string {
  return `${READOUT_NOTIFIED_KEY_PREFIX}${notificationKey}`;
}

/**
 * Persist the readout so the verdict outlives the notification.
 *
 * A push notification is the most lossy delivery channel there is — it is read
 * once, on a phone, and then gone. The row is what a page or an MCP action
 * reads later to show the last verdict without recomputing it, and it is what
 * makes the notification checkable after the fact rather than taken on trust.
 *
 * `expires_at` is deliberately NULL: this is a record, not a cache entry, and
 * the experiment's whole point is to be re-readable after it ends.
 */
export async function persistReadout(readout: Readout, now = new Date()): Promise<void> {
  await db
    .insert(systemCache)
    .values({ key: READOUT_CACHE_KEY, value: readout as unknown as Record<string, unknown>, updatedAt: now, expiresAt: null })
    .onConflictDoUpdate({
      target: systemCache.key,
      set: { value: readout as unknown as Record<string, unknown>, updatedAt: now, expiresAt: null },
    });
}

/** The last persisted readout, or null when none has ever been written. */
export async function readPersistedReadout(): Promise<Readout | null> {
  const [row] = await db
    .select({ value: systemCache.value })
    .from(systemCache)
    .where(eq(systemCache.key, READOUT_CACHE_KEY))
    .limit(1);
  return (row?.value as Readout | undefined) ?? null;
}

/**
 * Atomically claim the right to notify about one verdict. True exactly once per
 * verdict, for ever, across any number of concurrent or repeated runs.
 *
 * `onConflictDoNothing().returning()` is the whole mechanism: Postgres returns
 * a row only when the INSERT actually inserted, so the first caller wins and
 * every later one gets an empty array. That is what turns a daily cron into a
 * single push — without it, a terminal verdict pages every day until someone
 * disables the job, which trains the recipient to ignore it.
 *
 * The claim is taken BEFORE the send, so a send that throws does not un-claim.
 * A lost notification is recoverable (the row is persisted, the verdict is
 * readable); a notification loop is not, because by the time anyone looks they
 * have already muted the channel.
 */
export async function claimVerdictNotification(notificationKey: string, now = new Date()): Promise<boolean> {
  const claimed = await db
    .insert(systemCache)
    .values({
      key: notifiedKey(notificationKey),
      value: { notificationKey, claimedAt: now.toISOString() },
      updatedAt: now,
      expiresAt: null,
    })
    .onConflictDoNothing()
    .returning({ key: systemCache.key });
  return claimed.length > 0;
}
