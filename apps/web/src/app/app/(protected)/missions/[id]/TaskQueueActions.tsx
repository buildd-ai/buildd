'use client';

/**
 * Health › Queue's two writes on the task itself (spec "Health › Queue" R-12:
 * every Queue action also exists on the task page). A task declared to wait on
 * another can drop that dependency with a reason; a task that holds a stuck
 * serial lane can release it. Same forms and requests as `QueueSheets`.
 */
import { useState } from 'react';
import type { WaitingReason } from '@buildd/core/waiting-reason';
import { ReleaseLaneControl, RemoveDependencyForm, releaseLaneRequest, removeDependencyRequest } from '../../health/queue/QueueSheets';

/** `3d`, `26h`: how long the holder's PR has been quiet. */
function quietFor(since: string, now = Date.now()): string {
  const hours = Math.max(0, Math.floor((now - new Date(since).getTime()) / 3_600_000));
  return hours >= 48 ? `${Math.floor(hours / 24)}d` : `${hours}h`;
}

function RemoveDependency({ taskId, blockerId, blockerLabel, onChanged }: { taskId: string; blockerId: string; blockerLabel: string | null; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    if (!reason.trim()) return;
    setBusy(true);
    setError(null);
    const message = await removeDependencyRequest(taskId, blockerId, reason);
    setBusy(false);
    if (message) { setError(message); return; }
    onChanged();
  }

  return (
    <div data-testid="task-remove-dependency" className="space-y-2">
      {open ? (
        <RemoveDependencyForm reason={reason} onReason={setReason} busy={busy} error={error} onRemove={remove} />
      ) : (
        <button type="button" className="btn h-11 md:h-8" onClick={() => setOpen(true)} data-testid="task-remove-dependency-open">
          Remove dependency{blockerLabel ? ` on ${blockerLabel}` : ''}…
        </button>
      )}
    </div>
  );
}

function ReleaseLane({ workspaceId, lane, holderTaskId, stuckSince, onChanged }: { workspaceId: string; lane: string; holderTaskId: string; stuckSince: string; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stuckFor = quietFor(stuckSince);

  async function release() {
    setBusy(true);
    setError(null);
    const message = await releaseLaneRequest(workspaceId, lane, holderTaskId, `Released from the task page after ${stuckFor} with no activity`);
    setBusy(false);
    if (message) { setError(message); return; }
    onChanged();
  }

  return (
    <div data-testid="task-release-lane">
      <ReleaseLaneControl stuckFor={stuckFor} confirming={confirming} busy={busy} error={error} onRelease={() => setConfirming(true)} onConfirm={release} onCancel={() => setConfirming(false)} />
    </div>
  );
}

/**
 * Renders nothing unless the task declares a dependency, or the lane it waits
 * in is held by a stuck holder. `taskId` is the waiting task.
 */
export default function TaskQueueActions({ taskId, workspaceId, reasons, onChanged }: { taskId: string; workspaceId: string; reasons: WaitingReason[]; onChanged: () => void }) {
  const deps = reasons.filter(r => r.kind === 'dep_declared' && r.blocker?.type === 'task' && r.blocker.id);
  const stuck = reasons.find(r => r.kind === 'lane' && r.lane?.holderTaskId && r.lane.stuckSince);
  if (deps.length === 0 && !stuck) return null;
  return (
    <div data-testid="task-queue-actions" className="space-y-3">
      {deps.map(r => (
        <RemoveDependency key={r.blocker!.id} taskId={taskId} blockerId={r.blocker!.id} blockerLabel={deps.length > 1 ? r.blocker!.label : null} onChanged={onChanged} />
      ))}
      {stuck?.lane && (
        <ReleaseLane workspaceId={workspaceId} lane={stuck.lane.lane} holderTaskId={stuck.lane.holderTaskId!} stuckSince={stuck.lane.stuckSince!} onChanged={onChanged} />
      )}
    </div>
  );
}
