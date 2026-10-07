/**
 * Run evidence for a runner-hosted Quality Scout run: the command log a
 * runner captured for a probe, stored as an evidence object instead of a
 * `file:` path on the runner's disk (artifact quality-scout-runner-host §4).
 *
 * Same storage contract as task-run evidence (docs/specs/byo-evidence-storage.md),
 * with the run in place of the task:
 *
 *  - Authority is the run's lease: only the key and lease id that hold the
 *    run's unexpired lease get an upload URL or confirm an upload, checked by
 *    the same `checkScoutRunLease` the probes and release routes use.
 *  - The backend is the workspace's resolved one (workspace → team →
 *    buildd_default). The runner gets a presigned PUT bound to one
 *    server-derived key and one byte length for 15 minutes, never a
 *    credential, bucket name or endpoint beyond what the URL carries.
 *  - The backend's `max_bytes_per_task` caps the run's objects in total
 *    (pending ones count, failed ones do not) — 413 past it.
 *  - A sensitive workspace writes only to a team-owned backend (403).
 *  - A storage or backend failure is a 424, never a 5xx: the runner keeps
 *    the bounded `observed` excerpt on the probe result and carries on.
 *  - Text is redacted when read (evidence-read.ts), like every object.
 *
 * Decisions here; SQL in quality-scout-run-evidence-store.ts.
 */
import type { ScoutRunEvidenceUploadResponse } from '@buildd/shared';
import type { ResolvedEvidenceBackend } from '@/lib/evidence-backend';
import { checkScoutRunLease, type ScoutHostCaller, type ScoutRunnerHostStore } from '@/lib/quality-scout-runner-host';
import type { ScoutRunEvidenceStore } from '@/lib/quality-scout-run-evidence-store';
import { buildScoutRunEvidenceObjectKey } from '@/lib/storage-keys';

/** Kinds a runner may write for a Scout run: a probe's command output, or a test report it produced. */
export const SCOUT_RUN_EVIDENCE_KINDS = {
  command_output: 'log',
  test_report: 'log',
} as const;
export type ScoutRunEvidenceKind = keyof typeof SCOUT_RUN_EVIDENCE_KINDS;

const isKind = (v: unknown): v is ScoutRunEvidenceKind =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(SCOUT_RUN_EVIDENCE_KINDS, v);

export interface ScoutRunEvidenceUploadDeps {
  hostStore: ScoutRunnerHostStore;
  evidenceStore: ScoutRunEvidenceStore;
  resolveBackend(workspaceId: string): Promise<ResolvedEvidenceBackend>;
  signUpload(backend: ResolvedEvidenceBackend, key: string, sizeBytes: number): Promise<string>;
  expiresInSeconds: number;
}

export interface ScoutRunEvidenceUploadInput {
  caller: ScoutHostCaller;
  runId: string;
  body: Record<string, unknown>;
  now: Date;
}

type Out<T> = { status: number; body: T | { error: string; code: string; [k: string]: unknown } };
const refuse = (status: number, code: string, error: string, extra: Record<string, unknown> = {}) =>
  ({ status, body: { error, code, ...extra } });
const storageRefusal = () => refuse(424, 'storage_unavailable', 'Evidence storage unavailable');

export async function requestScoutRunEvidenceUpload(
  input: ScoutRunEvidenceUploadInput,
  deps: ScoutRunEvidenceUploadDeps,
): Promise<Out<ScoutRunEvidenceUploadResponse>> {
  const { kind, seq, sizeBytes, leaseId } = input.body;
  // The lease first: a caller that holds nothing learns nothing about the body's shape.
  const held = await checkScoutRunLease(input.caller, input.runId, leaseId, input.now, deps.hostStore);
  if (!held.ok) return held;
  const run = held.run;

  if (!isKind(kind)) return refuse(400, 'bad_kind', `kind must be one of: ${Object.keys(SCOUT_RUN_EVIDENCE_KINDS).join(', ')}`);
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return refuse(400, 'bad_seq', 'seq must be a non-negative integer');
  if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) return refuse(400, 'bad_size', 'sizeBytes must be a positive integer');

  let backend: ResolvedEvidenceBackend;
  let dataClass: string | null;
  try {
    backend = await deps.resolveBackend(run.workspaceId);
    dataClass = await deps.evidenceStore.workspaceDataClass(run.workspaceId);
  } catch {
    return storageRefusal();
  }
  if (dataClass === 'sensitive' && backend.provider === 'buildd_default') {
    return refuse(403, 'sensitive_needs_byo', 'Evidence upload is not permitted for sensitive workspaces without a team-owned storage backend');
  }
  if (!backend.usable) return storageRefusal();

  let used: number;
  try {
    used = await deps.evidenceStore.usedBytes(run.id);
  } catch {
    return storageRefusal();
  }
  if (!Number.isFinite(used)) return storageRefusal();
  if (used + sizeBytes > backend.maxBytesPerTask) {
    return refuse(413, 'over_byte_limit', 'Evidence exceeds the per-run byte limit', { maxBytes: backend.maxBytesPerTask, usedBytes: used });
  }

  let key: string;
  let uploadUrl: string;
  try {
    key = buildScoutRunEvidenceObjectKey(backend.prefix, run.workspaceId, run.id, kind, `${input.now.getTime()}-${seq}.${SCOUT_RUN_EVIDENCE_KINDS[kind]}.gz`);
    uploadUrl = await deps.signUpload(backend, key, sizeBytes);
  } catch {
    // The error text may name the bucket or echo provider detail; none of it is returned.
    return storageRefusal();
  }

  let evidenceId: string | null;
  try {
    evidenceId = await deps.evidenceStore.insertPending({
      workspaceId: run.workspaceId,
      scoutRunId: run.id,
      kind,
      backendId: backend.backendId,
      objectKey: key,
      bytes: sizeBytes,
      expiresAt: new Date(input.now.getTime() + backend.retentionDays * 24 * 60 * 60 * 1000),
    });
  } catch {
    return storageRefusal();
  }
  if (!evidenceId) return storageRefusal();

  return { status: 200, body: { uploadUrl, evidenceId, contentLength: sizeBytes, expiresIn: deps.expiresInSeconds } };
}
