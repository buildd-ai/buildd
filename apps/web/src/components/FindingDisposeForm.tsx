'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Select } from '@/components/ui/Select';

/**
 * Waive or defer one finding, from the task page. A reason is required, and a deferral names the
 * full id of the task that takes it. The route re-checks who is asking; the page refreshes after.
 */
export default function FindingDisposeForm({ prNumber, workspaceId, findingId, decisionHead }: { prNumber: number; workspaceId: string; findingId: string; decisionHead: { headSha: string | null; version: number } }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [disposition, setDisposition] = useState<'waived' | 'deferred'>('waived');
  const [reason, setReason] = useState('');
  const [taskId, setTaskId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/prs/${prNumber}/dispose-finding`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, findingId, ...(decisionHead.headSha ? { headSha: decisionHead.headSha, version: decisionHead.version } : {}), disposition, reason, ...(disposition === 'deferred' ? { deferredToTaskId: taskId } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data.error || 'Finding not closed. Retry.');
      else { setOpen(false); router.refresh(); }
    } catch {
      setError('Finding not closed. Retry.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return <button type="button" data-testid="finding-dispose-open" onClick={() => setOpen(true)} className="ml-2 min-h-11 text-meta underline md:min-h-0">Waive or defer</button>;
  }
  return (
    <div data-testid="finding-dispose-form" className="mt-2 flex flex-col gap-2 border border-border-default p-3">
      <div className="flex flex-col gap-1 text-meta">
        <span id="finding-dispose-action">Action</span>
        <Select<'waived' | 'deferred'>
          value={disposition}
          onChange={setDisposition}
          aria-labelledby="finding-dispose-action"
          options={[
            { value: 'waived', label: 'Waive: this finding does not need a change' },
            { value: 'deferred', label: 'Defer: another task takes it' },
          ]}
        />
      </div>
      {disposition === 'deferred' && (
        <label className="flex flex-col gap-1 text-meta">Task that takes it (full task id)
          <input value={taskId} onChange={(e) => setTaskId(e.target.value)} className="min-h-11 border border-border-default bg-surface-1 px-2 font-mono text-body" />
        </label>
      )}
      <label className="flex flex-col gap-1 text-meta">Reason
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className="border border-border-default bg-surface-1 px-2 py-1 text-body" />
      </label>
      {error && <p role="status" className="text-body text-status-error">{error}</p>}
      <div className="flex gap-2">
        <button type="button" disabled={busy || !reason.trim() || (disposition === 'deferred' && !taskId.trim())} onClick={submit} className="btn-primary min-h-11 px-4 text-body font-medium disabled:opacity-50">{busy ? 'Working…' : 'Close this finding'}</button>
        <button type="button" disabled={busy} onClick={() => setOpen(false)} className="min-h-11 px-4 text-body">Cancel</button>
      </div>
    </div>
  );
}
