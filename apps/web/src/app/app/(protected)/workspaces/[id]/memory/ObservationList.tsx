'use client';

import { useState } from 'react';

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
    const res = await fetch(`/api/workspaces/${workspaceId}/observations/${obsId}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      setObservations(prev => prev.filter(o => o.id !== obsId));
    }
  }

  return (
    <div>
      {/* Filters */}
      <div className="flex gap-4 mb-6">
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
          className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-sm"
        />
      </div>

      {/* List */}
      {loading ? (
        <div className="text-center py-8 text-gray-500">Loading...</div>
      ) : observations.length === 0 ? (
        <div className="text-center py-8 text-gray-500">
          No observations yet. Workers will automatically record observations as they complete tasks.
        </div>
      ) : (
        <div className="space-y-3">
          {observations.map(obs => (
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
                    onClick={() => handleDelete(obs.id)}
                    className="text-xs text-red-500 hover:text-red-700"
                  >
                    Delete
                  </button>
                </div>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400 whitespace-pre-wrap">
                {obs.content.length > 300 ? obs.content.slice(0, 300) + '...' : obs.content}
              </p>
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
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
