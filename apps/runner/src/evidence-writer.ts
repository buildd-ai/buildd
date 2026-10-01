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
}

/** Session-cwd-relative paths checked, in order, for a test report at session end. */
export const TEST_REPORT_PATHS = ['.test-report.log'] as const;

/** Ceiling on the gzipped body. Larger bodies are skipped, not truncated mid-stream. */
export const MAX_EVIDENCE_GZ_BYTES = 8 * 1024 * 1024; // 8 MiB

/** Ceiling on raw text read/redacted. Longer inputs keep their TAIL (where failures are). */
export const MAX_EVIDENCE_RAW_BYTES = 32 * 1024 * 1024; // 32 MiB

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
  mcpSecrets: 'secret',
  // Resolved connector descriptors; credential values arrive via mcpSecrets.
  mcpConnectors: 'not_secret',
  codexCredential: 'secret',
  roleConfig: 'not_secret',
  roleInstructions: 'not_secret',
  roleEnvSecrets: 'secret',
  roleEnvMissing: 'not_secret',
  skillBundles: 'not_secret',
  cbmExperiment: 'not_secret',
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

function tail(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const buf = Buffer.from(text);
  return buf.subarray(buf.length - maxBytes).toString('utf8');
}

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
        const len = Math.min(st.size, MAX_EVIDENCE_RAW_BYTES);
        const buf = Buffer.alloc(len);
        const fd = fs.openSync(path, 'r');
        try {
          fs.readSync(fd, buf, 0, len, st.size - len);
        } finally {
          fs.closeSync(fd);
        }
        return await this.write('test_report', buf.toString('utf8'));
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
      // Redact FIRST — no unredacted body exists past this line.
      const redacted = this.opts.redact(tail(raw, MAX_EVIDENCE_RAW_BYTES));
      const body = new Uint8Array(gzipSync(Buffer.from(redacted, 'utf8')));
      const sizeBytes = body.byteLength;
      if (sizeBytes <= 0 || sizeBytes > MAX_EVIDENCE_GZ_BYTES) {
        log(workerId, 'info', 'evidence_skipped', `kind=${kind} seq=${seq} bytes=${sizeBytes} over cap`, taskId);
        return 'skipped';
      }
      if (typeof deps.requestEvidenceUploadUrl !== 'function') return 'skipped';
      const signed = await deps.requestEvidenceUploadUrl(workerId, { kind, seq, sizeBytes });
      if (!signed?.uploadUrl) {
        log(workerId, 'info', 'evidence_declined', `kind=${kind} seq=${seq}`, taskId);
        return 'skipped';
      }
      const ok = await (deps.put ?? defaultPut)(signed.uploadUrl, body, CONTENT_TYPE, sizeBytes);
      if (!ok) {
        log(workerId, 'warn', 'evidence_upload_failed', `kind=${kind} seq=${seq} put rejected`, taskId);
        return 'failed';
      }
      log(workerId, 'info', 'evidence_upload', `kind=${kind} seq=${seq} key=${signed.key} bytes=${sizeBytes}`, taskId);
      await this.confirm(kind, seq, signed.evidenceId);
      return 'uploaded';
    } catch (err) {
      this.warn(kind, err, seq);
      return 'failed';
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
