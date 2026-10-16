'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Chip from '@/components/ui/Chip';
import Notice from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import type { CommentView } from '@/lib/specs/comments';

/**
 * Comments on the revision being read (living-specs.md §16), grouped under the
 * criterion or section each one is about. Anyone who can write may add one; a
 * person may resolve one. Comments never change the spec.
 */

export interface SpecCommentAnchor { kind: 'criterion' | 'section'; id: string; label: string }

const STATE: Record<CommentView['state'], { label: string; tone: 'info' | 'muted' | 'success' }> = {
  open: { label: 'Open', tone: 'info' },
  outdated: { label: 'Outdated', tone: 'muted' },
  resolved: { label: 'Resolved', tone: 'success' },
};

const anchorKey = (kind: string, label: string) => `${kind}:${label}`;
const anchorName = (a: { kind: string; label: string }) => (a.kind === 'criterion' ? a.label : `Section "${a.label}"`);

export default function SpecComments({ specId, revision, comments, anchors, canComment, canResolve }: {
  specId: string;
  revision: number;
  comments: CommentView[];
  anchors: SpecCommentAnchor[];
  canComment: boolean;
  canResolve: boolean;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [anchor, setAnchor] = useState(anchors[0] ? anchorKey(anchors[0].kind, anchors[0].label) : '');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const threads = new Map<string, { anchor: { kind: string; label: string }; items: CommentView[] }>();
  for (const c of comments) {
    const k = anchorKey(c.anchor.kind, c.anchor.label);
    const t = threads.get(k) ?? { anchor: c.anchor, items: [] };
    t.items.push(c);
    threads.set(k, t);
  }

  async function add() {
    const picked = anchors.find((a) => anchorKey(a.kind, a.label) === anchor);
    if (!picked || !text.trim()) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/specs/${encodeURIComponent(specId)}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision, body: text, anchor: picked.kind === 'criterion' ? { criterion: picked.id } : { section: picked.id } }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'The comment was not saved. Try again.');
      return;
    }
    setText('');
    setAdding(false);
    router.refresh();
  }

  async function resolve(id: string) {
    const res = await fetch(`/api/specs/${encodeURIComponent(specId)}/comments/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolved: true }),
    });
    if (res.ok) router.refresh();
    else setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Not resolved. Try again.');
  }

  return (
    <div className="flex flex-col gap-3" data-testid="spec-comments">
      {threads.size === 0 ? (
        <p className="text-body text-text-secondary">No comments on revision {revision}.</p>
      ) : (
        [...threads.entries()].map(([k, t]) => (
          <div key={k} className="flex flex-col gap-2" data-testid="spec-comment-thread" data-anchor={k}>
            <p className="text-meta font-medium text-text-primary">{anchorName(t.anchor)}</p>
            <ul className="flex flex-col gap-2 border-l border-[var(--line-soft)] pl-3">
              {t.items.map((c) => (
                <li key={c.id} className={`flex flex-col gap-1 ${c.parentCommentId ? 'pl-4' : ''}`} data-testid="spec-comment" data-state={c.state}>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-text-muted">
                    <span>{c.author.kind === 'user' ? 'A person' : 'An agent'} on revision {c.madeOnRevision}</span>
                    <Chip tone={STATE[c.state].tone} variant="soft">{STATE[c.state].label}</Chip>
                  </span>
                  <p className="text-body text-text-primary whitespace-pre-wrap [overflow-wrap:anywhere]">{c.body}</p>
                  {canResolve && c.state !== 'resolved' && !c.parentCommentId ? (
                    <button type="button" onClick={() => resolve(c.id)} className="self-start min-h-11 md:min-h-0 text-meta text-text-secondary underline hover:text-text-primary" data-testid="spec-comment-resolve">
                      Resolve
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
      {error ? <Notice tone="err">{error}</Notice> : null}
      {canComment && anchors.length > 0 ? (
        adding ? (
          <div className="flex flex-col gap-2" data-testid="spec-comment-form">
            <Select
              aria-label="What the comment is about"
              value={anchor}
              onChange={setAnchor}
              options={anchors.map((a) => ({ value: anchorKey(a.kind, a.label), label: anchorName(a) }))}
            />
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
              maxLength={4000}
              placeholder="Your comment"
              aria-label="Your comment"
              className="w-full px-2.5 py-1.5 bg-surface-1 border border-border-default text-body text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
            <div className="flex items-center gap-3">
              <button type="button" disabled={busy || !text.trim()} onClick={add} className="min-h-11 md:min-h-9 px-3 border border-border-strong text-body text-text-primary hover:bg-surface-3 disabled:opacity-50" data-testid="spec-comment-save">
                Comment
              </button>
              <button type="button" onClick={() => setAdding(false)} className="min-h-11 md:min-h-9 text-body text-text-secondary hover:text-text-primary">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setAdding(true)} className="self-start min-h-11 md:min-h-0 text-body text-text-secondary underline hover:text-text-primary" data-testid="spec-comment-add">
            Add a comment
          </button>
        )
      ) : null}
    </div>
  );
}
