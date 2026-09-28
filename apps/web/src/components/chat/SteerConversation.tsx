'use client';

/**
 * The chat canvas, rescoped to steer one running worker instead of talking
 * with an agent (docs/design/chat-canvas.md's "Ask about this task", but for
 * telling it something) — from a running task's card/row (the tasks list,
 * Board tiles, home's fleet slot). No LLM turn happens here: every send goes
 * straight to the worker's instruction queue (`POST /api/workers/[id]/instruct`,
 * priority `urgent` — the same path the task page's own WorkerSteerPanel
 * uses), and the feed is the task's own message history
 * (`GET /api/tasks/[id]/messages`), not a conversation transcript.
 *
 * The box, the message list with sent / delivered, the header and the
 * presence strip are the kit's `SteerComposer` (@builddai/ai-kit/chat/react).
 * buildd keeps the instruct route, the polling, who may steer, and the
 * presence it shows (`steerPresence`: runner, last heartbeat, current action).
 */
import { useCallback, useEffect, useState } from 'react';
import { SteerComposer, steerTitle, type SteerMessage, type SteerPresenceItem } from '@builddai/ai-kit/chat/react';
import { taskDisplayLabel } from '@buildd/core/task-label';
import type { InstructionHistoryEntry } from '@/lib/worker-instructions';
import { messageDeliveryStatus } from '@/lib/worker-instructions';
import { steerPresence } from '@/lib/chat/steer-presence';
import { ObjectStoreProvider, useObjectEntry } from './objects/ObjectStoreProvider';
import type { BuilddObjectRef } from './chat-contract';

interface TaskMessagesResponse {
  taskId: string;
  workerId: string | null;
  /** Caller may send (workspace admin), by the instruct route's own rule. */
  canSend: boolean;
  messages: InstructionHistoryEntry[];
}

const NO_AGENT = 'No agent is running on this task right now.';

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** The task's instructions as the kit's list: the text (hidden in a sensitive workspace) and its delivery. */
export function steerMessages(entries: readonly InstructionHistoryEntry[]): SteerMessage[] {
  return entries.map((m, i) => ({ id: `${m.timestamp ?? i}-${i}`, text: m.message ?? null, status: messageDeliveryStatus(m).state }));
}

/** Why nobody can steer right now, or null. */
export function steerBlockedReason(data: Pick<TaskMessagesResponse, 'workerId' | 'canSend'> | null): string | null {
  if (!data?.workerId) return NO_AGENT;
  if (!data.canSend) return 'Only workspace admins can steer this agent.';
  return null;
}

function SteerBody({ taskId, onClose }: { taskId: string; onClose(): void }) {
  const objRef: BuilddObjectRef = { kind: 'task', id: taskId, workspaceId: null, fallbackText: 'This task' };
  const { view } = useObjectEntry(objRef);
  const [data, setData] = useState<TaskMessagesResponse | null>(null);
  const now = useNow(30_000);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/messages`, { credentials: 'include' });
      if (!res.ok) return;
      const body = await res.json();
      setData({ taskId, workerId: body.workerId ?? null, canSend: body.canSend === true, messages: Array.isArray(body.messages) ? body.messages : [] });
    } catch { /* keep the last good copy */ }
  }, [taskId]);

  useEffect(() => { load(); }, [load]);
  // Delivery/read status changes out of band (the runner's own check-in), and
  // there's no per-message realtime event for it yet — poll while the canvas
  // is open, the same tradeoff the task page's own instruction history makes.
  useEffect(() => {
    const id = setInterval(load, 5_000);
    return () => clearInterval(id);
  }, [load]);

  const task = view?.kind === 'task' ? view : null;
  const taskLabel = task ? taskDisplayLabel({ title: task.title, label: null }).label : objRef.fallbackText;
  const presence = steerPresence(
    { runner: task?.worker?.runner ?? null },
    { lastHeartbeatAt: task?.worker?.updatedAt ?? null, now, currentAction: task?.worker?.currentAction ?? null },
  );
  const items: SteerPresenceItem[] = [
    ...(presence.runnerLabel ? [{ key: 'runner', label: presence.runnerLabel, tone: 'strong' as const }] : []),
    ...(presence.heartbeatLabel ? [{ key: 'heartbeat', label: presence.heartbeatLabel, tone: 'muted' as const }] : []),
    ...(presence.actionLabel ? [{ key: 'action', label: presence.actionLabel, tone: 'live' as const }] : []),
  ];
  const workerId = data?.workerId ?? null;

  const send = async (text: string) => {
    if (!workerId) return;
    const res = await fetch(`/api/workers/${workerId}/instruct`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ message: text, priority: 'urgent' }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error ?? 'Failed to send');
    await load();
  };

  return (
    <SteerComposer
      className="buildd-steer"
      title={steerTitle(task?.roleName ?? null, task?.worker?.runner ?? null, taskLabel)}
      presence={presence.runnerLabel || presence.actionLabel ? items : []}
      idlePresence={NO_AGENT}
      onClose={onClose}
      onSend={send}
      messages={steerMessages(data?.messages ?? [])}
      blockedReason={steerBlockedReason(data)}
      hiddenText="(hidden in a sensitive workspace)"
    />
  );
}

export default function SteerConversation({ taskId, onClose }: { taskId: string; onClose(): void }) {
  return (
    <ObjectStoreProvider>
      <SteerBody taskId={taskId} onClose={onClose} />
    </ObjectStoreProvider>
  );
}
