/**
 * Durable session diagnostics.
 *
 * Two problems this module exists to fix:
 *
 *  1. **SDK stderr was never filed.** The `stderr` callback passed to `query()`
 *     only `console.log`ged, so the bytes landed in the runner's screen buffer and
 *     died with it. Nothing reached the per-worker session log, and the flush that
 *     turns stderr into a `worker_error_traces` row sat on a failure branch that a
 *     hung or silent-start session never reaches. Result: a worker that dies before
 *     its first turn leaves `sessionId: null`, empty messages, and no explanation
 *     on either side. `SessionStderrCollector` files every chunk into the session
 *     log the moment it arrives, and `flushStderrTrace` is safe to call on *every*
 *     session end (and mid-flight — `worker-sync` drains `pendingErrorTraces` on its
 *     periodic PATCH, which is the only channel a truly hung session ever gets).
 *
 *  2. **Transcripts were runner-local and deleted in ~36h.** For healthy workers the
 *     runner state JSON holds a real transcript the server never sees. This module
 *     serialises it as JSONL and ships it straight to object storage through a
 *     server-signed URL. Bytes never transit the coordination API and the runner
 *     holds no storage credentials.
 *
 * Security invariants owned HERE (runner-side):
 *   - Secrets are redacted with `redactSecretsInBody` before the upload body exists.
 *     Bypassing the API for the bytes means the server can no longer scrub them, so
 *     this is the only place it can happen.
 *   - Bodies are bounded (`MAX_TRANSCRIPT_BYTES`) and their exact length is declared
 *     to the signer, which binds it into the signature.
 *   - Every path is best-effort: nothing here throws into the session lifecycle.
 *
 * Invariants owned by the server (see apps/web/src/app/api/workers/[id]/session-upload-url):
 *   key derivation, ownership/team authorization, sensitive-workspace refusal,
 *   ContentLength-constrained signature, write-once.
 */

import { redactSecretsInBody, type SecretRedactionValue } from '@buildd/core/redaction';
import { sessionLog, readSessionLogs, type SessionLogEntry } from './session-logger';
import { VERIFICATION_EXCERPT_BYTES } from './runner-verification';

/** Mirrors the (unexported) SecretInput of @buildd/core/redaction. */
export type SecretInput = string | SecretRedactionValue;

/**
 * Per-stream cap for captured stderr, matching the runner's existing excerpt
 * convention (`VERIFICATION_EXCERPT_BYTES`) scaled to a whole stream. A chatty
 * session cannot exhaust memory or fill the log directory: once the cap is hit we
 * stop buffering *and* stop writing.
 */
export const MAX_SESSION_STDERR_BYTES = 16 * VERIFICATION_EXCERPT_BYTES; // 64 KiB

/** Per-chunk cap, so one enormous write cannot blow the whole budget in one line. */
export const MAX_STDERR_CHUNK_BYTES = VERIFICATION_EXCERPT_BYTES;

/** The workers PATCH route clamps trace excerpts to 500 chars; match it at source. */
export const STDERR_TRACE_EXCERPT_BYTES = 500;

/** Upload ceiling for a transcript body. Must not exceed the server's ceiling. */
export const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024; // 8 MiB

const STEERING_CRASH_MARKER = '--session-id can only be used with';

// ─── 1. Stderr capture ───────────────────────────────────────────────────────

/**
 * Collects SDK stderr, filing each chunk into the per-worker session log as it
 * arrives so the bytes survive the process. Bounded in both memory and disk writes.
 */
export class SessionStderrCollector {
  private readonly lines: string[] = [];
  private bytes = 0;
  private flushedBytes = 0;
  /** True once the byte cap was reached and further output is being dropped. */
  truncated = false;

  constructor(
    private readonly workerId: string,
    private readonly taskId?: string,
    private readonly log: typeof sessionLog = sessionLog,
  ) {}

  push(chunk: string): void {
    if (this.truncated) return;
    const trimmed = (chunk ?? '').trim();
    if (!trimmed) return;

    let text = trimmed.length > MAX_STDERR_CHUNK_BYTES ? trimmed.slice(0, MAX_STDERR_CHUNK_BYTES) : trimmed;
    const remaining = MAX_SESSION_STDERR_BYTES - this.bytes;
    if (remaining <= 0) {
      this.markTruncated();
      return;
    }
    let hitCap = false;
    if (Buffer.byteLength(text) > remaining) {
      text = text.slice(0, remaining);
      hitCap = true;
    }

    this.lines.push(text);
    this.bytes += Buffer.byteLength(text);
    this.log(this.workerId, 'error', 'session_stderr', text, this.taskId);
    if (hitCap) this.markTruncated();
  }

  private markTruncated(): void {
    if (this.truncated) return;
    this.truncated = true;
    this.log(
      this.workerId,
      'warn',
      'session_stderr_truncated',
      `stderr capped at ${MAX_SESSION_STDERR_BYTES} bytes`,
      this.taskId,
    );
  }

  get isEmpty(): boolean {
    return this.lines.length === 0;
  }

  get byteLength(): number {
    return this.bytes;
  }

  get lineCount(): number {
    return this.lines.length;
  }

  text(): string {
    return this.lines.join('\n');
  }

  /**
   * The CLI rejected a malformed spawn invocation (`--session-id` without
   * `--fork-session`). Classified as infra failure so it never consumes a retry.
   */
  get isSteeringDeliveryCrash(): boolean {
    return this.text().includes(STEERING_CRASH_MARKER);
  }

  /** True when stderr has arrived that no error trace has carried yet. */
  hasUnflushed(): boolean {
    return this.bytes > this.flushedBytes;
  }

  markFlushed(): void {
    this.flushedBytes = this.bytes;
  }
}

export interface StderrErrorTrace {
  pattern: string;
  excerpt: string;
  source: string;
}

/**
 * Append the collector's stderr to `worker.pendingErrorTraces` so it reaches
 * `worker_error_traces` on the next PATCH (terminal or periodic sync).
 *
 * Idempotent: returns null when there is nothing new since the last flush, so it
 * is safe to call on every session end — normal, failed, aborted — and mid-flight.
 */
export function flushStderrTrace(
  worker: { pendingErrorTraces?: Array<{ pattern: string; excerpt: string; source?: string }> },
  collector: SessionStderrCollector,
): StderrErrorTrace | null {
  if (collector.isEmpty || !collector.hasUnflushed()) return null;

  const text = collector.text();
  const trace: StderrErrorTrace = {
    pattern: text.includes(STEERING_CRASH_MARKER) ? 'cli_spawn_error' : 'cli_stderr',
    excerpt: text.slice(0, STDERR_TRACE_EXCERPT_BYTES),
    source: 'stderr',
  };

  worker.pendingErrorTraces ??= [];
  worker.pendingErrorTraces.push(trace);
  collector.markFlushed();
  return trace;
}

// ─── 2. Transcript serialisation ─────────────────────────────────────────────

/** Minimal structural view of a LocalWorker — keeps this module test-friendly. */
export interface TranscriptWorker {
  id: string;
  taskId?: string;
  taskTitle?: string;
  taskMode?: string;
  taskBackend?: string;
  workspaceId?: string;
  status?: string;
  error?: string;
  sessionId?: string;
  codexThreadId?: string;
  startedAt?: number;
  completedAt?: number;
  lastActivity?: number;
  branch?: string;
  tokenTally?: { inputTokens: number; outputTokens: number };
  /** Loosely typed so LocalWorker's `ResultMeta` interface assigns without a cast. */
  resultMeta?: unknown;
  messages?: unknown[];
  toolCalls?: unknown[];
  output?: string[];
  milestones?: unknown[];
  /** Present on synthetic/legacy shapes; real LocalWorker derives these from resultMeta. */
  turns?: number;
  costUsd?: number;
}

function redactLine(record: Record<string, unknown>, secrets: SecretInput[]): string {
  return JSON.stringify(redactSecretsInBody(record, secrets));
}

/**
 * Serialise a worker session as JSONL. Line 1 is always a `session` header — a
 * silent-start worker that produced zero turns still yields a usable object
 * carrying its stderr, which is the entire point.
 *
 * Every string in the output passes through `redactSecretsInBody` first: after the
 * bytes leave for object storage the server can no longer scrub them.
 */
export function buildSessionTranscript(
  worker: TranscriptWorker,
  secrets: SecretInput[],
  stderr?: string,
): string {
  const meta = (worker.resultMeta ?? {}) as Record<string, unknown>;
  const header: Record<string, unknown> = {
    type: 'session',
    workerId: worker.id,
    taskId: worker.taskId ?? null,
    taskTitle: worker.taskTitle ?? null,
    taskMode: worker.taskMode ?? null,
    backend: worker.taskBackend ?? 'claude',
    workspaceId: worker.workspaceId ?? null,
    branch: worker.branch ?? null,
    status: worker.status ?? null,
    error: worker.error ?? null,
    // sessionId === null is itself a diagnosis: the SDK never emitted its init event.
    sessionId: worker.sessionId ?? worker.codexThreadId ?? null,
    turns: worker.turns ?? (typeof meta.numTurns === 'number' ? meta.numTurns : 0),
    costUsd: worker.costUsd ?? (typeof meta.totalCostUsd === 'number' ? meta.totalCostUsd : 0),
    inputTokens: worker.tokenTally?.inputTokens ?? 0,
    outputTokens: worker.tokenTally?.outputTokens ?? 0,
    startedAt: worker.startedAt ?? null,
    completedAt: worker.completedAt ?? null,
    lastActivity: worker.lastActivity ?? null,
    messageCount: worker.messages?.length ?? 0,
    toolCallCount: worker.toolCalls?.length ?? 0,
    stderr: stderr && stderr.length > 0 ? stderr : null,
    schemaVersion: 1,
  };

  const lines: string[] = [redactLine(header, secrets)];
  let bytes = Buffer.byteLength(lines[0]) + 1;
  const marker = JSON.stringify({ type: 'truncated', reason: 'transcript_size_cap' });
  const budget = MAX_TRANSCRIPT_BYTES - (Buffer.byteLength(marker) + 1);

  const append = (record: Record<string, unknown>): boolean => {
    const line = redactLine(record, secrets);
    const size = Buffer.byteLength(line) + 1;
    if (bytes + size > budget) return false;
    lines.push(line);
    bytes += size;
    return true;
  };

  let truncated = false;
  const emit = (records: Iterable<Record<string, unknown>>) => {
    if (truncated) return;
    for (const record of records) {
      if (!append(record)) {
        truncated = true;
        return;
      }
    }
  };

  emit((worker.milestones ?? []).map((m, i) => ({ type: 'milestone', seq: i, milestone: m })));
  emit((worker.messages ?? []).map((m, i) => ({ type: 'message', seq: i, message: m })));
  emit((worker.toolCalls ?? []).map((t, i) => ({ type: 'tool_call', seq: i, toolCall: t })));
  emit((worker.output ?? []).map((line, i) => ({ type: 'output', seq: i, line })));

  if (truncated) lines.push(marker);
  return lines.join('\n') + '\n';
}

/** Serialise session log entries as JSONL, redacted. Empty string when none. */
export function buildSessionLogBody(entries: SessionLogEntry[], secrets: SecretInput[]): string {
  if (!entries || entries.length === 0) return '';
  const lines: string[] = [];
  let bytes = 0;
  for (const entry of entries) {
    const line = redactLine(entry as unknown as Record<string, unknown>, secrets);
    const size = Buffer.byteLength(line) + 1;
    if (bytes + size > MAX_TRANSCRIPT_BYTES) break;
    lines.push(line);
    bytes += size;
  }
  return lines.join('\n') + '\n';
}

// ─── 3. Upload ───────────────────────────────────────────────────────────────

export type SessionArtifactKind = 'transcript' | 'session-log';
export type UploadOutcome = 'uploaded' | 'skipped' | 'failed';

export interface SessionUploadDeps {
  /**
   * Ask the coordination API for a presigned PUT. Returns null when the server
   * declines (storage unconfigured, sensitive workspace, already uploaded) — a
   * refusal, not an error. The runner never sees storage credentials.
   */
  requestUploadUrl(
    workerId: string,
    kind: SessionArtifactKind,
    sizeBytes: number,
  ): Promise<{ uploadUrl: string; storageKey: string } | null>;
  put?(url: string, body: string, contentType: string, contentLength: number): Promise<boolean>;
  readLog?(workerId: string, maxLines?: number): SessionLogEntry[];
  log?: typeof sessionLog;
}

const CONTENT_TYPE = 'application/x-ndjson';
const SESSION_LOG_MAX_LINES = 2000;

async function defaultPut(
  url: string,
  body: string,
  contentType: string,
  contentLength: number,
): Promise<boolean> {
  const res = await fetch(url, {
    method: 'PUT',
    body,
    headers: {
      'Content-Type': contentType,
      // Must match the signed ContentLength exactly or R2 rejects the request.
      'Content-Length': String(contentLength),
    },
  });
  return res.ok;
}

async function shipOne(
  workerId: string,
  taskId: string | undefined,
  kind: SessionArtifactKind,
  body: string,
  deps: SessionUploadDeps,
): Promise<UploadOutcome> {
  const log = deps.log ?? sessionLog;
  const put = deps.put ?? defaultPut;

  if (!body) return 'skipped';
  const sizeBytes = Buffer.byteLength(body);
  if (sizeBytes <= 0 || sizeBytes > MAX_TRANSCRIPT_BYTES) return 'skipped';

  try {
    const signed = await deps.requestUploadUrl(workerId, kind, sizeBytes);
    if (!signed?.uploadUrl) {
      log(workerId, 'info', 'session_upload_declined', `kind=${kind}`, taskId);
      return 'skipped';
    }
    const ok = await put(signed.uploadUrl, body, CONTENT_TYPE, sizeBytes);
    if (!ok) {
      log(workerId, 'warn', 'session_upload_failed', `kind=${kind} put rejected`, taskId);
      return 'failed';
    }
    log(workerId, 'info', 'session_upload', `kind=${kind} key=${signed.storageKey} bytes=${sizeBytes}`, taskId);
    return 'uploaded';
  } catch (err) {
    // Diagnostics must never introduce a task-failure path.
    const msg = err instanceof Error ? err.message : 'unknown error';
    log(workerId, 'warn', 'session_upload_failed', `kind=${kind} ${msg}`, taskId);
    return 'failed';
  }
}

/**
 * Ship the transcript and the session log for a finished worker. Never throws.
 * Returns per-kind outcomes purely for observability/tests.
 */
export async function uploadSessionDiagnostics(
  worker: TranscriptWorker,
  secrets: SecretInput[],
  deps: SessionUploadDeps,
  stderr?: string,
): Promise<{ transcript: UploadOutcome; sessionLog: UploadOutcome }> {
  const readLog = deps.readLog ?? readSessionLogs;

  let transcript: UploadOutcome = 'failed';
  try {
    transcript = await shipOne(
      worker.id,
      worker.taskId,
      'transcript',
      buildSessionTranscript(worker, secrets, stderr),
      deps,
    );
  } catch {
    transcript = 'failed';
  }

  let logOutcome: UploadOutcome = 'skipped';
  try {
    const entries = readLog(worker.id, SESSION_LOG_MAX_LINES);
    logOutcome = await shipOne(
      worker.id,
      worker.taskId,
      'session-log',
      buildSessionLogBody(entries, secrets),
      deps,
    );
  } catch {
    logOutcome = 'failed';
  }

  return { transcript, sessionLog: logOutcome };
}
