'use client';

/**
 * The start flow behind every "Run now": the request, a gate refusal and what
 * it offers (Force start, start past the cap, switch backend, raise the cap),
 * and what happens after the server accepts (a runner claims it, or the task
 * waits at the front of the queue). Owned by `TaskActionZone`, the one
 * renderer, so the task sheet, the task page and the mission drawer share it.
 *
 * A 200 is never a failure: `/start` stamps `manualStartAt` and bumps the
 * priority, so the next claim cycle takes the task whether or not the Pusher
 * claim event reaches this tab. After ASSIGNMENT_TIMEOUT_MS without a claim the
 * state degrades to `queued`, with the runner fleet's liveness.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribeToChannel, unsubscribeFromChannel, getSubscribedChannel, CHANNEL_PREFIX } from '@/lib/pusher-client';
import {
  canOfferForce,
  fetchRunnerFleet,
  requestBackendSwitch,
  requestTaskStart,
  type GateRefusal,
  type RunnerFleetStatus,
  type StartRequest,
} from '@/lib/task-actions';

export type StartStatus = 'idle' | 'starting' | 'waiting' | 'queued' | 'accepted' | 'gated' | 'failed';

export const ASSIGNMENT_TIMEOUT_MS = 10_000;
const POLL_MS = 5_000;

export interface TaskStart {
  status: StartStatus;
  /** Which request is in flight, for the button that made it. */
  pending: 'start' | 'force' | 'exempt' | 'switch' | 'cap' | null;
  refusal: GateRefusal | null;
  error: string | null;
  fleet: RunnerFleetStatus | null;
  start(req?: StartRequest): Promise<void>;
  switchBackendAndStart(backend: string): Promise<void>;
  raiseCapAndStart(cap: number): Promise<void>;
  /** Close a refusal or an error and go back to idle. */
  dismiss(): void;
}

export function useTaskStart({ taskId, workspaceId, onStarted }: {
  taskId: string;
  workspaceId: string;
  /** After the server accepts the start (the host refetches). */
  onStarted?: () => void | Promise<void>;
}): TaskStart {
  const [status, setStatus] = useState<StartStatus>('idle');
  const [pending, setPending] = useState<TaskStart['pending']>(null);
  const [refusal, setRefusal] = useState<GateRefusal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fleet, setFleet] = useState<RunnerFleetStatus | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const channelRef = useRef<string | null>(null);
  // The workspace channel is shared with the layout providers, so the handler
  // has to be unbound by reference — releasing the subscription won't drop it.
  const handlerRef = useRef<((data: unknown) => void) | null>(null);
  const onStartedRef = useRef(onStarted);
  onStartedRef.current = onStarted;

  const stopTracking = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    if (!channelRef.current) return;
    const channel = getSubscribedChannel(channelRef.current);
    if (channel && handlerRef.current) channel.unbind('task:claimed', handlerRef.current);
    unsubscribeFromChannel(channelRef.current);
    channelRef.current = null;
    handlerRef.current = null;
  }, []);

  useEffect(() => stopTracking, [stopTracking]);

  const loadFleet = useCallback(() => {
    if (!workspaceId) return;
    void fetchRunnerFleet(workspaceId).then(setFleet);
  }, [workspaceId]);

  const track = useCallback(() => {
    stopTracking(); // a second start must not leave the first hold behind
    const startedAt = Date.now();
    const claimed = () => {
      stopTracking();
      setStatus('accepted');
      void onStartedRef.current?.();
    };
    if (workspaceId) {
      const name = `${CHANNEL_PREFIX}workspace-${workspaceId}`;
      const channel = subscribeToChannel(name);
      if (channel) {
        channelRef.current = name;
        const handler = (data: { task?: { id: string } }) => { if (data.task?.id === taskId) claimed(); };
        handlerRef.current = handler as (data: unknown) => void;
        channel.bind('task:claimed', handler);
      }
    }
    const poll = async () => {
      if (Date.now() - startedAt >= ASSIGNMENT_TIMEOUT_MS) {
        stopTracking();
        loadFleet();
        setStatus(s => (s === 'waiting' ? 'queued' : s));
        return;
      }
      try {
        const res = await fetch(`/api/tasks/${taskId}`);
        if (!res.ok) return;
        const task = await res.json();
        if (task?.status && task.status !== 'pending') claimed();
      } catch {
        // The timeout above still runs.
      }
    };
    pollRef.current = setInterval(poll, POLL_MS);
    void poll();
  }, [stopTracking, workspaceId, taskId, loadFleet]);

  const start = useCallback(async (req: StartRequest = {}) => {
    setPending(req.forceOverride ? 'force' : req.capExempt ? 'exempt' : 'start');
    setError(null);
    setStatus('starting');
    try {
      const out = await requestTaskStart(taskId, req);
      if (out.ok) {
        setRefusal(null);
        setFleet(null);
        setStatus('waiting');
        track();
        await onStartedRef.current?.();
        return;
      }
      if (out.refusal) {
        setRefusal(out.refusal);
        setStatus('gated');
        if (canOfferForce(out.refusal)) loadFleet();
        return;
      }
      setError(out.error);
      setStatus('failed');
    } finally {
      setPending(null);
    }
  }, [taskId, track, loadFleet]);

  const switchBackendAndStart = useCallback(async (backend: string) => {
    setPending('switch');
    const ok = await requestBackendSwitch(taskId, backend);
    if (!ok) {
      setPending(null);
      setError('Failed to switch backend');
      setStatus('failed');
      return;
    }
    await start();
  }, [taskId, start]);

  const raiseCapAndStart = useCallback(async (cap: number) => {
    setPending('cap');
    const res = await fetch(`/api/workspaces/${workspaceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxConcurrentTasks: cap }),
    }).catch(() => null);
    if (!res?.ok) {
      setPending(null);
      setError('Failed to update workspace limit');
      setStatus('failed');
      return;
    }
    await start();
  }, [workspaceId, start]);

  const dismiss = useCallback(() => {
    stopTracking();
    setStatus('idle');
    setRefusal(null);
    setError(null);
    setFleet(null);
  }, [stopTracking]);

  return { status, pending, refusal, error, fleet, start, switchBackendAndStart, raiseCapAndStart, dismiss };
}
