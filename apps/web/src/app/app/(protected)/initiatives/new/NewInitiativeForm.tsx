'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Select } from '@/components/ui/Select';
import PrimaryAction from '@/components/ui/PrimaryAction';

interface Props {
  teamId: string;
  workspaces: { id: string; name: string }[];
}

export default function NewInitiativeForm({ teamId, workspaces }: Props) {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [status, setStatus] = useState<'planned' | 'active'>('active');
  const [targetDate, setTargetDate] = useState('');
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
      payload.status = status;
      if (targetDate) payload.targetDate = targetDate;

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
      <Link href="/app/initiatives" className="font-mono text-[13px] text-text-muted hover:text-text-primary">‹ Initiatives</Link>

      <h1 className="mt-3 text-xl font-semibold text-text-primary font-sans mb-1">New initiative</h1>
      <p className="text-sm text-text-secondary mb-6">
        An initiative groups the missions behind one goal. You own it and set its
        status; its missions carry the schedules, budgets and work.
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
            placeholder="The outcome this initiative should deliver"
            rows={4}
            className="input resize-y"
          />
        </label>

        <div className="flex flex-col gap-4 sm:flex-row">
          <label className="flex flex-1 flex-col gap-1.5">
            <span className="text-xs font-medium text-text-secondary">Status</span>
            <Select
              aria-label="Status"
              value={status}
              onChange={(v) => setStatus(v as 'planned' | 'active')}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'planned', label: 'Planned' },
              ]}
            />
          </label>
          <label className="flex flex-1 flex-col gap-1.5">
            <span className="text-xs font-medium text-text-secondary">Target date <span className="text-text-muted">(optional)</span></span>
            <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} className="input" />
          </label>
        </div>

        {workspaces.length > 0 && (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-text-secondary">Workspace <span className="text-text-muted">(optional: leave empty to span repos)</span></span>
            <Select
              aria-label="Workspace"
              value={workspaceId}
              onChange={setWorkspaceId}
              placeholder="Team-wide (no workspace)"
              options={[
                { value: '', label: 'Team-wide (no workspace)' },
                ...workspaces.map((w) => ({ value: w.id, label: w.name })),
              ]}
            />
          </label>
        )}

        {error && <p className="text-sm text-status-error">{error}</p>}

        <div className="flex items-center gap-2 mt-2">
          <PrimaryAction
            onClick={handleSubmit}
            pending={submitting}
            disabled={!title.trim()}
            data-testid="create-initiative"
          >
            {submitting ? 'Creating…' : 'Create initiative'}
          </PrimaryAction>
          <Link href="/app/initiatives" className="btn btn-quiet h-11 md:h-10">
            Cancel
          </Link>
        </div>
      </div>
    </div>
  );
}
