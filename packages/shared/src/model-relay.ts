/**
 * Relay queue contract (docs/specs/local-runner-provider.md §3, §4): the job
 * kinds, statuses, payload and result shapes, error codes and defaults both
 * the server (`@buildd/core/model-relay`) and the runner's poller agree on.
 * Pure, client-safe.
 *
 * The server enqueues, the runner claims by outbound poll, computes against its
 * loopback Ollama and posts the result back. Nothing here carries a URL or a
 * credential: a job names a model tag and a payload, never where to run it.
 */

export const RELAY_JOB_KINDS = ['embed', 'chat'] as const;
export type RelayJobKind = (typeof RELAY_JOB_KINDS)[number];

/** Who asked, for metrics and claim order: a person waits on `chat`, a re-embed on nobody. */
export const RELAY_JOB_SURFACES = ['ingest', 'query', 'reembed', 'chat'] as const;
export type RelayJobSurface = (typeof RELAY_JOB_SURFACES)[number];

export const RELAY_JOB_STATUSES = ['queued', 'leased', 'done', 'failed', 'expired', 'cancelled'] as const;
export type RelayJobStatus = (typeof RELAY_JOB_STATUSES)[number];

export const RELAY_TERMINAL_STATUSES: readonly RelayJobStatus[] = ['done', 'failed', 'expired', 'cancelled'];

export function isTerminalRelayStatus(status: string): boolean {
  return (RELAY_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** Stored in `error.code` and surfaced to callers (spec §3.3). */
export const RELAY_ERROR_CODES = [
  'runner_offline',
  'lease_lost',
  'model_missing',
  'dimension_mismatch',
  'bad_result',
  'ollama_error',
  'timeout',
  'payload_too_large',
  'cancelled',
] as const;
export type RelayErrorCode = (typeof RELAY_ERROR_CODES)[number];

export function isRelayErrorCode(value: unknown): value is RelayErrorCode {
  return typeof value === 'string' && (RELAY_ERROR_CODES as readonly string[]).includes(value);
}

export interface RelayJobError {
  code: RelayErrorCode;
  message: string;
  /** Ollama's HTTP status for `ollama_error`; decides whether the job is retried. */
  httpStatus?: number;
}

/**
 * A failed result that may be tried again on the next lease: an upstream 5xx
 * or a runner-side timeout. A missing model, a wrong size, a bad result and
 * any 4xx are final (spec §4.2).
 */
export function isRetryableRelayError(error: Pick<RelayJobError, 'code' | 'httpStatus'>): boolean {
  if (error.code === 'timeout') return true;
  if (error.code === 'ollama_error') return error.httpStatus === undefined || error.httpStatus >= 500;
  return false;
}

// ── Payloads ─────────────────────────────────────────────────────────────────

export interface RelayEmbedPayload {
  inputs: string[];
  inputType: 'query' | 'document';
  /** The namespace's recorded size: the runner MUST refuse a result of another size. */
  dimensions: number;
}

export interface RelayChatPayload {
  /** The chat model layer's doGenerate input: messages and options, tools absent in v1. */
  messages: unknown[];
  options?: Record<string, unknown>;
}

export type RelayJobPayload = RelayEmbedPayload | RelayChatPayload;

export function isRelayEmbedPayload(payload: unknown): payload is RelayEmbedPayload {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  return Array.isArray(p.inputs) && p.inputs.every(i => typeof i === 'string')
    && (p.inputType === 'query' || p.inputType === 'document')
    && typeof p.dimensions === 'number' && Number.isSafeInteger(p.dimensions) && p.dimensions > 0;
}

export function isRelayChatPayload(payload: unknown): payload is RelayChatPayload {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  return Array.isArray(p.messages) && (p.options === undefined || (!!p.options && typeof p.options === 'object' && !Array.isArray(p.options)));
}

// ── Results ──────────────────────────────────────────────────────────────────

export interface RelayEmbedResult {
  vectors: number[][];
  dimensions: number;
  model: string;
  promptTokens?: number;
  durationMs?: number;
}

export interface RelayChatResult {
  text: string;
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number };
  durationMs?: number;
  /** Ollama's eval_count / eval_duration, tokens per second. */
  evalRate?: number;
  /** Appended by progress posts while the job runs. */
  partialText?: string;
}

export type RelayJobResult = RelayEmbedResult | RelayChatResult;

/**
 * Why an `embed` result cannot be stored, or null when every vector has
 * exactly `payload.dimensions` finite floats and there is one per input
 * (spec §3.2, AC-12). One bad vector fails the whole job.
 */
export function validateEmbedResult(payload: RelayEmbedPayload, result: unknown): RelayJobError | null {
  if (!result || typeof result !== 'object') return { code: 'bad_result', message: 'embed result is not an object' };
  const r = result as Record<string, unknown>;
  if (!Array.isArray(r.vectors)) return { code: 'bad_result', message: 'embed result has no vectors array' };
  if (r.vectors.length !== payload.inputs.length) {
    return { code: 'bad_result', message: `embed result has ${r.vectors.length} vectors for ${payload.inputs.length} inputs` };
  }
  if (typeof r.dimensions === 'number' && r.dimensions !== payload.dimensions) {
    return { code: 'dimension_mismatch', message: `runner reported ${r.dimensions} dimensions; the namespace is stored at ${payload.dimensions}` };
  }
  for (const [i, v] of r.vectors.entries()) {
    if (!Array.isArray(v)) return { code: 'bad_result', message: `vector ${i} is not an array` };
    if (v.length !== payload.dimensions) {
      return { code: 'dimension_mismatch', message: `vector ${i} has ${v.length} dimensions; the namespace is stored at ${payload.dimensions}` };
    }
    for (const x of v) {
      if (typeof x !== 'number' || !Number.isFinite(x)) return { code: 'bad_result', message: `vector ${i} holds a non-finite value` };
    }
  }
  return null;
}

export function validateChatResult(result: unknown): RelayJobError | null {
  if (!result || typeof result !== 'object') return { code: 'bad_result', message: 'chat result is not an object' };
  const r = result as Record<string, unknown>;
  if (typeof r.text !== 'string') return { code: 'bad_result', message: 'chat result has no text' };
  if (typeof r.finishReason !== 'string') return { code: 'bad_result', message: 'chat result has no finishReason' };
  return null;
}

// ── Defaults (tunable in this one place; spec §3, §4.1, §4.3) ────────────────

export const RELAY_DEFAULTS = {
  /** A lease a runner must renew by progress posts. */
  leaseMs: 60_000,
  /** Leases a job may consume before it is `lease_lost`. */
  maxAttempts: { embed: 2, chat: 1 } as Readonly<Record<RelayJobKind, number>>,
  /** The waiter's deadline per surface; after it the job is `expired`. */
  deadlineMs: { query: 20_000, ingest: 180_000, reembed: 300_000, chat: 300_000 } as Readonly<Record<RelayJobSurface, number>>,
  /** Terminal rows older than this are deleted by the sweep. */
  retentionMs: 24 * 60 * 60_000,
  /** A `chat` payload above this is refused at enqueue (`payload_too_large`). */
  chatPayloadMaxBytes: 1_000_000,
  /** How often a pinned relay host polls when no nudge arrives. */
  pollAfterMs: 15_000,
  /** The waiter's poll of the job row. */
  waitPollMs: 500,
  /** Jobs one claim hands out: one for a chat runner, a few for embed-only batches. */
  claimMax: { chat: 1, embed: 4 } as Readonly<Record<RelayJobKind, number>>,
  /** Retry backoff base: `not_before = now + 2^attempts * base`. */
  backoffBaseMs: 5_000,
} as const;

/** How long a job waits before its next lease after a lapsed one: 2^attempts × 5 s (spec §3.5). */
export function relayBackoffMs(attempts: number, baseMs: number = RELAY_DEFAULTS.backoffBaseMs): number {
  const n = Math.max(0, Math.min(16, Math.floor(attempts)));
  return 2 ** n * baseMs;
}

/** The byte size a payload takes as JSON; what the enqueue cap is measured in. */
export function relayPayloadBytes(payload: unknown): number {
  return new TextEncoder().encode(JSON.stringify(payload)).length;
}

// ── Wire shapes (the three routes, spec §4) ──────────────────────────────────

/** One job as the claim route hands it to a runner. */
export interface RelayClaimedJob {
  id: string;
  kind: RelayJobKind;
  model: string;
  payload: RelayJobPayload;
  deadlineAt: string;
  leaseExpiresAt: string;
  /** Echoed on every result and progress post; the server checks it against the lease. */
  leaseId: string;
}

export interface RelayClaimRequest {
  runnerId: string;
  /** What the runner's Ollama serves now: only jobs for these tags are handed out. */
  models: string[];
  max?: number;
}

export interface RelayClaimResponse {
  jobs: RelayClaimedJob[];
  /** 0 = stop polling: the pick was removed. */
  pollAfterMs: number;
}

export type RelayResultRequest =
  | { runnerId: string; leaseId: string; ok: true; result: RelayJobResult }
  | { runnerId: string; leaseId: string; ok: false; error: RelayJobError };

export interface RelayProgressRequest {
  runnerId: string;
  leaseId: string;
  partialText?: string;
}

/** The waiter's answer (spec §4.3): never thrown into ingest, a webhook or a chat stream. */
export type RelayAwaitOutcome =
  | { ok: true; result: RelayJobResult }
  | { ok: false; code: RelayErrorCode; message: string };
