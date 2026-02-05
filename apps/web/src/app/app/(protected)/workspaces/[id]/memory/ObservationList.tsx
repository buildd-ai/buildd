'use client';

import { useState, useMemo } from 'react';
import CreateObservationForm from './CreateObservationForm';

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
}

const TYPE_COLORS: Record<string, string> = {
  discovery: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  decision: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  gotcha: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  pattern: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  architecture: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
  summary: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
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
}: {
  workspaceId: string;
  initialObservations: Observation[];
}) {
  const [observations, setObservations] = useState<Observation[]>(initialObservations);
  const [typeFilter, setTypeFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'files'>('list');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditFormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

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

  async function fetchFiltered(type: string, searchText: string) {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (type !== 'all') params.set('type', type);
      if (searchText) params.set('search', searchText);
      params.set('limit', '50');

      const res = await fetch(`/api/workspaces/${workspaceId}/observations?${params}`);
      if (res.ok) {
        const data = await res.json();
        setObservations(data.observations || []);
      }
    } finally {
      setLoading(false);
    }
  }

  function handleTypeChange(type: string) {
    setTypeFilter(type);
    fetchFiltered(type, search);
  }

  function handleSearch(text: string) {
    setSearch(text);
    // Debounce: only fetch if user paused typing
    const timer = setTimeout(() => fetchFiltered(typeFilter, text), 300);
    return () => clearTimeout(timer);
  }

  async function handleDelete(obsId: string) {
    if (!confirm('Delete this observation?')) return;
    const res = await fetch(`/api/workspaces/${workspaceId}/observations/${obsId}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      setObservations(prev => prev.filter(o => o.id !== obsId));
    }
  }

  function startEditing(obs: Observation) {
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
    setEditingId(null);
    setEditForm(null);
  }

  async function saveEdit(obsId: string) {
    if (!editForm) return;
    setSaving(true);

    try {
      const files = editForm.filesInput
        .split(',')
        .map(f => f.trim())
        .filter(Boolean);
      const concepts = editForm.conceptsInput
        .split(',')
        .map(c => c.trim())
        .filter(Boolean);

      // Note: This requires an update endpoint. For now, we'll delete and recreate.
      // In a production app, you'd have a PATCH endpoint.
      const deleteRes = await fetch(`/api/workspaces/${workspaceId}/observations/${obsId}`, {
        method: 'DELETE',
      });
      if (!deleteRes.ok) throw new Error('Failed to update');

      const createRes = await fetch(`/api/workspaces/${workspaceId}/observations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: editForm.type,
          title: editForm.title,
          content: editForm.content,
          files: files.length > 0 ? files : undefined,
          concepts: concepts.length > 0 ? concepts : undefined,
        }),
      });

      if (!createRes.ok) throw new Error('Failed to update');

      // Refresh the list
      await fetchFiltered(typeFilter, search);
      cancelEditing();
    } catch {
      alert('Failed to save changes');
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
        <div key={obs.id} className="border border-blue-300 dark:border-blue-700 rounded-lg p-4 bg-blue-50/50 dark:bg-blue-900/20">
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
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300'
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
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded bg-white dark:bg-gray-900 text-sm"
              placeholder="Title"
            />

            {/* Content */}
            <textarea
              value={editForm.content}
              onChange={(e) => setEditForm({ ...editForm, content: e.target.value })}
              rows={4}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded bg-white dark:bg-gray-900 text-sm resize-y"
              placeholder="Content"
            />

            {/* Files */}
            <input
              type="text"
              value={editForm.filesInput}
              onChange={(e) => setEditForm({ ...editForm, filesInput: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded bg-white dark:bg-gray-900 text-sm"
              placeholder="Files (comma-separated)"
            />

            {/* Concepts */}
            <input
              type="text"
              value={editForm.conceptsInput}
              onChange={(e) => setEditForm({ ...editForm, conceptsInput: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded bg-white dark:bg-gray-900 text-sm"
              placeholder="Concepts (comma-separated)"
            />

            {/* Actions */}
            <div className="flex justify-end gap-2">
              <button
                onClick={cancelEditing}
                className="px-3 py-1 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
              >
                Cancel
              </button>
              <button
                onClick={() => saveEdit(obs.id)}
                disabled={saving}
                className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div key={obs.id} className="border border-gray-200 dark:border-gray-800 rounded-lg p-4">
        <div className="flex justify-between items-start mb-2">
          <div className="flex items-center gap-2">
            <span className={`px-2 py-0.5 text-xs rounded-full ${TYPE_COLORS[obs.type] || TYPE_COLORS.summary}`}>
              {obs.type}
            </span>
            <h3 className="font-medium">{obs.title}</h3>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">{timeAgo(obs.createdAt)}</span>
            <button
              onClick={() => startEditing(obs)}
              className="text-xs text-blue-500 hover:text-blue-700"
            >
              Edit
            </button>
            <button
              onClick={() => handleDelete(obs.id)}
              className="text-xs text-red-500 hover:text-red-700"
            >
              Delete
            </button>
          </div>
        </div>
        <div
          className="text-sm text-gray-600 dark:text-gray-400 whitespace-pre-wrap cursor-pointer"
          onClick={() => setExpandedId(isExpanded ? null : obs.id)}
        >
          {isExpanded || obs.content.length <= 300
            ? obs.content
            : obs.content.slice(0, 300) + '...'}
          {obs.content.length > 300 && (
            <span className="text-blue-500 ml-1">
              {isExpanded ? '(collapse)' : '(expand)'}
            </span>
          )}
        </div>
        {obs.files && Array.isArray(obs.files) && obs.files.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {obs.files.slice(0, 8).map((f, i) => (
              <span key={i} className="px-2 py-0.5 text-xs bg-gray-100 dark:bg-gray-800 rounded">
                {f.split('/').pop()}
              </span>
            ))}
            {obs.files.length > 8 && (
              <span className="px-2 py-0.5 text-xs text-gray-500">+{obs.files.length - 8} more</span>
            )}
          </div>
        )}
        {obs.concepts && Array.isArray(obs.concepts) && obs.concepts.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {obs.concepts.map((c, i) => (
              <span key={i} className="px-2 py-0.5 text-xs bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded">
                #{c}
              </span>
            ))}
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
        <select
          value={typeFilter}
          onChange={(e) => handleTypeChange(e.target.value)}
          className="px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-sm"
        >
          {TYPES.map(t => (
            <option key={t} value={t}>{t === 'all' ? 'All types' : t}</option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Search observations..."
          value={search}
          onChange={(e) => handleSearch(e.target.value)}
          className="flex-1 min-w-[200px] px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-sm"
        />
        <div className="flex rounded-lg border border-gray-300 dark:border-gray-700 overflow-hidden">
          <button
            onClick={() => setViewMode('list')}
            className={`px-3 py-2 text-sm ${
              viewMode === 'list'
                ? 'bg-gray-100 dark:bg-gray-800 font-medium'
                : 'bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800'
            }`}
          >
            List
          </button>
          <button
            onClick={() => setViewMode('files')}
            className={`px-3 py-2 text-sm border-l border-gray-300 dark:border-gray-700 ${
              viewMode === 'files'
                ? 'bg-gray-100 dark:bg-gray-800 font-medium'
                : 'bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800'
            }`}
          >
            By File
          </button>
        </div>
      </div>

      {/* List */}
      {loading ? (
        <div className="text-center py-8 text-gray-500">Loading...</div>
      ) : observations.length === 0 ? (
        <div className="text-center py-8 text-gray-500">
          No observations yet. Add observations manually or let workers record them as they complete tasks.
        </div>
      ) : viewMode === 'list' ? (
        <div className="space-y-3">
          {observations.map(obs => renderObservationCard(obs))}
        </div>
      ) : (
        <div className="space-y-6">
          {fileGrouped.map(([file, obs]) => (
            <div key={file} className="border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
              <div className="px-4 py-2 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800">
                <code className="text-sm font-mono">{file}</code>
                <span className="text-xs text-gray-500 ml-2">({obs.length})</span>
              </div>
              <div className="p-3 space-y-3">
                {obs.map(o => renderObservationCard(o))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
