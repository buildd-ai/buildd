'use client';

/**
 * Evidence files on the task page (docs/specs/byo-evidence-storage.md, build
 * item 6): the task's stored logs and reports, a tail viewer with grep, and a
 * per-click download. The text comes from GET /api/tasks/[id]/evidence
 * (redacted, at most 64 KB a read); a download link is minted by
 * GET /api/evidence/download only when the person clicks.
 */
import { useEffect, useState, type FormEvent } from 'react';
import type { EvidenceObjectSummary } from '@buildd/shared';
import {
  EVIDENCE_MAX_TAIL_LINES, EVIDENCE_TAIL_LINES, EVIDENCE_TAIL_STEP, evidenceKindLabel, fetchEvidenceTransport,
  formatEvidenceBytes, formatEvidenceCreated, indexStateLabel, isReadable, uploadStateLabel,
  type EvidenceReadRequest, type EvidenceStateLabel, type EvidenceTransport,
} from './task-evidence-files';

interface Props {
  taskId: string;
  objects: EvidenceObjectSummary[];
  /** The task's workspace is `sensitive`: its evidence is never indexed. */
  sensitive?: boolean;
  defaultOpen?: boolean;
  /** Open the viewer on this object (and grep) after mount. */
  initialView?: { evidenceId: string; grep?: string } | null;
  transport?: EvidenceTransport;
}

interface ViewerState {
  object: EvidenceObjectSummary;
  /** The grep that produced `text` (empty = tail mode). */
  grep: string;
  tail: number;
  text: string | null;
  truncated: boolean;
  cursor: string | null;
  fromLine: number | null;
  toLine: number | null;
  loading: boolean;
  error: string | null;
}

const LABEL = 'font-mono text-meta';
const BTN = 'font-mono text-xs px-3 min-h-[44px] md:min-h-0 md:py-1.5 border border-border-strong bg-surface-3 text-text-primary hover:bg-surface-4 disabled:opacity-50';

function StateText({ label, testId }: { label: EvidenceStateLabel; testId: string }) {
  return (
    <span
      data-testid={testId}
      data-tone={label.tone}
      className={label.tone === 'attention' ? 'text-status-warning' : 'text-text-muted'}
    >
      {label.text}
    </span>
  );
}

export default function TaskEvidenceFiles({
  taskId,
  objects,
  sensitive = false,
  defaultOpen = false,
  initialView = null,
  transport = fetchEvidenceTransport,
}: Props) {
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const [grepInput, setGrepInput] = useState(initialView?.grep ?? '');

  useEffect(() => {
    const o = initialView && objects.find(x => x.id === initialView.evidenceId && isReadable(x));
    if (o) void load(o, initialView!.grep?.trim() ?? '');
    // Mount only: a later prop change must not reopen a viewer the person closed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<{ id: string; message: string } | null>(null);

  async function load(object: EvidenceObjectSummary, grep: string, opts: { tail?: number; cursor?: string; append?: boolean } = {}) {
    const tail = opts.tail ?? EVIDENCE_TAIL_LINES;
    setViewer(prev => ({
      object, grep, tail,
      text: opts.append ? prev?.text ?? null : prev?.object.id === object.id ? prev.text : null,
      truncated: prev?.truncated ?? false,
      cursor: prev?.cursor ?? null,
      fromLine: prev?.fromLine ?? null,
      toLine: prev?.toLine ?? null,
      loading: true,
      error: null,
    }));
    const req: EvidenceReadRequest = grep
      ? { evidenceId: object.id, grep, ...(opts.cursor ? { cursor: opts.cursor } : {}) }
      : { evidenceId: object.id, tail };
    const res = await transport.read(taskId, req);
    setViewer(prev => {
      if (!prev || prev.object.id !== object.id) return prev;
      if (!res.ok) return { ...prev, loading: false, error: res.error };
      const b = res.body;
      const text = opts.append && prev.text ? (b.text ? `${prev.text}\n${b.text}` : prev.text) : b.text;
      return {
        ...prev, loading: false, error: null, text,
        truncated: b.truncated, cursor: b.cursor,
        fromLine: opts.append ? prev.fromLine ?? b.fromLine : b.fromLine,
        toLine: b.toLine ?? prev.toLine,
      };
    });
  }

  function open(object: EvidenceObjectSummary) {
    setGrepInput('');
    setViewer(null);
    void load(object, '');
  }

  function onGrep(e: FormEvent) {
    e.preventDefault();
    if (!viewer) return;
    void load(viewer.object, grepInput.trim());
  }

  async function download(object: EvidenceObjectSummary) {
    setDownloading(object.id);
    setDownloadError(null);
    const res = await transport.download(taskId, object.id);
    setDownloading(null);
    if (!res.ok) {
      setDownloadError({ id: object.id, message: res.error });
      return;
    }
    transport.open(res.body.url);
  }

  // Forward (grep) reads continue from the cursor; a tail read widens instead,
  // until it reaches line 1 or the route's tail bound.
  const loadMore = viewer && !viewer.loading && !viewer.error && viewer.text !== null
    ? viewer.grep
      ? viewer.cursor ? () => load(viewer.object, viewer.grep, { cursor: viewer.cursor!, append: true }) : null
      : (viewer.fromLine ?? 1) > 1 && !viewer.truncated && viewer.tail < EVIDENCE_MAX_TAIL_LINES
        ? () => load(viewer.object, '', { tail: Math.min(viewer.tail + EVIDENCE_TAIL_STEP, EVIDENCE_MAX_TAIL_LINES) })
        : null
    : null;

  return (
    <div className="mb-6" id="task-evidence-files" data-testid="task-evidence-files">
      <details className="card" open={defaultOpen}>
        <summary className="cursor-pointer p-4 section-label hover:text-text-secondary select-none">
          Evidence files · {objects.length}
        </summary>
        <div className="px-4 pb-4 border-t border-border-default pt-3">
          {objects.length === 0 ? (
            <p data-testid="evidence-empty" className="text-sm text-text-secondary">
              No evidence stored for this task. Command output, test reports and CI logs a run uploads appear here.
            </p>
          ) : (
            <ul className="divide-y divide-border-default border border-border-default" data-testid="evidence-list">
              {objects.map(o => {
                const readable = isReadable(o);
                const active = viewer?.object.id === o.id;
                return (
                  <li
                    key={o.id}
                    data-testid="evidence-row"
                    className={`p-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between ${active ? 'bg-surface-2' : ''}`}
                  >
                    <div className="min-w-0">
                      <div className="font-mono text-[13px] text-text-primary">
                        {evidenceKindLabel(o.kind)}
                        <span className="text-text-muted"> · {formatEvidenceBytes(o.bytes)}</span>
                        {o.taskId !== taskId && <span className="text-text-muted"> · earlier run</span>}
                      </div>
                      <div className="font-mono text-[11px] flex flex-wrap gap-x-2 gap-y-0.5 mt-0.5">
                        <StateText testId="evidence-upload-state" label={uploadStateLabel(o.uploadState)} />
                        <span className="text-text-muted" aria-hidden>·</span>
                        <StateText testId="evidence-index-state" label={indexStateLabel(o.indexState, sensitive)} />
                        <span className="text-text-muted" aria-hidden>·</span>
                        <span className="text-text-muted">{formatEvidenceCreated(o.createdAt)}</span>
                      </div>
                      {downloadError?.id === o.id && (
                        <p data-testid="evidence-download-error" role="alert" className="mt-1 text-xs text-status-error [overflow-wrap:anywhere]">
                          {downloadError.message}
                        </p>
                      )}
                    </div>
                    {readable && (
                      <div className="flex gap-2 shrink-0">
                        <button type="button" data-testid="evidence-view" className={BTN} onClick={() => open(o)} aria-pressed={active}>
                          View
                        </button>
                        <button
                          type="button"
                          data-testid="evidence-download"
                          className={BTN}
                          disabled={downloading === o.id}
                          onClick={() => void download(o)}
                        >
                          {downloading === o.id ? 'Preparing…' : 'Download'}
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {viewer && (
            <div data-testid="evidence-viewer" className="mt-4">
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className={`${LABEL} text-text-muted`}>
                  {evidenceKindLabel(viewer.object.kind)} · {viewer.grep ? 'matches' : `last ${viewer.tail} lines`}
                </div>
                <button type="button" className="font-mono text-xs text-text-secondary hover:text-text-primary px-2 min-h-[44px] md:min-h-0" onClick={() => setViewer(null)}>
                  Close
                </button>
              </div>
              <form data-testid="evidence-grep-form" onSubmit={onGrep} className="flex gap-2 mb-2">
                <input
                  data-testid="evidence-grep"
                  type="search"
                  value={grepInput}
                  onChange={e => setGrepInput(e.target.value)}
                  placeholder="grep (regex, ignores case)"
                  aria-label="Filter lines with a regular expression"
                  className="min-w-0 flex-1 font-mono text-[13px] px-3 min-h-[44px] md:min-h-0 md:py-1.5 bg-surface-1 border border-border-default text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary"
                />
                <button type="submit" className={BTN} disabled={viewer.loading}>
                  {grepInput.trim() ? 'Grep' : 'Tail'}
                </button>
              </form>
              {viewer.error && (
                <p data-testid="evidence-read-error" role="alert" className="mb-2 text-xs text-status-error font-mono [overflow-wrap:anywhere]">
                  {viewer.error}
                </p>
              )}
              {viewer.text !== null && (
                viewer.text ? (
                  <pre
                    data-testid="evidence-text"
                    className="font-mono text-xs text-text-primary whitespace-pre-wrap [overflow-wrap:anywhere] bg-surface-2 border border-border-default p-3 max-h-[60vh] overflow-auto"
                  >
                    {viewer.text}
                  </pre>
                ) : (
                  <p data-testid="evidence-no-lines" className="text-xs text-text-muted font-mono">
                    {viewer.grep ? 'No lines match.' : 'This object has no lines.'}
                  </p>
                )
              )}
              {viewer.loading && viewer.text === null && (
                <p className="text-xs text-text-muted font-mono">Loading…</p>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 font-mono text-[11px] text-text-muted">
                {viewer.fromLine != null && viewer.toLine != null && (
                  <span>lines {viewer.fromLine}–{viewer.toLine}</span>
                )}
                {viewer.truncated && (
                  <span data-testid="evidence-truncated">
                    {viewer.cursor ? 'cut at 64 KB, more below' : viewer.grep ? 'scan stopped early, narrow the pattern' : 'showing the last 64 KB, grep to narrow'}
                  </span>
                )}
                {loadMore && (
                  <button type="button" data-testid="evidence-load-more" className={BTN} onClick={() => void loadMore()}>
                    {viewer.grep ? 'Load more' : 'Show earlier lines'}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}
