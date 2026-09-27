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
 * Reuses the canvas's own chrome (header, composer look, the object-card
 * eyebrow/state-chip family) so it feels like the same family as the
 * Organizer chat, rescoped to "<role> @ <runner> / <task label>" and a small
 * presence strip: runner, last heartbeat, turn, current action.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { taskDisplayLabel } from '@buildd/core/task-label';
import { Kbd } from '@/components/KeyHints';
import type { InstructionHistoryEntry, MessageDeliveryStatus } from '@/lib/worker-instructions';
import { messageDeliveryStatus } from '@/lib/worker-instructions';
import { steerPresence, steerTitle } from '@/lib/chat/steer-presence';
import { ObjectStoreProvider, useObjectEntry } from './objects/ObjectStoreProvider';
import type { BuilddObjectRef } from './chat-contract';
import { StateChip, type Tone } from './objects/parts';

interface TaskMessagesResponse {
  taskId: string;
  workerId: string | null;
  /** Caller may send (workspace admin), by the instruct route's own rule. */
  canSend: boolean;
  messages: InstructionHistoryEntry[];
}

const STATUS_LABEL: Record<MessageDeliveryStatus['state'], string> = { sent: 'Sent', delivered: 'Delivered' };
const STATUS_TONE: Record<MessageDeliveryStatus['state'], Tone> = { sent: 'idle', delivered: 'ok' };

export function statusLabel(s: MessageDeliveryStatus): string {
  return STATUS_LABEL[s.state];
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function SteerBody({ taskId, onClose }: { taskId: string; onClose(): void }) {
  const objRef: BuilddObjectRef = { kind: 'task', id: taskId, workspaceId: null, fallbackText: 'This task' };
  const { view } = useObjectEntry(objRef);
  const [data, setData] = useState<TaskMessagesResponse | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [data?.messages.length]);

  const task = view?.kind === 'task' ? view : null;
  const taskLabel = task ? taskDisplayLabel({ title: task.title, label: null }).label : objRef.fallbackText;
  const title = steerTitle(task?.roleName ?? null, task?.worker?.runner ?? null, taskLabel);
  const presence = steerPresence(
    { runner: task?.worker?.runner ?? null },
    { lastHeartbeatAt: task?.worker?.updatedAt ?? null, now, currentAction: task?.worker?.currentAction ?? null },
  );
  const workerId = data?.workerId ?? null;
  const allowed = !!data?.canSend;
  const canSend = !!workerId && allowed && !!draft.trim() && !sending;

  const send = async () => {
    const text = draft.trim();
    if (!text || !workerId || !allowed || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/workers/${workerId}/instruct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ message: text, priority: 'urgent' }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? 'Failed to send');
      setDraft('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send');
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <header data-testid="chat-header" className="flex min-h-14 items-center gap-2.5 border-b border-[var(--convo-line)] px-4 py-2.5 md:px-6">
        <nav aria-label="Steering" data-testid="canvas-crumbs" className="flex min-w-0 flex-1 items-center gap-2 font-mono text-[12.5px]">
          <span className="shrink-0 font-mono text-[11px] font-bold uppercase tracking-[1.6px] text-text-muted">Steer</span>
          <span aria-hidden="true" className="text-text-muted">/</span>
          <h1 data-testid="chat-title" className="min-w-0 truncate text-[14.5px] font-semibold text-text-primary md:text-[13px]">{title}</h1>
        </nav>
        <button
          type="button"
          data-testid="canvas-close"
          onClick={onClose}
          aria-label="Close steering"
          className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded-[10px] px-2 font-convo text-[18px] text-text-secondary hover:bg-[var(--convo-soft)] hover:text-text-primary md:min-h-10 md:min-w-10"
        >
          <Kbd>Esc</Kbd>
          <span aria-hidden="true">✕</span>
        </button>
      </header>

      {/* The presence strip: runner, freshness, turn, current action — the same square, hard-edged family as the pinned object strip. */}
      <div data-testid="steer-presence" className="flex min-h-11 shrink-0 items-center gap-3 overflow-x-auto border-b-2 border-border-strong bg-surface-1 px-4 py-2 font-mono text-[12px] text-text-secondary md:px-6">
        {presence.runnerLabel && <span data-testid="steer-runner" className="shrink-0 font-semibold text-text-primary">{presence.runnerLabel}</span>}
        {presence.heartbeatLabel && <span data-testid="steer-heartbeat" className="shrink-0 text-text-muted">{presence.heartbeatLabel}</span>}
        {presence.actionLabel && <span data-testid="steer-action" className="min-w-0 truncate text-status-info">{presence.actionLabel}</span>}
        {!presence.runnerLabel && !presence.actionLabel && <span className="text-text-muted">No agent is running on this task right now.</span>}
      </div>

      <div ref={scroller} data-testid="steer-feed" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 md:px-6">
        {(data?.messages ?? []).length === 0 && (
          <p className="font-convo text-[14px] text-text-muted">Nothing sent yet. Instructions go straight to the agent, with no approval step.</p>
        )}
        <ul className="space-y-3">
          {(data?.messages ?? []).map((m, i) => {
            const status = messageDeliveryStatus(m);
            return (
              <li key={i} data-testid="steer-message" data-status={status.state} className="border-2 border-border-strong bg-card px-3 py-2">
                <p className="font-convo text-[14px] text-text-primary [overflow-wrap:anywhere]">{m.message ?? '(hidden in a sensitive workspace)'}</p>
                <div className="mt-1.5 flex items-center gap-2">
                  <StateChip label={statusLabel(status)} tone={STATUS_TONE[status.state]} pulse={status.state === 'sent'} />
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="px-3 pb-3 pt-2 md:px-6 md:pb-5">
        <form
          onSubmit={(e) => { e.preventDefault(); send(); }}
          className="rounded-[16px] border-[1.5px] border-[var(--convo-line)] bg-surface-2 transition-colors focus-within:border-accent"
        >
          <label htmlFor="steer-composer-input" className="sr-only">Steer this agent</label>
          <textarea
            id="steer-composer-input"
            data-bare-input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
            }}
            placeholder={!workerId ? 'No agent is running on this task right now.' : allowed ? 'Steer this agent…' : 'Only workspace admins can steer this agent.'}
            disabled={!workerId || !allowed || sending}
            rows={2}
            className="w-full resize-none bg-transparent px-3.5 py-3 font-convo text-[15px] text-text-primary placeholder:text-text-muted focus:outline-none"
          />
          <div className="flex items-center justify-end gap-2 px-2 pb-2">
            <button
              type="submit"
              data-testid="steer-send"
              disabled={!canSend}
              className="inline-flex min-h-9 items-center rounded-[10px] bg-accent px-3.5 font-convo text-[13.5px] font-semibold text-[var(--on-accent)] hover:bg-primary-hover disabled:opacity-50"
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </form>
        {error && <p data-testid="steer-error" className="mt-1.5 font-convo text-[13px] text-status-error">{error}</p>}
      </div>
    </>
  );
}

export default function SteerConversation({ taskId, onClose }: { taskId: string; onClose(): void }) {
  return (
    <ObjectStoreProvider>
      <SteerBody taskId={taskId} onClose={onClose} />
    </ObjectStoreProvider>
  );
}
