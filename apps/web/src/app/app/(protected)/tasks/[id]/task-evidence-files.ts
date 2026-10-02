/**
 * Pure helpers and the network seam for the task page's Evidence files
 * section (TaskEvidenceFiles.tsx). Client-safe: no server imports.
 */
import type { EvidenceObjectSummary, TaskEvidenceReadResponse } from '@buildd/shared';

/** Lines the viewer opens with, and how many more "Show earlier lines" adds. */
export const EVIDENCE_TAIL_LINES = 200;
export const EVIDENCE_TAIL_STEP = 800;
/** The read route's own bound (evidence-read.ts MAX_TAIL_LINES). */
export const EVIDENCE_MAX_TAIL_LINES = 10_000;

const KIND_LABEL: Record<EvidenceObjectSummary['kind'], string> = {
  command_output: 'Command output',
  test_report: 'Test report',
  ci_job_log: 'CI job log',
  transcript: 'Transcript',
  pr_diff: 'PR diff',
};

export function evidenceKindLabel(kind: EvidenceObjectSummary['kind']): string {
  return KIND_LABEL[kind] ?? kind;
}

export function formatEvidenceBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Same text on the server and the client (no locale or timezone), so hydration agrees. */
export function formatEvidenceCreated(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export type StateTone = 'neutral' | 'attention';

export interface EvidenceStateLabel {
  text: string;
  tone: StateTone;
}

/**
 * Upload state. Only a failed or unreadable upload draws attention; an object
 * still uploading is ordinary.
 */
export function uploadStateLabel(state: EvidenceObjectSummary['uploadState']): EvidenceStateLabel {
  switch (state) {
    case 'stored': return { text: 'stored', tone: 'neutral' };
    case 'pending': return { text: 'uploading', tone: 'neutral' };
    case 'failed': return { text: 'upload failed', tone: 'attention' };
    case 'unreadable': return { text: 'unreadable with the current credential', tone: 'attention' };
    default: return { text: String(state), tone: 'neutral' };
  }
}

/**
 * Index state. Always neutral: not being searchable is a policy outcome
 * (a sensitive workspace is never embedded) or a queue position, not a fault,
 * and the object reads and downloads the same either way.
 */
export function indexStateLabel(state: EvidenceObjectSummary['indexState'], sensitive: boolean): EvidenceStateLabel {
  switch (state) {
    case 'indexed': return { text: 'searchable', tone: 'neutral' };
    case 'queued': return { text: 'indexing', tone: 'neutral' };
    case 'failed': return { text: 'indexing, will retry', tone: 'neutral' };
    case 'skipped':
    default:
      return { text: sensitive ? 'not indexed (sensitive workspace)' : 'not indexed', tone: 'neutral' };
  }
}

export function isReadable(o: Pick<EvidenceObjectSummary, 'uploadState'>): boolean {
  return o.uploadState === 'stored';
}

export interface EvidenceReadRequest {
  evidenceId: string;
  tail?: number;
  grep?: string;
  cursor?: string;
}

export type TransportResult<T> = { ok: true; body: T } | { ok: false; status: number; error: string };

export interface EvidenceDownloadBody {
  url: string;
  expiresAt: string;
  filename: string;
}

/** The section's network seam: the real routes by default, a stub in tests and fixtures. */
export interface EvidenceTransport {
  read(taskId: string, req: EvidenceReadRequest): Promise<TransportResult<TaskEvidenceReadResponse>>;
  download(taskId: string, evidenceId: string): Promise<TransportResult<EvidenceDownloadBody>>;
  /** Hand the minted link to the browser. */
  open(url: string): void;
}

export function evidenceReadQuery(req: EvidenceReadRequest): string {
  const qs = new URLSearchParams({ evidenceId: req.evidenceId });
  if (req.grep) qs.set('grep', req.grep);
  else if (req.tail) qs.set('tail', String(req.tail));
  if (req.cursor) qs.set('cursor', req.cursor);
  return qs.toString();
}

async function getJson<T>(url: string): Promise<TransportResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
  } catch {
    return { ok: false, status: 0, error: 'Network error. Check your connection and try again.' };
  }
  const body = await res.json().catch(() => null) as (T & { error?: string }) | null;
  if (!res.ok || !body) {
    return { ok: false, status: res.status, error: body?.error || `Request failed (${res.status})` };
  }
  return { ok: true, body };
}

export const fetchEvidenceTransport: EvidenceTransport = {
  read: (taskId, req) => getJson(`/api/tasks/${encodeURIComponent(taskId)}/evidence?${evidenceReadQuery(req)}`),
  download: (taskId, evidenceId) => getJson(
    `/api/evidence/download?${new URLSearchParams({ taskId, evidenceId })}`,
  ),
  open: (url) => { window.location.assign(url); },
};
