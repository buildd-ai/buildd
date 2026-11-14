/**
 * Relay queue storage (docs/specs/local-runner-provider.md §3, §4): enqueue,
 * claim, complete, progress, cancel, sweep and await over `model_relay_jobs`,
 * with the usage ledger `model_relay_usage_daily` written on every terminal
 * transition (§3.4).
 *
 * Every transition is one atomic UPDATE guarded by the state it leaves
 * (`status = 'leased' AND lease_owner = $owner`, `FOR UPDATE SKIP LOCKED` on
 * the claim), never `db.transaction()` (neon-http). `claimDue` in
 * apps/web/src/lib/workflow/command-outbox.ts is the shape copied.
 *
 * Nothing here throws into a caller's request on a ledger failure: the ledger
 * is best-effort and logged. The queue transitions themselves do throw on a
 * database error; `awaitRelayJob` is the E-8 boundary and never does.
 */
import { randomUUID } from 'crypto';
import { sql, type SQL } from 'drizzle-orm';
import {
  RELAY_DEFAULTS,
  isRetryableRelayError,
  isRelayChatPayload,
  isRelayEmbedPayload,
  isTerminalRelayStatus,
  relayBackoffMs,
  relayPayloadBytes,
  validateChatResult,
  validateEmbedResult,
  type RelayAwaitOutcome,
  type RelayClaimedJob,
  type RelayErrorCode,
  type RelayJobError,
  type RelayJobKind,
  type RelayJobPayload,
  type RelayJobResult,
  type RelayJobStatus,
  type RelayJobSurface,
} from '@buildd/shared';

/** The one database call shape every helper needs; `db.execute` satisfies it. */
export type RelayExec = (q: SQL) => Promise<{ rows?: unknown[] }>;

type J = Record<string, unknown>;
const rowsOf = (r: { rows?: unknown[] }) => (r.rows ?? []) as J[];
const parseJson = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

let defaultExec: RelayExec | null = null;
async function dbExec(q: SQL): Promise<{ rows?: unknown[] }> {
  if (!defaultExec) {
    const { db } = await import('../db/index');
    defaultExec = (query) => db.execute(query) as unknown as Promise<{ rows?: unknown[] }>;
  }
  return defaultExec(q);
}

// ── Enqueue ──────────────────────────────────────────────────────────────────

export interface EnqueueRelayJobInput {
  teamId: string;
  workspaceId?: string | null;
  /** The pinned runner (a worker_heartbeats.id); the caller has already checked it is online and serves `model` (§4.3). */
  runnerId: string;
  kind: RelayJobKind;
  surface: RelayJobSurface;
  namespace?: string | null;
  model: string;
  payload: RelayJobPayload;
  maxAttempts?: number;
  /** Overrides the surface default. */
  deadlineMs?: number;
}

export type EnqueueRelayJobResult =
  | { ok: true; id: string; deadlineAt: Date }
  | { ok: false; code: 'payload_too_large' | 'bad_payload'; message: string };

/** Insert a queued job. A chat payload above the cap is refused before any row is written (§3.1). */
export async function enqueueRelayJob(input: EnqueueRelayJobInput, exec: RelayExec = dbExec): Promise<EnqueueRelayJobResult> {
  const shapeOk = input.kind === 'embed' ? isRelayEmbedPayload(input.payload) : isRelayChatPayload(input.payload);
  if (!shapeOk) return { ok: false, code: 'bad_payload', message: `${input.kind} payload has the wrong shape` };
  if (input.kind === 'chat') {
    const bytes = relayPayloadBytes(input.payload);
    if (bytes > RELAY_DEFAULTS.chatPayloadMaxBytes) {
      return { ok: false, code: 'payload_too_large', message: `chat payload is ${bytes} bytes; the cap is ${RELAY_DEFAULTS.chatPayloadMaxBytes}` };
    }
  }
  const maxAttempts = input.maxAttempts ?? RELAY_DEFAULTS.maxAttempts[input.kind];
  const deadlineSecs = (input.deadlineMs ?? RELAY_DEFAULTS.deadlineMs[input.surface]) / 1000;
  const rows = rowsOf(await exec(sql`-- relay:enqueue
INSERT INTO model_relay_jobs (team_id, workspace_id, runner_id, kind, surface, namespace, model, payload, max_attempts, deadline_at)
VALUES (${input.teamId}::uuid, ${input.workspaceId ?? null}::uuid, ${input.runnerId}::uuid, ${input.kind}::text, ${input.surface}::text,
  ${input.namespace ?? null}::text, ${input.model}::text, ${JSON.stringify(input.payload)}::jsonb, ${maxAttempts}::int,
  now() + make_interval(secs => ${deadlineSecs}::double precision))
RETURNING id, deadline_at`));
  const row = rows[0]!;
  return { ok: true, id: String(row.id), deadlineAt: new Date(iso(row.deadline_at)) };
}

// ── Claim ────────────────────────────────────────────────────────────────────

export interface ClaimRelayJobsInput {
  teamId: string;
  runnerId: string;
  /** What the runner's Ollama serves now; only jobs for these tags are handed out. */
  models: string[];
  max?: number;
  leaseMs?: number;
}

export interface ClaimedRelayJob extends RelayClaimedJob {
  surface: RelayJobSurface;
  /** `runnerId:leaseId`, as stored; what `completeRelayJob` and `progressRelayJob` check. */
  leaseOwner: string;
}

/** The stored lease owner for a runner's lease id. */
export function relayLeaseOwner(runnerId: string, leaseId: string): string {
  return `${runnerId}:${leaseId}`;
}

/**
 * Lease up to `max` due jobs pinned to this runner (§4.1): one atomic
 * statement, chat first (a person is waiting), then oldest first. A job
 * whose model the runner does not list is left for a runner that does.
 */
export async function claimRelayJobs(input: ClaimRelayJobsInput, exec: RelayExec = dbExec): Promise<ClaimedRelayJob[]> {
  const models = input.models.filter(m => typeof m === 'string' && m.length > 0);
  if (models.length === 0) return [];
  const max = Math.max(1, Math.min(50, Math.floor(input.max ?? RELAY_DEFAULTS.claimMax.embed)));
  const leaseSecs = (input.leaseMs ?? RELAY_DEFAULTS.leaseMs) / 1000;
  const leaseId = randomUUID();
  const owner = relayLeaseOwner(input.runnerId, leaseId);
  const rows = rowsOf(await exec(sql`-- relay:claim
UPDATE model_relay_jobs j
SET status = 'leased', lease_owner = ${owner}::text, leased_at = now(),
    lease_expires_at = now() + make_interval(secs => ${leaseSecs}::double precision), attempts = j.attempts + 1
WHERE j.id IN (
  SELECT id FROM model_relay_jobs
  WHERE team_id = ${input.teamId}::uuid AND runner_id = ${input.runnerId}::uuid
    AND status = 'queued' AND not_before <= now() AND deadline_at > now()
    AND model IN (${sql.join(models.map(m => sql`${m}::text`), sql`, `)})
  ORDER BY CASE kind WHEN 'chat' THEN 0 ELSE 1 END, created_at
  LIMIT ${max}::int
  FOR UPDATE SKIP LOCKED
) AND j.status = 'queued'
RETURNING j.id, j.kind, j.surface, j.model, j.payload, j.deadline_at, j.lease_expires_at`));
  return rows.map(r => ({
    id: String(r.id),
    kind: String(r.kind) as RelayJobKind,
    surface: String(r.surface) as RelayJobSurface,
    model: String(r.model),
    payload: parseJson<RelayJobPayload>(r.payload),
    deadlineAt: iso(r.deadline_at),
    leaseExpiresAt: iso(r.lease_expires_at),
    leaseId,
    leaseOwner: owner,
  }));
}

// ── Complete ─────────────────────────────────────────────────────────────────

export type CompleteRelayJobInput =
  | { id: string; leaseOwner: string; ok: true; result: RelayJobResult }
  | { id: string; leaseOwner: string; ok: false; error: RelayJobError };

export type CompleteRelayJobOutcome =
  /** Terminal: stored as the runner posted it (or as `failed` when the result failed validation). */
  | { outcome: 'done' | 'failed'; error?: RelayJobError }
  /** A retryable failure with attempts left: queued again after backoff. */
  | { outcome: 'requeued'; notBeforeMs: number }
  /** The lease moved to another owner (HTTP 409 for the route). */
  | { outcome: 'conflict' }
  /** The job is already terminal (HTTP 410) or does not exist (HTTP 404). */
  | { outcome: 'gone'; status: RelayJobStatus | null };

interface LeasedRow { kind: RelayJobKind; payload: RelayJobPayload; attempts: number; maxAttempts: number }

async function readLeased(id: string, leaseOwner: string, exec: RelayExec): Promise<LeasedRow | { conflict: true; status: RelayJobStatus | null }> {
  const rows = rowsOf(await exec(sql`-- relay:read_leased
SELECT kind, payload, attempts, max_attempts, status, lease_owner FROM model_relay_jobs WHERE id = ${id}::uuid`));
  const row = rows[0];
  if (!row) return { conflict: true, status: null };
  if (row.status !== 'leased' || row.lease_owner !== leaseOwner) return { conflict: true, status: String(row.status) as RelayJobStatus };
  return { kind: String(row.kind) as RelayJobKind, payload: parseJson<RelayJobPayload>(row.payload), attempts: Number(row.attempts), maxAttempts: Number(row.max_attempts) };
}

/**
 * Record a runner's result (§4.2). The UPDATE is guarded by the lease, so a
 * stale owner changes nothing. An `embed` result is validated against the
 * job's own payload before anything is stored: one wrong-sized vector fails
 * the job with `dimension_mismatch` (AC-12). A retryable failure with
 * attempts left goes back to `queued` with backoff; everything else is final
 * and written to the ledger.
 */
export async function completeRelayJob(input: CompleteRelayJobInput, exec: RelayExec = dbExec): Promise<CompleteRelayJobOutcome> {
  const leased = await readLeased(input.id, input.leaseOwner, exec);
  if ('conflict' in leased) {
    if (leased.status === null) return { outcome: 'gone', status: null };
    return isTerminalRelayStatus(leased.status) ? { outcome: 'gone', status: leased.status } : { outcome: 'conflict' };
  }

  let error: RelayJobError | null = null;
  let result: RelayJobResult | null = null;
  if (input.ok) {
    error = leased.kind === 'embed'
      ? (isRelayEmbedPayload(leased.payload) ? validateEmbedResult(leased.payload, input.result) : { code: 'bad_result', message: 'job payload is not an embed payload' })
      : validateChatResult(input.result);
    if (!error) result = input.result;
  } else {
    error = input.error;
  }

  const retry = !!error && !input.ok && isRetryableRelayError(error) && leased.attempts < leased.maxAttempts;
  const backoffMs = retry ? relayBackoffMs(leased.attempts) : 0;
  const status: RelayJobStatus = retry ? 'queued' : error ? 'failed' : 'done';
  const held = sql`id = ${input.id}::uuid AND status = 'leased' AND lease_owner = ${input.leaseOwner}::text`;
  const rows = rowsOf(await exec(sql`-- relay:complete
UPDATE model_relay_jobs
SET status = ${status}::text,
    result = ${result ? JSON.stringify(result) : null}::jsonb,
    error = ${error ? JSON.stringify(error) : null}::jsonb,
    lease_owner = NULL, lease_expires_at = NULL,
    not_before = CASE WHEN ${retry}::boolean THEN now() + make_interval(secs => ${backoffMs / 1000}::double precision) ELSE not_before END,
    finished_at = CASE WHEN ${retry}::boolean THEN NULL ELSE now() END
WHERE ${held}
RETURNING team_id, runner_id, kind, model`));
  const row = rows[0];
  if (!row) {
    // The lease moved between the read and the write.
    const again = await readLeased(input.id, input.leaseOwner, exec);
    if ('conflict' in again && again.status !== null && isTerminalRelayStatus(again.status)) return { outcome: 'gone', status: again.status };
    return { outcome: 'conflict' };
  }
  if (retry) return { outcome: 'requeued', notBeforeMs: backoffMs };
  await recordRelayUsage({
    teamId: String(row.team_id), runnerId: row.runner_id ? String(row.runner_id) : null, kind: String(row.kind) as RelayJobKind, model: String(row.model),
    error: !!error, result,
  }, exec);
  return error ? { outcome: 'failed', error } : { outcome: 'done' };
}

// ── Progress ─────────────────────────────────────────────────────────────────

export interface ProgressRelayJobInput {
  id: string;
  leaseOwner: string;
  /** Chat: appended to `result.partialText`. */
  partialText?: string;
  leaseMs?: number;
}

/** Renew the lease and, for chat, append the new text (§4.5). False when the lease is not this owner's. */
export async function progressRelayJob(input: ProgressRelayJobInput, exec: RelayExec = dbExec): Promise<boolean> {
  const leaseSecs = (input.leaseMs ?? RELAY_DEFAULTS.leaseMs) / 1000;
  const text = input.partialText ?? '';
  const rows = rowsOf(await exec(sql`-- relay:progress
UPDATE model_relay_jobs
SET lease_expires_at = now() + make_interval(secs => ${leaseSecs}::double precision),
    result = CASE WHEN ${text.length > 0}::boolean
      THEN jsonb_set(coalesce(result, '{}'::jsonb), '{partialText}', to_jsonb(coalesce(result->>'partialText', '') || ${text}::text))
      ELSE result END
WHERE id = ${input.id}::uuid AND status = 'leased' AND lease_owner = ${input.leaseOwner}::text
RETURNING 1 AS ok`));
  return rows.length > 0;
}

// ── Cancel ───────────────────────────────────────────────────────────────────

/** A waiter that gave up (§4.3): the job is `cancelled` unless already terminal. True when this call cancelled it. */
export async function cancelRelayJob(id: string, exec: RelayExec = dbExec): Promise<boolean> {
  const error: RelayJobError = { code: 'cancelled', message: 'the waiter gave up before a result arrived' };
  const rows = rowsOf(await exec(sql`-- relay:cancel
UPDATE model_relay_jobs
SET status = 'cancelled', error = ${JSON.stringify(error)}::jsonb, lease_owner = NULL, lease_expires_at = NULL, finished_at = now()
WHERE id = ${id}::uuid AND status IN ('queued', 'leased')
RETURNING team_id, runner_id, kind, model`));
  const row = rows[0];
  if (!row) return false;
  await recordRelayUsage({ teamId: String(row.team_id), runnerId: row.runner_id ? String(row.runner_id) : null, kind: String(row.kind) as RelayJobKind, model: String(row.model), error: true, result: null }, exec);
  return true;
}

// ── Read ─────────────────────────────────────────────────────────────────────

export interface RelayJobView {
  id: string;
  status: RelayJobStatus;
  kind: RelayJobKind;
  result: RelayJobResult | null;
  error: RelayJobError | null;
  deadlineAt: string;
}

export async function getRelayJob(id: string, exec: RelayExec = dbExec): Promise<RelayJobView | null> {
  const rows = rowsOf(await exec(sql`-- relay:get
SELECT id, status, kind, result, error, deadline_at FROM model_relay_jobs WHERE id = ${id}::uuid`));
  const r = rows[0];
  if (!r) return null;
  return {
    id: String(r.id), status: String(r.status) as RelayJobStatus, kind: String(r.kind) as RelayJobKind,
    result: r.result == null ? null : parseJson<RelayJobResult>(r.result),
    error: r.error == null ? null : parseJson<RelayJobError>(r.error),
    deadlineAt: iso(r.deadline_at),
  };
}

// ── Await ────────────────────────────────────────────────────────────────────

export interface AwaitRelayJobOptions {
  /** The job's deadline; the wait gives up (and cancels) there. */
  deadlineAt: Date;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called with each new slice of chat partial text as it appears. */
  onPartialText?: (delta: string) => void;
}

/**
 * Poll the row until it is terminal or the deadline passes (§4.3). Past the
 * deadline a still-open job is `cancelled` and the caller gets `runner_offline`.
 * Never throws (E-8): a database error ends the wait as `runner_offline` too.
 */
export async function awaitRelayJob(id: string, opts: AwaitRelayJobOptions, exec: RelayExec = dbExec): Promise<RelayAwaitOutcome> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? RELAY_DEFAULTS.waitPollMs;
  let seenPartial = '';
  try {
    for (;;) {
      const job = await getRelayJob(id, exec);
      if (!job) return { ok: false, code: 'runner_offline', message: 'relay job not found' };
      if (opts.onPartialText && job.kind === 'chat') {
        const partial = (job.result as { partialText?: string } | null)?.partialText ?? '';
        if (partial.length > seenPartial.length && partial.startsWith(seenPartial)) {
          opts.onPartialText(partial.slice(seenPartial.length));
          seenPartial = partial;
        }
      }
      if (job.status === 'done' && job.result) return { ok: true, result: job.result };
      if (isTerminalRelayStatus(job.status)) {
        const code: RelayErrorCode = job.error?.code ?? (job.status === 'expired' ? 'runner_offline' : job.status === 'cancelled' ? 'cancelled' : 'bad_result');
        return { ok: false, code, message: job.error?.message ?? `relay job ${job.status}` };
      }
      if (now() >= opts.deadlineAt.getTime()) {
        await cancelRelayJob(id, exec).catch(() => false);
        return { ok: false, code: 'runner_offline', message: 'no runner answered before the deadline' };
      }
      await sleep(pollMs);
    }
  } catch (err) {
    return { ok: false, code: 'runner_offline', message: err instanceof Error ? err.message : String(err) };
  }
}

// ── Sweep ────────────────────────────────────────────────────────────────────

export interface SweepRelayJobsOptions {
  retentionMs?: number;
}

export interface SweepRelayJobsResult {
  expired: number;
  requeued: number;
  lost: number;
  pruned: number;
}

/**
 * Expiry and retention (§3.5, AC-5..AC-8), run on every claim and from the
 * maintenance cron. Order matters: a job past its deadline is `expired`
 * whatever its lease says; then a lapsed lease with attempts left is queued
 * again with backoff (attempts unchanged until the next lease); then a lapsed
 * lease with none left is `failed` with `lease_lost`; then old terminal rows go.
 */
export async function sweepRelayJobs(opts: SweepRelayJobsOptions = {}, exec: RelayExec = dbExec): Promise<SweepRelayJobsResult> {
  const retentionSecs = (opts.retentionMs ?? RELAY_DEFAULTS.retentionMs) / 1000;
  const offline: RelayJobError = { code: 'runner_offline', message: 'no runner claimed the job before its deadline' };
  const lost: RelayJobError = { code: 'lease_lost', message: 'the runner stopped reporting while holding the job' };

  const expiredRows = rowsOf(await exec(sql`-- relay:sweep_expire
UPDATE model_relay_jobs
SET status = 'expired',
    error = CASE WHEN status = 'leased' THEN ${JSON.stringify(lost)}::jsonb ELSE ${JSON.stringify(offline)}::jsonb END,
    lease_owner = NULL, lease_expires_at = NULL, finished_at = now()
WHERE status IN ('queued', 'leased') AND deadline_at <= now()
RETURNING team_id, runner_id, kind, model`));

  const requeuedRows = rowsOf(await exec(sql`-- relay:sweep_requeue
UPDATE model_relay_jobs
SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
    not_before = now() + make_interval(secs => (power(2, attempts) * ${RELAY_DEFAULTS.backoffBaseMs / 1000}::double precision))
WHERE status = 'leased' AND lease_expires_at < now() AND attempts < max_attempts AND deadline_at > now()
RETURNING id`));

  const lostRows = rowsOf(await exec(sql`-- relay:sweep_lost
UPDATE model_relay_jobs
SET status = 'failed', error = ${JSON.stringify(lost)}::jsonb, lease_owner = NULL, lease_expires_at = NULL, finished_at = now()
WHERE status = 'leased' AND lease_expires_at < now() AND attempts >= max_attempts
RETURNING team_id, runner_id, kind, model`));

  const prunedRows = rowsOf(await exec(sql`-- relay:sweep_prune
DELETE FROM model_relay_jobs
WHERE status IN ('done', 'failed', 'expired', 'cancelled') AND finished_at < now() - make_interval(secs => ${retentionSecs}::double precision)
RETURNING 1 AS gone`));

  for (const row of [...expiredRows, ...lostRows]) {
    await recordRelayUsage({ teamId: String(row.team_id), runnerId: row.runner_id ? String(row.runner_id) : null, kind: String(row.kind) as RelayJobKind, model: String(row.model), error: true, result: null }, exec);
  }
  return { expired: expiredRows.length, requeued: requeuedRows.length, lost: lostRows.length, pruned: prunedRows.length };
}

// ── Ledger ───────────────────────────────────────────────────────────────────

export interface RelayUsageIncrement {
  teamId: string;
  /** Null when the runner's heartbeat row is gone; such a job is not attributed. */
  runnerId: string | null;
  kind: RelayJobKind;
  model: string;
  error: boolean;
  result: RelayJobResult | null;
}

/** One increment of `model_relay_usage_daily` (§3.4): counts and durations, never content. Best-effort. */
export async function recordRelayUsage(inc: RelayUsageIncrement, exec: RelayExec = dbExec): Promise<void> {
  if (!inc.runnerId) return;
  const r = (inc.result ?? {}) as Record<string, unknown>;
  const usage = (r.usage ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  const promptTokens = n(r.promptTokens) || n(usage.promptTokens);
  const completionTokens = n(usage.completionTokens);
  const durationMs = n(r.durationMs);
  try {
    await exec(sql`-- relay:usage
INSERT INTO model_relay_usage_daily (day, team_id, runner_id, kind, model, jobs, errors, prompt_tokens, completion_tokens, duration_ms)
VALUES (CURRENT_DATE, ${inc.teamId}::uuid, ${inc.runnerId}::uuid, ${inc.kind}::text, ${inc.model}::text, 1, ${inc.error ? 1 : 0}::int, ${promptTokens}::bigint, ${completionTokens}::bigint, ${durationMs}::bigint)
ON CONFLICT (day, team_id, runner_id, kind, model) DO UPDATE SET
  jobs = model_relay_usage_daily.jobs + 1,
  errors = model_relay_usage_daily.errors + EXCLUDED.errors,
  prompt_tokens = model_relay_usage_daily.prompt_tokens + EXCLUDED.prompt_tokens,
  completion_tokens = model_relay_usage_daily.completion_tokens + EXCLUDED.completion_tokens,
  duration_ms = model_relay_usage_daily.duration_ms + EXCLUDED.duration_ms`);
  } catch (err) {
    console.warn('[model-relay] usage ledger write failed:', err instanceof Error ? err.message : err);
  }
}
