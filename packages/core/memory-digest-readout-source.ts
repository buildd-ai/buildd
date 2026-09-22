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

import { and, asc, count, desc, eq, gte, inArray, isNotNull, lte } from 'drizzle-orm';
import { db } from './db';
import { artifacts, systemCache, workerPromptCompositionEvents, workers } from './db/schema';
import {
  DEFAULT_BACKEND,
  computeReadout,
  formatReadoutText,
  terminalNotificationKeys,
  terminalStatusFromNotificationKey,
  type CompositionRow,
  type MemoryDigestArm,
  type Readout,
  type ReadoutOptions,
  type SessionRow,
  type TerminalVerdictStatus,
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
      propensity: workerPromptCompositionEvents.propensity,
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
    propensity: numeric(r.propensity),
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

// ── Guardrail monitor loader ────────────────────────────────────────────────

/**
 * Cohort filter for the standing post-ship guardrail monitor
 * (`memory-digest-guardrail-monitor.ts`).
 *
 * Unlike `compositionCohortScope`, this is scoped to a time window rather than
 * to the whole policy version — the monitor runs on a rolling cadence, not
 * once at conclusion — and to `propensity = 1`, which is the shipped,
 * unconditional-rendering cohort. `propensity < 1` rows are the pre-flip
 * randomised cohort the terminal readout already judged; re-including them in
 * a rolling window would let old, already-decided rows dilute a fresh signal.
 */
export function guardrailWindowScope(windowStart: Date, now: Date, policyVersion: string) {
  return and(
    eq(workerPromptCompositionEvents.policyVersion, policyVersion),
    eq(workerPromptCompositionEvents.arm, 'task_scoped'),
    eq(workerPromptCompositionEvents.propensity, '1'),
    isNotNull(workerPromptCompositionEvents.taskId),
    gte(workerPromptCompositionEvents.ts, windowStart),
    lte(workerPromptCompositionEvents.ts, now),
  );
}

export interface GuardrailLoadOptions {
  policyVersion: string;
  windowStart: Date;
  now: Date;
}

/**
 * Load the rolling window's composition rows and their worker sessions.
 *
 * Same two-query shape as `loadReadoutInput` and for the same reason: the
 * cohort filter is tested against rendered SQL, the arithmetic is tested
 * against literal rows, and neither test needs a live database.
 */
export async function loadGuardrailWindowInput(opts: GuardrailLoadOptions) {
  const compositionRows = await db
    .select({
      taskId: workerPromptCompositionEvents.taskId,
      workerId: workerPromptCompositionEvents.workerId,
      buildIndex: workerPromptCompositionEvents.buildIndex,
      ts: workerPromptCompositionEvents.ts,
      policyVersion: workerPromptCompositionEvents.policyVersion,
      arm: workerPromptCompositionEvents.arm,
      propensity: workerPromptCompositionEvents.propensity,
      taskMatchDerivedBy: workerPromptCompositionEvents.taskMatchDerivedBy,
      backend: workerPromptCompositionEvents.backend,
      promptBytes: workerPromptCompositionEvents.promptBytes,
      memoryBlockBytes: workerPromptCompositionEvents.memoryBlockBytes,
      digestBytes: workerPromptCompositionEvents.digestBytes,
      digestBytesAvailable: workerPromptCompositionEvents.digestBytesAvailable,
      memoryShare: workerPromptCompositionEvents.memoryShare,
    })
    .from(workerPromptCompositionEvents)
    .where(guardrailWindowScope(opts.windowStart, opts.now, opts.policyVersion));

  const composition: CompositionRow[] = compositionRows.map(r => ({
    taskId: r.taskId,
    workerId: r.workerId,
    buildIndex: r.buildIndex,
    ts: r.ts instanceof Date ? r.ts : new Date(r.ts as any),
    policyVersion: r.policyVersion,
    arm: r.arm as MemoryDigestArm,
    propensity: numeric(r.propensity),
    taskMatchDerivedBy: r.taskMatchDerivedBy,
    backend: r.backend,
    promptBytes: r.promptBytes,
    memoryBlockBytes: r.memoryBlockBytes,
    digestBytes: r.digestBytes,
    digestBytesAvailable: r.digestBytesAvailable,
    memoryShare: numeric(r.memoryShare),
  }));

  const taskIds = [...new Set(composition.map(c => c.taskId).filter((t): t is string => !!t))];
  if (taskIds.length === 0) return { composition, sessions: [] as SessionRow[] };

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
    const readCalls = toolCounts ? (toolCounts.Read ?? 0) : optionalCount(meta?.cbm?.readCount);
    const shellCalls = toolCounts ? (toolCounts.Bash ?? 0) : optionalCount(meta?.bashCommandCounts?.total);
    return {
      taskId: w.taskId,
      workerId: w.id,
      status: w.status,
      turns: optionalCount(meta?.numTurns) ?? (w.turns > 0 ? w.turns : null),
      durationMs: optionalCount(meta?.durationMs),
      readCalls,
      shellCalls,
      calledRecall: toolCounts ? (toolCounts[RECALL_TOOL] ?? 0) > 0 : null,
    };
  });

  return { composition, sessions };
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
export async function claimVerdictNotification(
  notificationKey: string,
  details: VerdictClaimDetails = {},
  now = new Date(),
): Promise<boolean> {
  const claimed = await db
    .insert(systemCache)
    .values({
      key: notifiedKey(notificationKey),
      value: { notificationKey, claimedAt: now.toISOString(), ...details },
      updatedAt: now,
      expiresAt: null,
    })
    .onConflictDoNothing()
    .returning({ key: systemCache.key });
  return claimed.length > 0;
}

/**
 * What the claim row records alongside the fact of the claim.
 *
 * Written at claim time so the retired route can answer "what was delivered,
 * when, and where can I read it" from the same single row it already has to
 * read to know it is retired — no second query, and no dependence on the
 * notification itself having been seen.
 */
export interface VerdictClaimDetails {
  status?: string;
  artifactId?: string | null;
  artifactUrl?: string | null;
}

// ── Retirement: has a terminal verdict already been delivered? ───────────────

/**
 * Scope matching the claim row of ANY terminal verdict for a policy version.
 *
 * The keys are enumerated from `terminalNotificationKeys`, which is also what
 * `buildVerdict` stamps its keys with — so this cannot drift into matching a
 * key nothing writes, nor into missing one that is written. Two keys, primary
 * key lookup: cheaper than the readout by orders of magnitude, which is the
 * point.
 */
export function deliveredVerdictScope(policyVersion: string) {
  return inArray(systemCache.key, terminalNotificationKeys(policyVersion).map(notifiedKey));
}

export interface DeliveredVerdict {
  notificationKey: string;
  status: TerminalVerdictStatus | string | null;
  claimedAt: string | null;
  artifactId: string | null;
  artifactUrl: string | null;
}

/**
 * The terminal verdict already delivered for this policy version, or null.
 *
 * This is what lets the job retire itself. Flipping `enabled` in
 * `cron-manifest.json` cannot do it — that is a build-time declaration synced
 * by CI, so a runtime event cannot reach it, and the next `cron:sync` would
 * undo a schedule disabled out-of-band at the scheduler. So the route stops
 * doing the work instead, on the strength of the claim row that already exists
 * for the notification. One indexed lookup on a primary key and nothing else.
 */
export async function findDeliveredVerdict(policyVersion: string): Promise<DeliveredVerdict | null> {
  const [row] = await db
    .select({ key: systemCache.key, value: systemCache.value })
    .from(systemCache)
    .where(deliveredVerdictScope(policyVersion))
    .limit(1);
  if (!row) return null;

  const value = (row.value ?? {}) as Record<string, unknown>;
  const notificationKey =
    typeof value.notificationKey === 'string'
      ? value.notificationKey
      : row.key.slice(READOUT_NOTIFIED_KEY_PREFIX.length);
  return {
    notificationKey,
    // Prefer the key's own meaning over a stored label: rows claimed before
    // `status` was written carry no label, and the key is authoritative anyway.
    status: terminalStatusFromNotificationKey(policyVersion, notificationKey)
      ?? (typeof value.status === 'string' ? value.status : null),
    claimedAt: typeof value.claimedAt === 'string' ? value.claimedAt : null,
    artifactId: typeof value.artifactId === 'string' ? value.artifactId : null,
    artifactUrl: typeof value.artifactUrl === 'string' ? value.artifactUrl : null,
  };
}

// ── The verdict as a first-class artifact ───────────────────────────────────

/**
 * `artifacts.key` prefix for the readout.
 *
 * The policy version is part of the key on purpose. A version bump redefines
 * the arms and re-randomises assignment, so the next experiment's verdict must
 * not overwrite this one's — the durability of a concluded verdict is the whole
 * reason this is an artifact rather than a notification.
 *
 * A key at all (rather than a keyless row per run) because `(workspaceId, key)`
 * is a unique index: keyed means upsert, keyless means a new row every morning.
 * It is also the signal the artifacts UI uses to tell a deliberately-created,
 * re-addressable artifact from an incidental one.
 */
export const READOUT_ARTIFACT_KEY_PREFIX = 'memory-digest-readout:';

export function readoutArtifactKey(policyVersion: string): string {
  return `${READOUT_ARTIFACT_KEY_PREFIX}${policyVersion}`;
}

/**
 * `analysis`, not `report`.
 *
 * Both are in the shared vocabulary. `report` is what agents write as prose
 * about work they did; this is a statistical analysis of stored rows — effect
 * sizes with intervals, a covariate-balance check and a power position — and it
 * is regenerated by arithmetic rather than authored. Typing it `analysis` keeps
 * the distinction available to anyone filtering the artifacts list, and nothing
 * downstream treats the two differently today.
 */
export const READOUT_ARTIFACT_TYPE = 'analysis';

/**
 * The conflict target for the upsert: exactly the columns of the
 * `artifacts_workspace_key_idx` unique index.
 *
 * Exported so a test can assert it against the index as declared in the schema.
 * If the two ever diverge the upsert silently degrades into an insert that
 * throws — or worse, into a duplicate row per run, which is the failure this
 * whole key exists to avoid.
 */
export const READOUT_ARTIFACT_CONFLICT_TARGET = [artifacts.workspaceId, artifacts.key];

/**
 * Env override naming the workspace the readout artifact lives in.
 *
 * This repo is public, so a workspace id cannot be committed; and the readout
 * is fleet-wide while an artifact is workspace-scoped, so *some* workspace has
 * to be named. Unset, the placement is derived from the cohort — see below.
 */
export const READOUT_WORKSPACE_ENV = 'MEMORY_DIGEST_READOUT_WORKSPACE_ID';

/** Cohort-workspace scope: the policy version's builds, workspace recorded. */
export function cohortWorkspaceScope(policyVersion: string) {
  return and(
    eq(workerPromptCompositionEvents.policyVersion, policyVersion),
    isNotNull(workers.workspaceId),
  );
}

/**
 * The workspace contributing the most prompt builds to the cohort.
 *
 * Ties broken by the lowest id so the answer is deterministic for a given set
 * of rows rather than dependent on scan order.
 */
export async function modalCohortWorkspaceId(policyVersion: string): Promise<string | null> {
  const rows = await db
    .select({ workspaceId: workers.workspaceId, builds: count() })
    .from(workerPromptCompositionEvents)
    .innerJoin(workers, eq(workers.id, workerPromptCompositionEvents.workerId))
    .where(cohortWorkspaceScope(policyVersion))
    .groupBy(workers.workspaceId)
    .orderBy(desc(count()), asc(workers.workspaceId))
    .limit(1);
  return rows[0]?.workspaceId ?? null;
}

/** Scope matching the readout artifact for a policy version, in any workspace. */
export function readoutArtifactScope(policyVersion: string) {
  return eq(artifacts.key, readoutArtifactKey(policyVersion));
}

/**
 * The workspace the readout artifact already lives in, if it exists.
 *
 * Read before deriving a placement, so the artifact never migrates: the modal
 * workspace can change as rows accrue, and a placement that follows it would
 * leave one artifact per workspace it ever passed through, each frozen at the
 * verdict of the day it stopped being modal. Oldest row wins for the same
 * reason.
 */
export async function boundArtifactWorkspaceId(policyVersion: string): Promise<string | null> {
  const [row] = await db
    .select({ workspaceId: artifacts.workspaceId })
    .from(artifacts)
    .where(readoutArtifactScope(policyVersion))
    .orderBy(asc(artifacts.createdAt))
    .limit(1);
  return row?.workspaceId ?? null;
}

/** Env override → where the artifact already is → the cohort's modal workspace. */
export async function resolveReadoutArtifactWorkspaceId(policyVersion: string): Promise<string | null> {
  const configured = process.env[READOUT_WORKSPACE_ENV];
  if (configured) return configured;
  return (await boundArtifactWorkspaceId(policyVersion)) ?? (await modalCohortWorkspaceId(policyVersion));
}

export interface ReadoutArtifact {
  id: string;
  workspaceId: string;
  key: string;
  type: string;
}

/**
 * Publish the readout as a keyed artifact, upserting in place.
 *
 * Upsert via `ON CONFLICT (workspace_id, key) DO UPDATE` rather than
 * select-then-insert: two concurrent runs would both see no row and both
 * insert, and the neon-http driver has no interactive transaction to serialise
 * them with. The conflict target is the unique index itself, so "one artifact
 * per policy version, updated in place" is enforced by Postgres and not by this
 * function getting the ordering right.
 *
 * Returns null rather than throwing when no workspace can be resolved: an
 * unplaceable artifact must not be able to take the verdict's notification down
 * with it.
 */
export async function upsertReadoutArtifact(
  readout: Readout,
  now = new Date(),
): Promise<ReadoutArtifact | null> {
  const workspaceId = await resolveReadoutArtifactWorkspaceId(readout.policyVersion);
  if (!workspaceId) return null;

  const key = readoutArtifactKey(readout.policyVersion);
  const title = `Memory digest experiment readout — ${readout.verdict.status}`;
  // Fenced, because the artifact page renders `content` as markdown and this
  // report is column-aligned monospace: unfenced, react-markdown collapses the
  // alignment and folds the whole thing into paragraphs. The report itself is
  // still in there verbatim, which is what makes the artifact checkable against
  // `bun run readout:memory-digest`.
  const content = ['```', formatReadoutText(readout), '```'].join('\n');
  // Every figure here is computed from rows at run time; none is a constant.
  const metadata: Record<string, unknown> = {
    source: 'cron:memory-digest-readout',
    policyVersion: readout.policyVersion,
    backend: readout.backend,
    verdict: readout.verdict.status,
    terminal: readout.verdict.terminal,
    nPerArm: readout.verdict.nPerArm,
    requiredNPerArm: readout.verdict.requiredNPerArm,
    fractionOfRequired: readout.verdict.fractionOfRequired,
    cohortRows: readout.cohortRows,
    boundaryAt: readout.boundary?.at ?? null,
    generatedAt: readout.generatedAt,
    // The analysis spans the fleet; the row has to live in one workspace
    // because that is what the unique index is on. Said out loud here so the
    // placement is never read as "this workspace's experiment".
    scope: 'fleet',
  };

  const [row] = await db
    .insert(artifacts)
    .values({
      workspaceId,
      key,
      type: READOUT_ARTIFACT_TYPE,
      title,
      content,
      metadata,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: READOUT_ARTIFACT_CONFLICT_TARGET,
      set: { type: READOUT_ARTIFACT_TYPE, title, content, metadata, updatedAt: now },
    })
    .returning({ id: artifacts.id, workspaceId: artifacts.workspaceId, key: artifacts.key, type: artifacts.type });

  if (!row?.id) return null;
  return { id: row.id, workspaceId: row.workspaceId ?? workspaceId, key: row.key ?? key, type: row.type };
}
