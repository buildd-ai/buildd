'use client';

/**
 * The mission description — its one place on the page (F5).
 *
 * It sits directly under the masthead, before the situation, rendered as
 * markdown through the app's shared `MarkdownContent` (the same renderer task
 * descriptions and artifacts use), and collapsed behind "Show more" when long.
 * Editing happens in place. The Settings panel no longer carries it, so the
 * description never appears twice and never as raw `## …` syntax.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import MarkdownContent from '@/components/MarkdownContent';

/** Longer than this (or more lines than {@link DESCRIPTION_PREVIEW_LINES}) collapses. */
export const DESCRIPTION_PREVIEW_CHARS = 220;
export const DESCRIPTION_PREVIEW_LINES = 4;

export function isLongDescription(text: string): boolean {
  return text.length > DESCRIPTION_PREVIEW_CHARS || text.split('\n').length > DESCRIPTION_PREVIEW_LINES;
}

/**
 * Four whole lines at 13px × leading-relaxed (≈21px each), then a mask fade so
 * the cut never lands mid-glyph. A mask (not a surface-coloured overlay) works
 * on whatever panel the description sits on.
 */
const COLLAPSED_CLASS =
  'max-h-[5.25rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]';

const ERROR = (msg: string) => (
  <span data-testid="mission-description-error" className="font-mono text-[11px] text-status-error">
    {msg}
  </span>
);

const ACTION_CLASS =
  'inline-flex min-h-11 items-center font-mono text-[11px] uppercase tracking-wider text-text-muted hover:text-text-primary transition-colors md:min-h-0 md:py-1';

export default function MissionDescription({
  missionId,
  initialDescription,
  readonly = false,
}: {
  missionId: string;
  initialDescription: string | null;
  /** Terminal missions show the description but do not offer editing. */
  readonly?: boolean;
}) {
  const [description, setDescription] = useState((initialDescription ?? '').trim());
  const [draft, setDraft] = useState(description);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Re-sync after a server refresh (MissionAutoRefresh) — but never under an
  // open draft; a prop that changes mid-edit is picked up once editing ends.
  const [syncedFrom, setSyncedFrom] = useState(initialDescription);
  if (!editing && initialDescription !== syncedFrom) {
    setSyncedFrom(initialDescription);
    setDescription((initialDescription ?? '').trim());
  }
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (editing && el) {
      el.focus();
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [editing]);

  const startEdit = useCallback(() => {
    setDraft(description);
    setError(null);
    setEditing(true);
  }, [description]);

  const save = useCallback(async () => {
    const next = draft.trim();
    setEditing(false);
    // This save supersedes whatever the props said while the draft was open.
    setSyncedFrom(initialDescription);
    if (next === description) return;
    const before = description;
    setDescription(next);
    setSaving(true);
    try {
      const res = await fetch(`/api/missions/${missionId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: next }),
      });
      if (!res.ok) {
        setDescription(before);
        setError('Save failed');
      }
    } catch {
      setDescription(before);
      setError('Save failed');
    } finally {
      setSaving(false);
    }
  }, [draft, description, missionId, initialDescription]);

  if (!description && readonly) return null;

  if (editing) {
    return (
      <div data-testid="mission-description" className="mb-3">
        <textarea
          ref={textareaRef}
          value={draft}
          aria-label="Mission description (markdown)"
          onChange={(e) => {
            setDraft(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = `${e.target.scrollHeight}px`;
          }}
          // Clicking away saves, as the old inline editor did.
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(false);
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
          }}
          rows={3}
          className="w-full resize-none border border-border-default bg-surface-2 p-2 text-[13px] leading-relaxed text-text-primary outline-none focus:border-accent-text"
        />
        <div className="flex items-center gap-4">
          {/* preventDefault on mousedown keeps focus in the textarea, so these
              buttons act on click instead of the blur-save firing first. */}
          <button
            type="button"
            data-testid="mission-description-save"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void save()}
            className={`${ACTION_CLASS} text-accent-text`}
          >
            Save
          </button>
          <button
            type="button"
            data-testid="mission-description-cancel"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setEditing(false)}
            className={ACTION_CLASS}
          >
            Cancel
          </button>
          <span className="hidden font-mono text-[10px] text-text-muted md:inline">Markdown · ⌘↵ to save</span>
        </div>
      </div>
    );
  }

  if (!description) {
    return (
      <div data-testid="mission-description" className="mb-2">
        <button type="button" data-testid="mission-description-edit" onClick={startEdit} className={ACTION_CLASS}>
          + Add a description
        </button>
        {error && ERROR(error)}
      </div>
    );
  }

  const long = isLongDescription(description);
  const collapsed = long && !expanded;

  return (
    <div data-testid="mission-description" className={`mb-3 ${saving ? 'opacity-60' : ''}`}>
      <div
        data-collapsed={collapsed ? 'true' : undefined}
        className={`text-[13px] leading-relaxed text-text-desc ${collapsed ? COLLAPSED_CLASS : ''}`}
      >
        <MarkdownContent content={description} variant="compact" className="[&>*:first-child]:mt-0" />
      </div>
      <div className="flex items-center gap-4">
        {long && (
          <button
            type="button"
            data-testid="mission-description-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className={ACTION_CLASS}
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
        {!readonly && (
          <button type="button" data-testid="mission-description-edit" onClick={startEdit} className={ACTION_CLASS}>
            Edit
          </button>
        )}
        {error && ERROR(error)}
      </div>
    </div>
  );
}
