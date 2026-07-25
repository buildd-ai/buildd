'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

interface Props {
  teamId: string;
  workspaces: { id: string; name: string }[];
}

export default function NewInitiativeForm({ teamId, workspaces }: Props) {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit() {
    if (!title.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      const payload: Record<string, unknown> = { title: title.trim(), teamId };
      if (description.trim()) payload.description = description.trim();
      if (workspaceId) payload.workspaceId = workspaceId;

      const res = await fetch('/api/initiatives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to create initiative');
      }
      const created = await res.json();
      router.push(`/app/initiatives/${created.id}`);
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-lg">
      <div className="flex items-center gap-2 text-[12px] text-text-muted mb-5">
        <Link href="/app/missions" className="hover:text-text-secondary transition-colors">Missions</Link>
        <span>/</span>
        <span className="text-text-secondary">New initiative</span>
      </div>

      <h1 className="text-xl font-semibold text-text-primary font-sans mb-1">New Initiative</h1>
      <p className="text-sm text-text-secondary mb-6">
        An initiative groups related missions under one goal. It has no schedule or
        budget of its own — missions under it do the work.
      </p>

      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-text-secondary">Title</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Q3 Platform Hardening"
            className="input"
            autoFocus
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-text-secondary">Description <span className="text-text-muted">(optional)</span></span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What is this initiative trying to achieve?"
            rows={4}
            className="input resize-y"
          />
        </label>

        {workspaces.length > 0 && (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-text-secondary">Workspace <span className="text-text-muted">(optional — leave empty to span repos)</span></span>
            <select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} className="input">
              <option value="">Team-wide (no workspace)</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          </label>
        )}

        {error && <p className="text-sm text-status-error">{error}</p>}

        <div className="flex items-center gap-2 mt-2">
          <button
            onClick={handleSubmit}
            disabled={submitting || !title.trim()}
            className="px-4 py-2 text-sm font-medium bg-primary text-white rounded-sm hover:bg-primary-hover transition-colors disabled:opacity-50"
          >
            {submitting ? 'Creating…' : 'Create Initiative'}
          </button>
          <Link href="/app/missions" className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors">
            Cancel
          </Link>
        </div>
      </div>
    </div>
  );
}
