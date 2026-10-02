/**
 * BYO evidence writers (runner side).
 * Spec: docs/specs/byo-evidence-storage.md — "What gets written", "Redaction".
 *
 *   - `command_output`: a Bash tool_result with `is_error === true`. The FULL
 *     output (not the 500-char trace excerpt) is kept.
 *   - `test_report`: `.test-report.log` in the session cwd at session end.
 *
 * Each body is redacted on the WHOLE text with the worker's `createSecretRedactor`
 * (exact values from every claim-delivered secret channel + generic credential
 * patterns), gzipped, and PUT to a presigned URL the server signs. The runner
 * holds no storage credentials and never chooses the object key.
 *
 * NOT `redactSecretsInBody`: that runs generic patterns on an allowlist of
 * structured fields, which is right for transcript records and wrong for a raw log.
 *
 * Every path is best-effort. Nothing here throws into the session lifecycle or
 * touches worker/task status — a storage failure never fails a task.
 */

import { gzipSync } from 'node:zlib';
// Namespace import on purpose: several runner test files mock.module('node:fs')
// with a partial surface, and a named import of a missing export is a load-time
// SyntaxError for every file that imports workers.ts.
import * as fs from 'node:fs';
import { join } from 'node:path';
import { sessionLog } from './session-logger';

export type EvidenceKind = 'command_output' | 'test_report';
export type EvidenceOutcome = 'uploaded' | 'skipped' | 'failed';

export interface EvidenceUploadRequest {
  kind: EvidenceKind;
  seq: number;
  /** Exact byte length of the gzipped body that will be PUT. */
  sizeBytes: number;
}

type SignedUpload = { uploadUrl: string; key: string; evidenceId?: string };

export interface EvidenceUploadDeps {
  /**
   * Ask the coordination API for a presigned PUT. `null` = the server declined
   * (no backend, over the per-task budget, sensitive) — a quiet skip. Optional so
   * a client without the method yet simply writes nothing.
   */
  requestEvidenceUploadUrl?: (
    workerId: string,
    req: EvidenceUploadRequest,
  ) => Promise<{ uploadUrl: string; key: string; evidenceId?: string } | null>;
  /**
   * Tell the server the PUT landed so it can HEAD the object and mark the row
   * `stored` (until then the read routes refuse it). Called only after a 2xx PUT;
   * best-effort. Optional so an older client simply skips it (the server's
   * reaper settles the row later).
   */
  confirmEvidenceUpload?: (workerId: string, evidenceId: string) => Promise<unknown>;
  put?: (url: string, body: Uint8Array, contentType: string, contentLength: number) => Promise<boolean>;
  log?: typeof sessionLog;
  /** Pause before the one retry of a failed upload (default 2 s; tests pass 0). */
  retryDelayMs?: number;
}

/** Session-cwd-relative paths checked, in order, for a test report at session end. */
export const TEST_REPORT_PATHS = ['.test-report.log'] as const;

/** Ceiling on the gzipped body. A longer text is cut to head and tail until it fits. */
export const MAX_EVIDENCE_GZ_BYTES = 8 * 1024 * 1024; // 8 MiB

/** Ceiling on raw text read/redacted. A longer input keeps its head and tail. */
export const MAX_EVIDENCE_RAW_BYTES = 32 * 1024 * 1024; // 32 MiB

/** Share of a truncated text's budget given to the head; the rest is tail, where failures usually are. */
const HEAD_SHARE = 0.25;

/** Pause before the single retry of a failed upload. */
const RETRY_DELAY_MS = 2000;

/** Attempts to shrink an incompressible text under the gzip ceiling before giving up. */
const MAX_SHRINK_PASSES = 4;

const CONTENT_TYPE = 'application/gzip';

// ─── Secret channels ─────────────────────────────────────────────────────────

/**
 * Every field of the runner's claim payload (`startFromClaim`'s `claimedWorker`),
 * classified. `evidence-writer.test.ts` parses that type and fails on any field
 * missing here, so a new claim-delivered secret cannot land without a decision —
 * and every `secret` entry must reach `buildWorkerSecretValues`.
 */
export const CLAIM_FIELD_SECRET_CLASSIFICATION: Record<string, 'secret' | 'not_secret'> = {
  id: 'not_secret',
  branch: 'not_secret',
  task: 'not_secret',
  serverApiKey: 'secret',
  serverOauthToken: 'secret',
  claudeAccessToken: 'secret',
  claudeTokenExpiresAt: 'not_secret',
  // Scope names (e.g. user:inference), not a credential.
  claudeTokenScopes: 'not_secret',
  claudeAiArtifacts: 'not_secret',
  mcpSecrets: 'secret',
  // Resolved connector descriptors; credential values arrive via mcpSecrets.
  mcpConnectors: 'not_secret',
  codexCredential: 'secret',
  // Team agent model endpoint: authToken is a credential the agent env carries.
  modelEndpoint: 'secret',
  modelEndpointIgnored: 'not_secret',
  roleConfig: 'not_secret',
  roleInstructions: 'not_secret',
  roleEnvSecrets: 'secret',
  roleEnvMissing: 'not_secret',
  skillBundles: 'not_secret',
  cbmExperiment: 'not_secret',
  questionGate: 'not_secret',
};

export interface WorkerSecretChannels {
  mcpSecrets?: Record<string, string>;
  roleEnvSecrets?: Record<string, string>;
  serverApiKey?: string;
  serverOauthToken?: string;
  claudeAccessToken?: string;
  codexCredential?: {
    accessToken?: string;
    refreshToken?: string;
    idToken?: string;
    apiKey?: string;
    [k: string]: unknown;
  };
  modelEndpoint?: { authToken?: string; [k: string]: unknown };
}

/**
 * The exact-value list for a worker's `createSecretRedactor`. Single source for
 * the per-worker redactor in `startSession` and therefore for evidence bodies.
 */
export function buildWorkerSecretValues(
  runnerApiKey: string | undefined,
  worker: WorkerSecretChannels,
): Array<{ label: string; value: string }> {
  const cx = worker.codexCredential;
  return [
    { label: 'BUILDD_API_KEY', value: runnerApiKey },
    ...Object.entries(worker.mcpSecrets ?? {}).map(([label, value]) => ({ label, value })),
    ...Object.entries(worker.roleEnvSecrets ?? {}).map(([label, value]) => ({ label, value })),
    { label: 'serverApiKey', value: worker.serverApiKey },
    { label: 'serverOauthToken', value: worker.serverOauthToken },
    { label: 'claudeAccessToken', value: worker.claudeAccessToken },
    { label: 'codexAccessToken', value: cx?.accessToken },
    { label: 'codexRefreshToken', value: cx?.refreshToken },
    { label: 'codexIdToken', value: cx?.idToken },
    { label: 'codexApiKey', value: cx?.apiKey },
    { label: 'modelEndpointAuthToken', value: worker.modelEndpoint?.authToken },
  ].filter((s): s is { label: string; value: string } => typeof s.value === 'string' && s.value.length > 0);
}

// ─── Upload ──────────────────────────────────────────────────────────────────

async function defaultPut(url: string, body: Uint8Array, contentType: string, contentLength: number): Promise<boolean> {
  const res = await fetch(url, {
    method: 'PUT',
    body,
    headers: {
      'Content-Type': contentType,
      // Must match the signed ContentLength exactly.
      'Content-Length': String(contentLength),
    },
  });
  return res.ok;
}

export interface HeadTail {
  text: string;
  omittedBytes: number;
}

/**
 * Keep the head and the tail of `text` within `maxBytes` and drop the middle,
 * leaving a one-line marker where it was. Cuts land on line boundaries when
 * there is one nearby, so a credential on its own line is never sliced in half
 * (the redactor matches whole values).
 */
export function headAndTail(text: string, maxBytes: number): HeadTail {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, omittedBytes: 0 };
  const budget = Math.max(0, maxBytes - 128); // room for the marker
  let headEnd = Math.floor(budget * HEAD_SHARE);
  let tailStart = buf.length - (budget - headEnd);
  const lastNl = buf.lastIndexOf(0x0a, headEnd);
  if (lastNl > 0) headEnd = lastNl + 1;
  const nextNl = buf.indexOf(0x0a, tailStart);
  if (nextNl !== -1 && nextNl + 1 < buf.length) tailStart = nextNl + 1;
  const omittedBytes = Math.max(0, tailStart - headEnd);
  const marker = `\n[... ${omittedBytes} bytes omitted by the buildd evidence writer (size cap) ...]\n`;
  return {
    text: buf.subarray(0, headEnd).toString('utf8') + marker + buf.subarray(tailStart).toString('utf8'),
    omittedBytes,
  };
}

/** Read a file whole when it fits, else its head and tail (line-aligned) with a marker for the gap. */
function readHeadAndTail(fd: number, size: number, maxBytes: number): string {
  if (size <= maxBytes) {
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 0);
    return buf.toString('utf8');
  }
  const budget = maxBytes - 256;
  const headLen = Math.floor(budget * HEAD_SHARE);
  const tailLen = budget - headLen;
  const head = Buffer.alloc(headLen);
  const tail = Buffer.alloc(tailLen);
  fs.readSync(fd, head, 0, headLen, 0);
  fs.readSync(fd, tail, 0, tailLen, size - tailLen);
  const lastNl = head.lastIndexOf(0x0a);
  const headEnd = lastNl > 0 ? lastNl + 1 : head.length;
  const nextNl = tail.indexOf(0x0a);
  const tailStart = nextNl !== -1 && nextNl + 1 < tail.length ? nextNl + 1 : 0;
  const omitted = size - headEnd - (tail.length - tailStart);
  const marker = `\n[... ${omitted} bytes omitted by the buildd evidence writer (size cap) ...]\n`;
  return head.subarray(0, headEnd).toString('utf8') + marker + tail.subarray(tailStart).toString('utf8');
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export interface EvidenceWriterOptions {
  workerId: string;
  taskId?: string;
  /** The worker's `createSecretRedactor` instance. Applied to the whole text. */
  redact: (text: string) => string;
  deps: EvidenceUploadDeps;
}

/** Per-worker evidence writer. Owns the object sequence number. Never throws. */
export class EvidenceWriter {
  private seq = 0;
  private pending: Promise<EvidenceOutcome>[] = [];

  constructor(private readonly opts: EvidenceWriterOptions) {}

  /**
   * Hook for the runner's tool_result branch. Fire-and-forget: the upload runs in
   * the background (awaited by `drain()` at session end), so the message loop is
   * never blocked on storage.
   */
  onToolResult(result: { source: string | undefined; isError: boolean; text: string }): void {
    try {
      if (result.isError !== true || result.source !== 'Bash' || !result.text) return;
      this.pending.push(this.write('command_output', result.text));
    } catch {
      // best-effort
    }
  }

  /** Write the session's test report, if one exists in `cwd`. Never throws. */
  async writeTestReport(cwd: string | undefined): Promise<EvidenceOutcome> {
    try {
      if (!cwd) return 'skipped';
      for (const rel of TEST_REPORT_PATHS) {
        const path = join(cwd, rel);
        if (!fs.existsSync(path)) continue;
        const st = fs.statSync(path);
        if (!st.isFile() || st.size === 0) continue;
        const fd = fs.openSync(path, 'r');
        let text: string;
        try {
          text = readHeadAndTail(fd, st.size, MAX_EVIDENCE_RAW_BYTES);
        } finally {
          fs.closeSync(fd);
        }
        return await this.write('test_report', text);
      }
      return 'skipped';
    } catch (err) {
      this.warn('test_report', err);
      return 'failed';
    }
  }

  /**
   * Start the test-report write without awaiting it. The file is read (and
   * redacted) synchronously inside this call, so the caller may remove the
   * worktree immediately afterwards; `drain()` awaits the upload.
   */
  queueTestReport(cwd: string | undefined): void {
    try {
      this.pending.push(this.writeTestReport(cwd));
    } catch {
      // best-effort
    }
  }

  /** Await every in-flight upload. Never rejects. */
  async drain(): Promise<EvidenceOutcome[]> {
    const all = this.pending;
    this.pending = [];
    return Promise.all(all.map(p => p.catch((): EvidenceOutcome => 'failed')));
  }

  private async write(kind: EvidenceKind, raw: string): Promise<EvidenceOutcome> {
    const seq = this.seq++;
    const { workerId, taskId, deps } = this.opts;
    const log = deps.log ?? sessionLog;
    try {
      // Cut, then redact the cut text: no unredacted body exists past this
      // line, and cuts fall on line boundaries so the redactor sees whole values.
      const capped = headAndTail(raw, MAX_EVIDENCE_RAW_BYTES);
      let omittedBytes = capped.omittedBytes;
      let text = this.opts.redact(capped.text);
      let body = new Uint8Array(gzipSync(Buffer.from(text, 'utf8')));
      // Incompressible text can still be over the ceiling: shrink by the overshoot.
      for (let pass = 0; pass < MAX_SHRINK_PASSES && body.byteLength > MAX_EVIDENCE_GZ_BYTES; pass++) {
        const budget = Math.floor(Buffer.byteLength(text) * (MAX_EVIDENCE_GZ_BYTES / body.byteLength) * 0.9);
        const shrunk = headAndTail(text, budget);
        omittedBytes += shrunk.omittedBytes;
        text = shrunk.text;
        body = new Uint8Array(gzipSync(Buffer.from(text, 'utf8')));
      }
      const sizeBytes = body.byteLength;
      if (sizeBytes <= 0 || sizeBytes > MAX_EVIDENCE_GZ_BYTES) {
        log(workerId, 'info', 'evidence_skipped', `kind=${kind} seq=${seq} bytes=${sizeBytes} over cap`, taskId);
        return 'skipped';
      }
      if (omittedBytes > 0) {
        log(workerId, 'info', 'evidence_truncated', `kind=${kind} seq=${seq} omitted=${omittedBytes} (head and tail kept)`, taskId);
      }
      if (typeof deps.requestEvidenceUploadUrl !== 'function') return 'skipped';

      let attempt = await this.uploadOnce(kind, seq, body, sizeBytes);
      if (attempt.state === 'failed') {
        // One retry, reusing the presigned URL when we have one (valid 15 min).
        await sleep(deps.retryDelayMs ?? RETRY_DELAY_MS);
        attempt = await this.uploadOnce(kind, seq, body, sizeBytes, attempt.signed);
      }
      if (attempt.state === 'declined') {
        log(workerId, 'info', 'evidence_declined', `kind=${kind} seq=${seq}`, taskId);
        return 'skipped';
      }
      if (attempt.state === 'failed') return 'failed';
      log(workerId, 'info', 'evidence_upload', `kind=${kind} seq=${seq} key=${attempt.signed!.key} bytes=${sizeBytes}`, taskId);
      await this.confirm(kind, seq, attempt.signed!.evidenceId);
      return 'uploaded';
    } catch (err) {
      this.warn(kind, err, seq);
      return 'failed';
    }
  }

  /** One request-URL-then-PUT attempt. A thrown error or a rejected PUT is `failed`; a null URL is `declined`. */
  private async uploadOnce(
    kind: EvidenceKind,
    seq: number,
    body: Uint8Array,
    sizeBytes: number,
    signedIn?: SignedUpload,
  ): Promise<{ state: 'ok' | 'declined' | 'failed'; signed?: SignedUpload }> {
    const { workerId, taskId, deps } = this.opts;
    let signed = signedIn;
    try {
      if (!signed) {
        const res = await deps.requestEvidenceUploadUrl!(workerId, { kind, seq, sizeBytes });
        if (!res?.uploadUrl) return { state: 'declined' };
        signed = res;
      }
      const ok = await (deps.put ?? defaultPut)(signed.uploadUrl, body, CONTENT_TYPE, sizeBytes);
      if (!ok) {
        (deps.log ?? sessionLog)(workerId, 'warn', 'evidence_upload_failed', `kind=${kind} seq=${seq} put rejected`, taskId);
        return { state: 'failed', signed };
      }
      return { state: 'ok', signed };
    } catch (err) {
      this.warn(kind, err, seq);
      return { state: 'failed', signed };
    }
  }

  /** Best-effort: the object is already in the bucket, so a failed confirm is only logged. */
  private async confirm(kind: EvidenceKind, seq: number, evidenceId: string | undefined): Promise<void> {
    const { workerId, taskId, deps } = this.opts;
    if (!evidenceId || typeof deps.confirmEvidenceUpload !== 'function') return;
    try {
      const ok = await deps.confirmEvidenceUpload(workerId, evidenceId);
      if (!ok) (deps.log ?? sessionLog)(workerId, 'warn', 'evidence_confirm_failed', `kind=${kind} seq=${seq} evidence=${evidenceId}`, taskId);
    } catch (err) {
      this.warn(kind, err, seq, 'evidence_confirm_failed');
    }
  }

  private warn(kind: EvidenceKind, err: unknown, seq?: number, event = 'evidence_upload_failed'): void {
    try {
      let msg = err instanceof Error ? err.message : 'unknown error';
      try { msg = this.opts.redact(msg); } catch { msg = 'unknown error'; }
      (this.opts.deps.log ?? sessionLog)(
        this.opts.workerId,
        'warn',
        event,
        `kind=${kind}${seq === undefined ? '' : ` seq=${seq}`} ${msg}`,
        this.opts.taskId,
      );
    } catch {
      // logging is best-effort too
    }
  }
}
