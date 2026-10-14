'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Notice from '@/components/ui/Notice';
import Segmented from '@/components/ui/Segmented';
import type { AttachmentView } from '@/lib/specs/attachments';

/**
 * The spec page's Files (living-specs.md §21): every attachment that applies
 * to the revision being read, with its kind, caption, who added it, when and
 * in which revision. A binding one says when it changed since approval. A
 * person with write access attaches a file (an upload into the spec's
 * workspace) or removes one; removing never changes an older revision.
 */

export type SpecAttachmentRow = AttachmentView & { addedAgo: string };

const KINDS = [{ value: 'binding', label: 'Binding' }, { value: 'reference', label: 'Reference' }] as const;

/** A file name as an attachment name: lower case, safe characters, no extension clash. */
export function suggestedName(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').replace(/-+$/, '');
  return base.slice(0, 64) || 'file';
}

/** The one line that says how a binding attachment stands against approval, or null. */
export function approvalLine(a: Pick<AttachmentView, 'approval'>): string | null {
  if (!a.approval || a.approval.state === 'unchanged') return null;
  if (a.approval.state === 'added') return 'Added since approval.';
  return a.approval.pinned === a.approval.current
    ? 'Changed since approval: a different file is attached under this name.'
    : `Changed since approval: it is at version ${a.approval.current}, approved at version ${a.approval.pinned}.`;
}

function AttachForm({ specId, onDone }: { specId: string; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'binding' | 'reference'>('reference');
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!file || !name.trim()) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/specs/${encodeURIComponent(specId)}/attachments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), kind, caption: caption.trim() || undefined, filename: file.name, mimeType: file.type || 'application/octet-stream', sizeBytes: file.size }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; upload?: { uploadUrl: string } | null };
    if (!res.ok || !body.upload) {
      setBusy(false);
      setError(body.error ?? 'Could not attach the file. Try again.');
      return;
    }
    const put = await fetch(body.upload.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file }).catch(() => null);
    setBusy(false);
    if (!put?.ok) {
      setError('The file did not upload. Try again.');
      return;
    }
    onDone();
  }

  return (
    <div className="flex flex-col gap-2" data-testid="spec-attach-form">
      <input
        type="file"
        aria-label="File"
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          setFile(f);
          if (f && !name) setName(suggestedName(f.name));
        }}
        className="min-h-11 text-body text-text-primary file:mr-3 file:min-h-9 file:border file:border-border-strong file:bg-surface-1 file:px-3 file:text-body"
      />
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        aria-label="Name"
        placeholder="Name, as in attachment:name"
        className="min-h-11 w-full px-2.5 bg-surface-1 border border-border-default font-mono text-body text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none md:min-h-9"
      />
      <Segmented items={KINDS} value={kind} onChange={setKind} label="Kind" />
      <input
        value={caption}
        onChange={(e) => setCaption(e.target.value)}
        aria-label="Caption"
        placeholder="Caption"
        maxLength={300}
        className="min-h-11 w-full px-2.5 bg-surface-1 border border-border-default text-body text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none md:min-h-9"
      />
      {error ? <Notice tone="err">{error}</Notice> : null}
      <div>
        <button type="button" disabled={busy || !file || !name.trim()} onClick={save} className="min-h-11 md:min-h-9 px-3 border border-border-strong text-body text-text-primary hover:bg-surface-3 disabled:opacity-50" data-testid="spec-attach-save">
          {busy ? 'Attaching' : 'Attach'}
        </button>
      </div>
    </div>
  );
}

export default function SpecAttachments({ specId, revision, attachments, canAttach, isHead }: {
  specId: string;
  revision: number;
  attachments: SpecAttachmentRow[];
  canAttach: boolean;
  /** Attaching and removing act on the head; on an older revision the list is read-only. */
  isHead: boolean;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove(name: string) {
    setError(null);
    const res = await fetch(`/api/specs/${encodeURIComponent(specId)}/attachments/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (res.ok) router.refresh();
    else setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Not removed. Try again.');
  }

  return (
    <div className="flex flex-col gap-3" data-testid="spec-attachments">
      {attachments.length === 0 ? (
        <p className="text-body text-text-secondary">No files on revision {revision}.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-[var(--line-soft)]">
          {attachments.map((a) => {
            const changed = approvalLine(a);
            return (
              <li key={a.id} className="flex gap-3 py-2" data-testid="spec-attachment" data-name={a.name} data-kind={a.kind}>
                {a.isImage ? (
                  <a href={a.url} className="shrink-0" aria-label={`Open ${a.name}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- an access-checked redirect, not a static asset */}
                    <img src={a.url} alt="" loading="lazy" className="h-12 w-12 rounded-md border border-border-default object-cover" />
                  </a>
                ) : null}
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <a href={a.url} className="font-mono text-body text-text-primary underline [overflow-wrap:anywhere]">{a.name}</a>
                    <span className="text-meta text-text-muted">{a.kind === 'binding' ? 'Binding' : 'Reference'}</span>
                  </span>
                  {a.caption ? <span className="text-body text-text-secondary [overflow-wrap:anywhere]">{a.caption}</span> : null}
                  <span className="text-meta text-text-muted">
                    Added by {a.addedBy.name ?? (a.addedBy.kind === 'person' ? 'a person' : 'an agent')} in revision {a.addedInRevision} · {a.addedAgo}
                  </span>
                  {changed ? <span className="text-meta text-status-warning" data-testid="spec-attachment-changed">{changed}</span> : null}
                  {canAttach && isHead ? (
                    <button type="button" onClick={() => remove(a.name)} className="self-start min-h-11 md:min-h-0 text-meta text-text-secondary underline hover:text-text-primary" data-testid="spec-attachment-remove">
                      Remove
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {error ? <Notice tone="err">{error}</Notice> : null}
      {canAttach && isHead ? (
        adding ? (
          <AttachForm specId={specId} onDone={() => { setAdding(false); router.refresh(); }} />
        ) : (
          <button type="button" onClick={() => setAdding(true)} className="self-start min-h-11 md:min-h-0 text-body text-text-secondary underline hover:text-text-primary" data-testid="spec-attach-add">
            Attach a file
          </button>
        )
      ) : null}
    </div>
  );
}
