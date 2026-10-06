'use client';

import { useState, useMemo } from 'react';
import { Select } from '@/components/ui/Select';
import CreateObservationForm from './CreateObservationForm';
import { useConfirm } from '@/components/useConfirm';
import {
  memoryDisplayStateOf,
  memoryReviewActionAllowed,
  type MemoryDisplayState,
  type MemoryReviewAction,
} from '@buildd/core/memory-candidates';

interface Observation {
  id: string;
  workspaceId: string;
  workerId: string | null;
  taskId: string | null;
  type: string;
  title: string;
  content: string;
  files: string[] | null;
  concepts: string[] | null;
  createdAt: string;
  state?: string | null;
  supersededBy?: string | null;
  reverifyFlaggedAt?: string | null;
  reverifyRef?: string | null;
}

const STATE_LABELS: Record<MemoryDisplayState, string> = {
  candidate: 'Candidate',
  active: 'Active',
  superseded: 'Superseded',
  invalidated: 'Invalidated',
  expired: 'Expired',
};

// Square chips; color only where the state asks for attention.
const STATE_CHIP: Record<MemoryDisplayState, string> = {
  candidate: 'text-status-warning border-status-warning',
  active: 'text-accent-text border-primary',
  superseded: 'text-text-muted border-border-strong',
  invalidated: 'text-status-error border-status-error',
  expired: 'text-text-muted border-border-strong',
};

const REVIEW_LABELS: Record<MemoryReviewAction, string> = {
  promote: 'Promote',
  dismiss: 'Dismiss',
  reverified: 'Re-verified',
};

/** `pr:123` (what the lifecycle pass writes) as `PR #123`; anything else verbatim. */
function formatReverifyRef(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const m = /^pr:(\d+)$/.exec(ref);
  return m ? `PR #${m[1]}` : ref;
}

/** The API's memory record in the list's shape. */
function toObservation(m: any, workspaceId: string): Observation {
  return {
    id: m.id,
    workspaceId,
    workerId: null,
    taskId: null,
    type: m.type,
    title: m.title,
    content: m.content,
    files: m.files || [],
    concepts: m.tags || [],
    createdAt: m.createdAt,
    state: m.state ?? null,
    supersededBy: m.supersededBy ?? null,
    reverifyFlaggedAt: m.reverifyFlaggedAt ?? null,
    reverifyRef: m.reverifyRef ?? null,
  };
}

const TYPE_COLORS: Record<string, string> = {
  discovery: 'bg-primary/10 text-primary',
  decision: 'bg-primary/10 text-primary',
  gotcha: 'bg-status-error/10 text-status-error',
  pattern: 'bg-status-success/10 text-status-success',
  architecture: 'bg-status-warning/10 text-status-warning',
  summary: 'bg-surface-3 text-text-primary',
};

const TYPES = ['all', 'discovery', 'decision', 'gotcha', 'pattern', 'architecture', 'summary'];
const EDITABLE_TYPES = ['gotcha', 'pattern', 'decision', 'discovery', 'architecture', 'summary'] as const;

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

interface EditFormState {
  type: string;
  title: string;
  content: string;
  filesInput: string;
  conceptsInput: string;
}

export default function ObservationList({
  workspaceId,
  initialObservations,
  canReview = false,
}: {
  workspaceId: string;
  initialObservations: Observation[];
  /** Team admins see Promote / Dismiss / Re-verified on each row. */
  canReview?: boolean;
}) {
  const { confirm, confirmDialog } = useConfirm();
  const [observations, setObservations] = useState<Observation[]>(initialObservations);
  const [typeFilter, setTypeFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'files'>('list');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditFormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [recheckOnly, setRecheckOnly] = useState(false);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<{ id: string; message: string } | null>(null);

  // Group observations by file for file-centric view
  const fileGrouped = useMemo(() => {
    const groups: Record<string, Observation[]> = {};
    const noFile: Observation[] = [];

    observations.forEach(obs => {
      if (obs.files && obs.files.length > 0) {
        // Use the first file as the primary grouping
        const primaryFile = obs.files[0];
        if (!groups[primaryFile]) groups[primaryFile] = [];
        groups[primaryFile].push(obs);
      } else {
        noFile.push(obs);
      }
    });

    // Sort groups by file path
    const sorted = Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
    if (noFile.length > 0) {
      sorted.push(['(no file)', noFile]);
    }
    return sorted;
  }, [observations]);

  async function fetchFiltered(type: string, searchText: string, recheck = recheckOnly) {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (type !== 'all') params.set('type', type);
      if (searchText) params.set('search', searchText);
      params.set('limit', '50');
      // The list is for people: show candidates and retired memories too.
      params.set('states', 'candidate,active,expired,invalidated');
      params.set('superseded', 'include');
      if (recheck) params.set('reverify', 'flagged');

      const res = await fetch(`/api/workspaces/${workspaceId}/memory?${params}`);
      if (res.ok) {
        const data = await res.json();
        const mapped: Observation[] = (data.memories || []).map((m: any) => toObservation(m, workspaceId));
        // A text search goes through the shared read path, which ignores the
        // re-check narrowing; apply it here so the filter always holds.
        setObservations(recheck ? mapped.filter(o => !!o.reverifyFlaggedAt) : mapped);
      }
    } finally {
      setLoading(false);
    }
  }

  function handleTypeChange(type: string) {
    setTypeFilter(type);
    fetchFiltered(type, search);
  }

  function handleRecheckToggle() {
    const next = !recheckOnly;
    setRecheckOnly(next);
    fetchFiltered(typeFilter, search, next);
  }

  async function handleReview(obs: Observation, action: MemoryReviewAction) {
    if (action === 'dismiss' && !(await confirm({
      title: 'Dismiss memory?',
      message: 'Marks it invalidated. Agents stop receiving it. The row is kept.',
      confirmLabel: 'Dismiss',
      variant: 'danger',
    }))) return;
    setReviewingId(obs.id);
    setReviewError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/memory/${obs.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setReviewError({ id: obs.id, message: data.error || 'Action failed' });
        return;
      }
      const updated = toObservation(data.memory, workspaceId);
      const replaced = new Set<string>(data.supersededIds || []);
      setObservations(prev => prev
        .filter(o => !(recheckOnly && o.id === obs.id && !updated.reverifyFlaggedAt))
        .map(o => o.id === obs.id ? updated : replaced.has(o.id) ? { ...o, supersededBy: obs.id } : o));
    } finally {
      setReviewingId(null);
    }
  }

  function handleSearch(text: string) {
    setSearch(text);
    // Debounce: only fetch if user paused typing
    const timer = setTimeout(() => fetchFiltered(typeFilter, text), 300);
    return () => clearTimeout(timer);
  }

  async function handleDelete(obsId: string) {
    if (!(await confirm({ title: 'Delete memory?', message: 'Removes this memory from the workspace.', confirmLabel: 'Delete', variant: 'danger' }))) return;
    const res = await fetch(`/api/workspaces/${workspaceId}/memory/${obsId}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      setObservations(prev => prev.filter(o => o.id !== obsId));
    }
  }

  function startEditing(obs: Observation) {
    setSaveError(null);
    setEditingId(obs.id);
    setEditForm({
      type: obs.type,
      title: obs.title,
      content: obs.content,
      filesInput: obs.files?.join(', ') || '',
      conceptsInput: obs.concepts?.join(', ') || '',
    });
  }

  function cancelEditing() {
    setSaveError(null);
    setEditingId(null);
    setEditForm(null);
  }

  async function saveEdit(obsId: string) {
    if (!editForm) return;
    setSaving(true);
    setSaveError(null);

    try {
      const files = editForm.filesInput
        .split(',')
        .map(f => f.trim())
        .filter(Boolean);
      const tags = editForm.conceptsInput
        .split(',')
        .map(c => c.trim())
        .filter(Boolean);

      const res = await fetch(`/api/workspaces/${workspaceId}/memory/${obsId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: editForm.type,
          title: editForm.title,
          content: editForm.content,
          files: files.length > 0 ? files : undefined,
          tags: tags.length > 0 ? tags : undefined,
        }),
      });

      if (!res.ok) throw new Error('Failed to update');

      // Refresh the list
      await fetchFiltered(typeFilter, search);
      cancelEditing();
    } catch {
      setSaveError('Failed to save changes');
    } finally {
      setSaving(false);
    }
  }

  function handleCreated() {
    fetchFiltered(typeFilter, search);
  }

  function renderObservationCard(obs: Observation) {
    const isEditing = editingId === obs.id;
    const isExpanded = expandedId === obs.id;

    if (isEditing && editForm) {
      return (
        <div key={obs.id} className="border border-primary/30 rounded-lg p-4 bg-primary/5">
          <div className="space-y-3">
            {/* Type selector */}
            <div className="flex gap-2 flex-wrap">
              {EDITABLE_TYPES.map(t => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setEditForm({ ...editForm, type: t })}
                  className={`px-2 py-1 text-xs rounded ${
                    editForm.type === t
                      ? 'bg-primary text-white'
                      : 'bg-surface-3 text-text-secondary'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>

            {/* Title */}
            <input
              type="text"
              value={editForm.title}
              onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
              className="w-full px-3 py-2 border border-border-default rounded bg-surface-1 text-base md:text-sm"
              placeholder="Title"
            />

            {/* Content */}
            <textarea
              value={editForm.content}
              onChange={(e) => setEditForm({ ...editForm, content: e.target.value })}
              rows={4}
              className="w-full px-3 py-2 border border-border-default rounded bg-surface-1 text-base md:text-sm resize-y"
              placeholder="Content"
            />

            {/* Files */}
            <input
              type="text"
              value={editForm.filesInput}
              onChange={(e) => setEditForm({ ...editForm, filesInput: e.target.value })}
              className="w-full px-3 py-2 border border-border-default rounded bg-surface-1 text-base md:text-sm"
              placeholder="Files (comma-separated)"
            />

            {/* Concepts */}
            <input
              type="text"
              value={editForm.conceptsInput}
              onChange={(e) => setEditForm({ ...editForm, conceptsInput: e.target.value })}
              className="w-full px-3 py-2 border border-border-default rounded bg-surface-1 text-base md:text-sm"
              placeholder="Concepts (comma-separated)"
            />

            {/* Actions */}
            <div className="flex justify-end items-center gap-2">
              {saveError && (
                <span role="alert" className="mr-auto text-sm text-status-error">{saveError}</span>
              )}
              <button
                onClick={cancelEditing}
                className="px-3 py-1 text-sm text-text-secondary hover:text-text-primary"
              >
                Cancel
              </button>
              <button
                onClick={() => saveEdit(obs.id)}
                disabled={saving}
                className="px-3 py-1 text-sm bg-primary text-white rounded hover:bg-primary-hover disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      );
    }

    const displayState = memoryDisplayStateOf(obs);
    const reviewActions = canReview
      ? (['promote', 'reverified', 'dismiss'] as const).filter(a => memoryReviewActionAllowed(a, obs))
      : [];
    const recheckRef = formatReverifyRef(obs.reverifyRef);

    return (
      <div key={obs.id} className="border border-border-default rounded-lg p-4">
        {/* Meta + actions on one line, title on its own full-width line so a
            long title wraps normally instead of one word per line. */}
        <div className="flex justify-between items-center gap-2 mb-1">
          <div className="flex items-center gap-2 min-w-0">
            <span
              data-testid="memory-state-chip"
              className={`health-pill flex-shrink-0 ${STATE_CHIP[displayState]}`}
            >
              {STATE_LABELS[displayState]}
            </span>
            <span className={`px-2 py-0.5 text-xs flex-shrink-0 ${TYPE_COLORS[obs.type] || TYPE_COLORS.summary}`}>
              {obs.type}
            </span>
            <span className="text-xs text-text-muted truncate">{timeAgo(obs.createdAt)}</span>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0 -mr-2 md:mr-0 md:gap-2">
            <button
              onClick={() => startEditing(obs)}
              className="inline-flex items-center justify-center min-h-11 min-w-11 px-2 md:min-h-0 md:min-w-0 md:px-0 text-xs text-primary hover:text-primary-hover"
              aria-label={`Edit ${obs.title}`}
            >
              Edit
            </button>
            <button
              onClick={() => handleDelete(obs.id)}
              className="inline-flex items-center justify-center min-h-11 min-w-11 px-2 md:min-h-0 md:min-w-0 md:px-0 text-xs text-status-error hover:opacity-80"
              aria-label={`Delete ${obs.title}`}
            >
              Delete
            </button>
          </div>
        </div>
        <h3 className="font-medium mb-2 [overflow-wrap:anywhere]">{obs.title}</h3>
        {obs.reverifyFlaggedAt && displayState !== 'superseded' && (
          <p data-testid="memory-recheck-note" className="font-mono text-xs text-status-warning mb-2">
            Needs re-check: {recheckRef ? `${recheckRef} touched its files` : 'a merged PR touched its files'}, {timeAgo(obs.reverifyFlaggedAt)}
          </p>
        )}
        <div
          className="text-sm text-text-secondary whitespace-pre-wrap cursor-pointer"
          onClick={() => setExpandedId(isExpanded ? null : obs.id)}
        >
          {isExpanded || obs.content.length <= 300
            ? obs.content
            : obs.content.slice(0, 300) + '...'}
          {obs.content.length > 300 && (
            <span className="text-primary ml-1">
              {isExpanded ? '(collapse)' : '(expand)'}
            </span>
          )}
        </div>
        {obs.files && Array.isArray(obs.files) && obs.files.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {obs.files.slice(0, 8).map((f, i) => (
              <span key={i} className="px-2 py-0.5 text-xs bg-surface-3 rounded">
                {f.split('/').pop()}
              </span>
            ))}
            {obs.files.length > 8 && (
              <span className="px-2 py-0.5 text-xs text-text-muted">+{obs.files.length - 8} more</span>
            )}
          </div>
        )}
        {obs.concepts && Array.isArray(obs.concepts) && obs.concepts.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {obs.concepts.map((c, i) => (
              <span key={i} className="px-2 py-0.5 text-xs bg-primary/10 text-primary rounded">
                #{c}
              </span>
            ))}
          </div>
        )}
        {reviewActions.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-border-default">
            {reviewActions.map(a => (
              <button
                key={a}
                type="button"
                onClick={() => handleReview(obs, a)}
                disabled={reviewingId === obs.id}
                className={`min-h-11 md:min-h-0 px-3 py-1 font-mono text-xs border disabled:opacity-50 ${
                  a === 'promote'
                    ? 'bg-primary text-white border-primary hover:bg-primary-hover'
                    : 'bg-surface-3 text-text-primary border-border-strong hover:bg-surface-4'
                }`}
                aria-label={`${REVIEW_LABELS[a]} ${obs.title}`}
              >
                {reviewingId === obs.id ? '…' : REVIEW_LABELS[a]}
              </button>
            ))}
            {reviewError?.id === obs.id && (
              <span role="alert" className="text-xs text-status-error">{reviewError.message}</span>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      {/* Create form */}
      <div className="mb-6">
        <CreateObservationForm workspaceId={workspaceId} onCreated={handleCreated} />
      </div>

      {/* Filters and view toggle */}
      <div className="flex gap-4 mb-6 flex-wrap">
        <Select
          value={typeFilter}
          onChange={handleTypeChange}
          options={TYPES.map(t => ({ value: t, label: t === 'all' ? 'All types' : t }))}
        />
        <input
          type="text"
          placeholder="Search observations…"
          value={search}
          onChange={(e) => handleSearch(e.target.value)}
          className="flex-1 min-w-[200px] px-3 py-2 border border-border-default rounded-md bg-surface-1 text-base md:text-sm"
        />
        <button
          type="button"
          onClick={handleRecheckToggle}
          aria-pressed={recheckOnly}
          data-testid="memory-recheck-filter"
          className={`px-3 py-2 font-mono text-sm border ${
            recheckOnly
              ? 'border-primary text-accent-text bg-surface-3 font-medium'
              : 'border-border-default bg-surface-1 hover:bg-surface-3'
          }`}
        >
          Needs re-check
        </button>
        <div className="flex rounded-lg border border-border-default overflow-hidden">
          <button
            onClick={() => setViewMode('list')}
            className={`px-3 py-2 text-sm ${
              viewMode === 'list'
                ? 'bg-surface-3 font-medium'
                : 'bg-surface-1 hover:bg-surface-3'
            }`}
          >
            List
          </button>
          <button
            onClick={() => setViewMode('files')}
            className={`px-3 py-2 text-sm border-l border-border-default ${
              viewMode === 'files'
                ? 'bg-surface-3 font-medium'
                : 'bg-surface-1 hover:bg-surface-3'
            }`}
          >
            By File
          </button>
        </div>
      </div>

      {/* List */}
      {loading ? (
        <div className="text-center py-8 text-text-muted">Loading…</div>
      ) : observations.length === 0 ? (
        <div className="text-center py-8 text-text-muted">
          {recheckOnly
            ? 'Nothing needs a re-check. A memory is flagged here when a merged PR touches its files.'
            : 'No observations. Workers add them as they finish tasks.'}
        </div>
      ) : viewMode === 'list' ? (
        <div className="space-y-3">
          {observations.map(obs => renderObservationCard(obs))}
        </div>
      ) : (
        <div className="space-y-6">
          {fileGrouped.map(([file, obs]) => (
            <div key={file} className="border border-border-default rounded-lg overflow-hidden">
              <div className="px-4 py-2 bg-surface-3 border-b border-border-default">
                <code className="text-sm font-mono">{file}</code>
                <span className="text-xs text-text-muted ml-2">({obs.length})</span>
              </div>
              <div className="p-3 space-y-3">
                {obs.map(o => renderObservationCard(o))}
              </div>
            </div>
          ))}
        </div>
      )}
      {confirmDialog}
    </div>
  );
}
