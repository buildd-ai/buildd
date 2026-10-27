'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ordinal, type HealthQueueLane, type HealthQueueWaitingRow } from '@buildd/shared';
import Sheet from '@/components/ui/Sheet';
import Chip from '@/components/ui/Chip';
import PrimaryAction from '@/components/ui/PrimaryAction';

/**
 * Health › Queue's sheets (spec "Health › Queue", R-9 to R-11): Force start
 * past a limit (the Force Start contract: GET /waiting for the digest, POST
 * /start with it), a declared dependency (the blocker's next step, Remove with
 * a reason), and a lane's order (holder first, Release when stuck). Each body
 * is a pure component so it renders in a test without a DOM.
 */

const CHECK_FAILED = 'Could not check what holds it. Try again.';
const START_FAILED = 'Could not start it. Try again.';
const REMOVE_FAILED = 'Could not remove it. Try again.';
const RELEASE_FAILED = 'Could not release the lane. Try again.';

function Rows({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-body">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-text-muted">{k}</dt>
          <dd className="min-w-0 text-text-primary">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Lines({ items }: { items: string[] }) {
  if (items.length === 0) return <span className="text-text-muted">Nothing</span>;
  return <ul className="space-y-1">{items.map(i => <li key={i}>{i}</li>)}</ul>;
}

// ── Shared writes (Queue sheets and the task page's action zone) ────────────

/** PATCH removeDependency with a reason. Returns an error message, or null on success. */
export async function removeDependencyRequest(taskId: string, blockerId: string, reason: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ removeDependency: { taskId: blockerId, reason: reason.trim() } }),
    });
    if (res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return body.error ?? REMOVE_FAILED;
  } catch {
    return REMOVE_FAILED;
  }
}

/** POST lanes/release for a stuck holder. Returns an error message, or null on success. */
export async function releaseLaneRequest(workspaceId: string, lane: string, holderTaskId: string, reason: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/workspaces/${workspaceId}/lanes/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lane, taskId: holderTaskId, reason }),
    });
    if (res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return body.error ?? RELEASE_FAILED;
  } catch {
    return RELEASE_FAILED;
  }
}

// ── Force start ─────────────────────────────────────────────────────────────

export type ForceState =
  | { kind: 'loading' }
  | { kind: 'ready'; skips: string[]; stillEnforced: string[]; canForce: boolean; kinds: string[]; digest: string | null; notForceable: string[] }
  | { kind: 'started' }
  | { kind: 'error'; message: string };

export function ForceStartBody({ row, state, busy, onConfirm, onClose }: { row: HealthQueueWaitingRow; state: ForceState; busy: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <div className="space-y-4" data-testid="queue-force-sheet">
      <p className="text-title font-semibold text-text-primary">{row.title}</p>
      {state.kind === 'loading' && <p className="text-body text-text-muted">Checking what holds it…</p>}
      {state.kind === 'error' && <p className="text-body text-status-error" role="alert">{state.message}</p>}
      {state.kind === 'started' && <p className="text-body text-status-success" role="status">Started. The next free runner takes it.</p>}
      {state.kind === 'ready' && (
        <>
          <Rows rows={[
            ['Skips', <Lines key="s" items={state.skips} />],
            ['Still enforced', <Lines key="e" items={state.stillEnforced} />],
            ...(state.notForceable.length > 0 ? [['Cannot skip', <Lines key="n" items={state.notForceable} />] as [string, React.ReactNode]] : []),
          ]} />
          <div className="flex gap-2">
            <PrimaryAction pending={busy} disabled={!state.canForce || !state.digest} onClick={onConfirm} data-testid="queue-force-confirm" className="flex-1 md:flex-none">
              Force start
            </PrimaryAction>
            <button type="button" className="btn btn-lg h-11 md:h-10" onClick={onClose}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}

type WaitingBody = {
  reasonsDigest?: string;
  canForce?: boolean;
  force?: { kinds?: string[]; gates?: string[]; railsRemaining?: string[]; checklist?: Array<{ gate: string; sentence: string }> } | null;
  notForceable?: string[];
  error?: string;
};

export function forceStateOf(body: WaitingBody): ForceState {
  const checklist = body.force?.checklist ?? [];
  return {
    kind: 'ready',
    skips: checklist.length > 0 ? checklist.map(c => `${c.gate}: ${c.sentence}`) : body.force?.gates ?? [],
    stillEnforced: body.force?.railsRemaining ?? [],
    canForce: !!body.canForce && !!body.force,
    kinds: body.force?.kinds ?? [],
    digest: body.reasonsDigest ?? null,
    notForceable: body.notForceable ?? [],
  };
}

export function ForceStartSheet({ row, onClose, onDone }: { row: HealthQueueWaitingRow | null; onClose: () => void; onDone: () => void }) {
  const [state, setState] = useState<ForceState>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);

  async function load(id: string) {
    setState({ kind: 'loading' });
    try {
      const res = await fetch(`/api/tasks/${id}/waiting`);
      const body = (await res.json().catch(() => ({}))) as WaitingBody;
      setState(res.ok ? forceStateOf(body) : { kind: 'error', message: body.error ?? CHECK_FAILED });
    } catch {
      setState({ kind: 'error', message: CHECK_FAILED });
    }
  }

  useEffect(() => { if (row) void load(row.id); }, [row?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function confirmForce() {
    if (!row || state.kind !== 'ready' || !state.digest) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/tasks/${row.id}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: { kinds: state.kinds, reasonsDigest: state.digest } }),
      });
      const body = (await res.json().catch(() => ({}))) as WaitingBody;
      if (res.ok) { setState({ kind: 'started' }); onDone(); return; }
      // 409: what holds it changed since the sheet opened; show the new reasons.
      if (res.status === 409) setState(forceStateOf(body));
      else setState({ kind: 'error', message: body.error ?? START_FAILED });
    } catch {
      setState({ kind: 'error', message: START_FAILED });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={!!row} onClose={onClose} title="Force start" trapFocus testId="queue-force">
      {row && <ForceStartBody row={row} state={state} busy={busy} onConfirm={confirmForce} onClose={onClose} />}
    </Sheet>
  );
}

// ── Declared dependency ─────────────────────────────────────────────────────

const STATUS_WORD: Record<string, string> = {
  pending: 'Waiting',
  assigned: 'Starting',
  in_progress: 'Running',
  review: 'In review',
  completed: 'Done, PR not merged',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** The blocker's next step: what moves it, opened on its own page. */
export function blockerNextStep(status: string | null): string {
  switch (status) {
    case 'pending': return 'Start it';
    case 'assigned':
    case 'in_progress': return 'Watch it run';
    case 'review':
    case 'completed': return 'Merge its PR';
    case 'failed': return 'Retry it';
    default: return 'Open it';
  }
}

export function RemoveDependencyForm({ reason, onReason, busy, error, onRemove }: { reason: string; onReason: (v: string) => void; busy: boolean; error: string | null; onRemove: () => void }) {
  return (
    <div className="space-y-2 border-t border-[var(--line-soft)] pt-4">
      <label htmlFor="queue-remove-reason" className="field-label">Why remove it</label>
      <textarea
        id="queue-remove-reason"
        value={reason}
        onChange={e => onReason(e.target.value)}
        rows={2}
        className="w-full"
        data-testid="queue-remove-reason"
      />
      {error && <p className="text-body text-status-error" role="alert">{error}</p>}
      <button type="button" className="btn h-11 md:h-8" disabled={busy || !reason.trim()} onClick={onRemove} data-testid="queue-remove-dependency">
        {busy ? 'Removing…' : 'Remove'}
      </button>
    </div>
  );
}

export function DependencyBody({ row, reason, onReason, busy, error, onRemove }: { row: HealthQueueWaitingRow; reason: string; onReason: (v: string) => void; busy: boolean; error: string | null; onRemove: () => void }) {
  const blockerName = row.wait.blockerTitle ?? row.blockedBy;
  return (
    <div className="space-y-4" data-testid="queue-declared-sheet">
      <p className="text-title font-semibold text-text-primary">{row.title}</p>
      <Rows rows={[
        ['Depends on', row.blockerId ? <Link key="d" href={`/app/tasks/${row.blockerId}`} className="hover:underline">{blockerName}</Link> : blockerName],
        ['Status', <Chip key="s" tone={row.blockerStatus === 'failed' ? 'error' : row.blockerStatus === 'in_progress' ? 'running' : 'muted'} variant="soft">{STATUS_WORD[row.blockerStatus ?? ''] ?? 'Unknown'}</Chip>],
        ['Set by', row.setBy ?? 'Whoever filed it'],
        ['Why', row.why ?? <span key="w" className="text-text-muted">Not recorded</span>],
      ]} />
      {row.blockerId && (
        <PrimaryAction href={`/app/tasks/${row.blockerId}`} fullWidthOnMobile data-testid="queue-blocker-next">
          {blockerNextStep(row.blockerStatus)}
        </PrimaryAction>
      )}
      <RemoveDependencyForm reason={reason} onReason={onReason} busy={busy} error={error} onRemove={onRemove} />
    </div>
  );
}

export function DependencySheet({ row, onClose, onDone }: { row: HealthQueueWaitingRow | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setReason(''); setError(null); }, [row?.id]);

  async function remove() {
    if (!row?.blockerId || !reason.trim()) return;
    setBusy(true);
    setError(null);
    const message = await removeDependencyRequest(row.id, row.blockerId, reason);
    setBusy(false);
    if (message) { setError(message); return; }
    onDone();
    onClose();
  }

  return (
    <Sheet open={!!row} onClose={onClose} title="Dependency" trapFocus testId="queue-declared">
      {row && <DependencyBody row={row} reason={reason} onReason={setReason} busy={busy} error={error} onRemove={remove} />}
    </Sheet>
  );
}

// ── Lane panel ──────────────────────────────────────────────────────────────

export function ReleaseLaneControl({ stuckFor, confirming, busy, error, onRelease, onConfirm, onCancel }: { stuckFor: string; confirming: boolean; busy: boolean; error: string | null; onRelease: () => void; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="space-y-2 border-t border-[var(--line-soft)] pt-4">
      <p className="text-body text-text-primary">No PR activity for {stuckFor}.</p>
      {error && <p className="text-body text-status-error" role="alert">{error}</p>}
      {confirming ? (
        <div className="flex gap-2">
          <PrimaryAction pending={busy} onClick={onConfirm} data-testid="queue-lane-release-confirm" className="flex-1 md:flex-none">
            Release lane
          </PrimaryAction>
          <button type="button" className="btn btn-lg h-11 md:h-10" onClick={onCancel}>Cancel</button>
        </div>
      ) : (
        <button type="button" className="btn h-11 md:h-8" onClick={onRelease} data-testid="queue-lane-release">Release</button>
      )}
    </div>
  );
}

export function LaneBody({ lane, confirming, busy, error, onRelease, onConfirm, onCancel }: { lane: HealthQueueLane; confirming: boolean; busy: boolean; error: string | null; onRelease: () => void; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="space-y-4" data-testid="queue-lane-sheet">
      <ol className="divide-y divide-[var(--line-soft)]">
        {lane.holder && (
          <li className="flex min-h-11 items-center gap-3 py-2" data-testid="queue-lane-holder">
            <span className="w-10 shrink-0 text-meta text-text-muted">Holds</span>
            <Link href={`/app/tasks/${lane.holder.taskId}`} className="min-w-0 flex-1 truncate text-body font-medium text-text-primary hover:underline">{lane.holder.title}</Link>
            <Chip tone={lane.stuckFor ? 'error' : 'running'} variant="soft">{lane.holder.state}</Chip>
            {lane.holder.age && <span className="shrink-0 font-mono text-meta text-text-muted">{lane.holder.age}</span>}
          </li>
        )}
        {lane.waiters.map(w => (
          <li key={w.taskId} className="flex min-h-11 items-center gap-3 py-2" data-testid="queue-lane-waiter">
            <span className="w-10 shrink-0 font-mono text-meta text-text-muted">{ordinal(w.position ?? 0)}</span>
            <Link href={`/app/tasks/${w.taskId}`} className="min-w-0 flex-1 truncate text-body text-text-primary hover:underline">{w.title}</Link>
            {w.age && <span className="shrink-0 font-mono text-meta text-text-muted">{w.age}</span>}
          </li>
        ))}
      </ol>
      {lane.holder && lane.stuckFor && (
        <ReleaseLaneControl stuckFor={lane.stuckFor} confirming={confirming} busy={busy} error={error} onRelease={onRelease} onConfirm={onConfirm} onCancel={onCancel} />
      )}
    </div>
  );
}

export function LaneSheet({ lane, onClose, onDone }: { lane: HealthQueueLane | null; onClose: () => void; onDone: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setConfirming(false); setError(null); }, [lane?.lane, lane?.workspaceId]);

  async function release() {
    if (!lane?.holder) return;
    setBusy(true);
    setError(null);
    const message = await releaseLaneRequest(lane.workspaceId, lane.lane, lane.holder.taskId, `Released from Health › Queue after ${lane.stuckFor ?? 'no activity'}`);
    setBusy(false);
    if (message) { setError(message); return; }
    onDone();
    onClose();
  }

  return (
    <Sheet open={!!lane} onClose={onClose} title={lane ? `${lane.name} lane` : 'Lane'} trapFocus testId="queue-lane">
      {lane && (
        <LaneBody lane={lane} confirming={confirming} busy={busy} error={error} onRelease={() => setConfirming(true)} onConfirm={release} onCancel={() => setConfirming(false)} />
      )}
    </Sheet>
  );
}
