'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { subscribeToChannel, unsubscribeFromChannel } from '@/lib/pusher-client';
import WorkerActivityTimeline from './WorkerActivityTimeline';
import InstructionHistory from './InstructionHistory';
import InstructWorkerForm from './InstructWorkerForm';
import StatusBadge from '@/components/StatusBadge';
import TeamPanel from './TeamPanel';


type Milestone =
  | { type: 'phase'; label: string; toolCount: number; ts: number; pending?: boolean }
  | { type: 'status'; label: string; progress?: number; ts: number }
  | { type: 'checkpoint'; event: string; label: string; ts: number }
  | { type: 'action'; label: string; ts: number };

interface Worker {
  id: string;
  name: string;
  branch: string;
  status: string;
  currentAction: string | null;
  milestones: Milestone[];
  turns: number;
  costUsd: string | null;
  inputTokens: number;
  outputTokens: number;
  startedAt: string | null;
  prUrl: string | null;
  prNumber: number | null;
  localUiUrl: string | null;
  commitCount: number | null;
  filesChanged: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  lastCommitSha: string | null;
  waitingFor: { type: string; prompt: string; options?: string[] } | null;
  instructionHistory: Array<{ message: string; timestamp: number; type: 'instruction' | 'response' }>;
  pendingInstructions: string | null;
  account?: { authType: string } | null;
  resultMeta?: {
    stopReason: string | null;
    durationMs: number;
    durationApiMs: number;
    numTurns: number;
    modelUsage: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number }>;
    permissionDenials?: Array<{ tool: string; reason: string }>;
  } | null;
}

interface Props {
  initialWorker: Worker;
  statusColors?: Record<string, string>;
}

// Probe direct connection to local-ui and cache viewer token
function useDirectConnect(localUiUrl: string | null) {
  const [status, setStatus] = useState<'checking' | 'connected' | 'unavailable'>('checking');
  const viewerTokenRef = useRef<string | null>(null);

  useEffect(() => {
    if (!localUiUrl) {
      setStatus('unavailable');
      return;
    }

    // Mixed content: HTTPS dashboard can't reach HTTP local-ui
    if (typeof window !== 'undefined' && window.location.protocol === 'https:' && localUiUrl.startsWith('http://')) {
      setStatus('unavailable');
      return;
    }

    let cancelled = false;

    const url = localUiUrl; // capture for closure narrowing

    async function probe() {
      try {
        // Fetch viewer token from heartbeat data
        const activeRes = await fetch('/api/workers/active');
        if (activeRes.ok) {
          const data = await activeRes.json();
          const match = (data.activeLocalUis || []).find(
            (ui: { localUiUrl: string; viewerToken?: string }) => ui.localUiUrl === url
          );
          if (match?.viewerToken) {
            viewerTokenRef.current = match.viewerToken;
          }
        }

        // Ping local-ui health endpoint
        const healthUrl = new URL('/health', url);
        if (viewerTokenRef.current) {
          healthUrl.searchParams.set('token', viewerTokenRef.current);
        }
        const res = await fetch(healthUrl.toString(), {
          signal: AbortSignal.timeout(3000),
          mode: 'cors',
        });
        if (!cancelled && res.ok) {
          setStatus('connected');
        } else if (!cancelled) {
          setStatus('unavailable');
        }
      } catch {
        if (!cancelled) setStatus('unavailable');
      }
    }

    probe();
    return () => { cancelled = true; };
  }, [localUiUrl]);

  // Send message directly to local-ui, returns true on success
  const sendDirect = useCallback(async (workerId: string, message: string): Promise<boolean> => {
    if (status !== 'connected' || !localUiUrl) return false;
    try {
      const sendUrl = new URL(`/api/workers/${workerId}/send`, localUiUrl);
      if (viewerTokenRef.current) {
        sendUrl.searchParams.set('token', viewerTokenRef.current);
      }
      const res = await fetch(sendUrl.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
        signal: AbortSignal.timeout(5000),
        mode: 'cors',
      });
      return res.ok;
    } catch {
      return false;
    }
  }, [status, localUiUrl]);

  return { status, sendDirect, viewerToken: viewerTokenRef.current, localUiUrl };
}

function RequestPlanButton({ workerId }: { workerId: string }) {
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  async function handleRequestPlan() {
    setLoading(true);
    setShowConfirm(false);
    try {
      const res = await fetch(`/api/workers/${workerId}/instruct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'request_plan',
          message: 'Please pause implementation and submit a plan for review before continuing.',
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to request plan');
      }
      setSent(true);
      setTimeout(() => setSent(false), 5000);
    } catch (err) {
      console.error('Failed to request plan:', err);
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <span className="px-3 py-2 text-xs text-status-warning font-mono">
        Plan requested
      </span>
    );
  }

  if (showConfirm) {
    return (
      <div className="flex flex-col gap-2">
        <div className="text-xs text-text-primary max-w-md">
          <p className="mb-1 font-medium">Request Plan Mode?</p>
          <p className="mb-2 text-text-secondary">The agent will pause, investigate the codebase, and write a plan in the output below. You'll then see a prompt to approve or request changes before it continues.</p>
          <p className="text-text-muted text-[11px]">The session stays alive — no restart needed.</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleRequestPlan}
            disabled={loading}
            className="px-3 py-1.5 text-xs bg-status-warning text-surface-1 rounded hover:opacity-90 disabled:opacity-50"
          >
            Confirm
          </button>
          <button
            onClick={() => setShowConfirm(false)}
            className="px-3 py-1.5 text-xs border border-border-default text-text-secondary rounded hover:bg-surface-3"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      onClick={() => setShowConfirm(true)}
      disabled={loading}
      className="px-3 py-2 text-xs border border-status-warning/30 text-status-warning rounded hover:bg-status-warning/10 disabled:opacity-50 whitespace-nowrap"
      title="Ask the agent to pause and propose a plan before continuing implementation"
    >
      {loading ? '...' : 'Request Plan'}
    </button>
  );
}

export default function RealTimeWorkerView({ initialWorker, statusColors }: Props) {
  const [worker, setWorker] = useState<Worker>(initialWorker);
  const [answerSending, setAnswerSending] = useState<string | null>(null);
  const [answerSent, setAnswerSent] = useState(false);
  const [showAbortConfirm, setShowAbortConfirm] = useState(false);
  const [abortLoading, setAbortLoading] = useState(false);
  const [interruptMode, setInterruptMode] = useState(false);
  const { status: directStatus, sendDirect, viewerToken, localUiUrl: resolvedLocalUiUrl } = useDirectConnect(worker.localUiUrl);

  // Subscribe to real-time updates
  useEffect(() => {
    const channelName = `worker-${worker.id}`;
    console.log('[RealTimeWorkerView] Setting up subscription for:', channelName);
    const channel = subscribeToChannel(channelName);

    if (channel) {
      const handleUpdate = (data: { worker: Worker }) => {
        console.log('[RealTimeWorkerView] Received update:', data.worker?.status);
        setWorker(data.worker);
      };

      channel.bind('worker:progress', handleUpdate);
      channel.bind('worker:completed', handleUpdate);
      channel.bind('worker:failed', handleUpdate);

      return () => {
        channel.unbind('worker:progress', handleUpdate);
        channel.unbind('worker:completed', handleUpdate);
        channel.unbind('worker:failed', handleUpdate);
        unsubscribeFromChannel(channelName);
      };
    } else {
      console.warn('[RealTimeWorkerView] No channel returned - Pusher not configured?');
    }
  }, [worker.id]);

  // Send answer: try direct connect first, fall back to server instruct
  async function handleAnswer(option: string) {
    setAnswerSending(option);
    try {
      // Try direct connection first (instant delivery via Tailscale/LAN)
      const directOk = await sendDirect(worker.id, option);
      if (directOk) {
        setAnswerSent(true);
        setTimeout(() => setAnswerSent(false), 3000);
        return;
      }

      // Fall back to server-side instruct endpoint (queued delivery)
      const res = await fetch(`/api/workers/${worker.id}/instruct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: option }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to send answer');
      }
      setAnswerSent(true);
      setTimeout(() => setAnswerSent(false), 3000);
    } catch (err) {
      console.error('Failed to send answer:', err);
    } finally {
      setAnswerSending(null);
    }
  }

  async function handleAbort() {
    setAbortLoading(true);
    try {
      const res = await fetch(`/api/workers/${worker.id}/cmd`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'abort' }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to abort');
      }
      setShowAbortConfirm(false);
    } catch (err) {
      console.error('Failed to abort worker:', err);
    } finally {
      setAbortLoading(false);
    }
  }

  async function handleInterruptSend(message: string) {
    try {
      const res = await fetch(`/api/workers/${worker.id}/instruct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, priority: 'urgent' }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to send interrupt');
      }
      setInterruptMode(false);
    } catch (err) {
      console.error('Failed to send interrupt:', err);
    }
  }

  const isActive = ['running', 'starting', 'waiting_input', 'awaiting_plan_approval'].includes(worker.status);

  return (
    <div className="border border-border-default bg-surface-2 rounded-md p-4">
      <div className="flex justify-between items-start mb-3">
        <div>
          <h3 className="font-medium text-lg">{worker.name}</h3>
          <p className="text-sm text-text-secondary font-mono">Branch: {worker.branch}</p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={worker.status} />
          {isActive && worker.status !== 'starting' && (
            <>
              <button
                data-testid="worker-interrupt-btn"
                onClick={() => setInterruptMode(!interruptMode)}
                className="px-2.5 py-1 text-[11px] font-medium border border-status-warning/30 text-status-warning rounded hover:bg-status-warning/10 transition-colors"
                title="Send an urgent message to interrupt the agent"
              >
                Interrupt
              </button>
              {showAbortConfirm ? (
                <span className="flex items-center gap-1">
                  <button
                    onClick={handleAbort}
                    disabled={abortLoading}
                    className="px-2.5 py-1 text-[11px] font-medium bg-status-error text-white rounded hover:opacity-90 disabled:opacity-50"
                  >
                    {abortLoading ? '...' : 'Confirm'}
                  </button>
                  <button
                    onClick={() => setShowAbortConfirm(false)}
                    className="px-2 py-1 text-[11px] text-text-muted hover:text-text-primary"
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  data-testid="worker-abort-btn"
                  onClick={() => setShowAbortConfirm(true)}
                  className="px-2.5 py-1 text-[11px] font-medium border border-status-error/30 text-status-error rounded hover:bg-status-error/10 transition-colors"
                  title="Stop the worker immediately"
                >
                  Abort
                </button>
              )}
            </>
          )}
          {worker.localUiUrl && (
            <div className={`flex items-center gap-1.5${/^https?:\/\/(localhost|127\.0\.0\.1)/.test(worker.localUiUrl) ? ' hidden sm:flex' : ''}`}>
              {directStatus === 'connected' && (
                <span
                  className="flex items-center gap-1 px-2 py-1 text-[10px] text-status-success bg-status-success/10 border border-status-success/20 rounded-full font-mono"
                  title="Direct connection to local-ui available (Tailscale/LAN)"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-status-success" />
                  Direct
                </span>
              )}
              <a
                href={`${worker.localUiUrl}/worker/${worker.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-1 text-xs bg-surface-3 text-text-secondary rounded-full hover:bg-surface-4"
              >
                Open Terminal
              </a>
            </div>
          )}
        </div>
      </div>

      {/* Current action */}
      {worker.currentAction && (
        <div className="mb-3 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full border-2 border-status-running border-t-transparent animate-spin" aria-hidden="true" />
          <p className="text-sm text-text-secondary">{worker.currentAction}</p>
        </div>
      )}

      {/* Interrupt input form */}
      {interruptMode && (
        <div className="mb-3 border border-status-warning/30 bg-status-warning/5 rounded-md p-3">
          <div className="flex items-center gap-2 mb-2">
            <span className="font-mono text-[10px] font-medium text-status-warning uppercase tracking-[2.5px]">Interrupt</span>
            <span className="text-[10px] text-text-muted">Message delivered instantly via Pusher</span>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.target as HTMLFormElement;
              const input = form.elements.namedItem('interruptMsg') as HTMLInputElement;
              if (input.value.trim()) handleInterruptSend(input.value.trim());
            }}
            className="flex gap-2"
          >
            <input
              name="interruptMsg"
              type="text"
              autoFocus
              placeholder="e.g., Stop what you're doing and focus on..."
              className="flex-1 px-3 py-2 text-sm border border-border-default rounded-md bg-surface-1 focus:ring-2 focus:ring-status-warning/50 focus:border-status-warning"
            />
            <button
              type="submit"
              className="px-4 py-2 text-sm bg-status-warning text-white rounded-md hover:opacity-90"
            >
              Send
            </button>
            <button
              type="button"
              onClick={() => setInterruptMode(false)}
              className="px-3 py-2 text-sm text-text-muted hover:text-text-primary"
            >
              Cancel
            </button>
          </form>
        </div>
      )}

      {/* Waiting for input banner — skip for plan_approval (handled by PlanReviewPanel) */}
      {worker.status === 'waiting_input' && worker.waitingFor && worker.waitingFor.type !== 'plan_approval' && (
        <div
          data-testid="worker-needs-input-banner"
          className="mb-3 border border-status-warning/30 bg-status-warning/5 rounded-md p-3"
        >
          <div className="flex items-center gap-2 mb-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-status-warning opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-status-warning" />
            </span>
            <span data-testid="worker-needs-input-label" className="font-mono text-[10px] font-medium text-status-warning uppercase tracking-[2.5px]">Needs input</span>
            {directStatus === 'connected' && (
              <span className="text-[10px] text-status-success font-mono">instant delivery</span>
            )}
          </div>
          <p data-testid="worker-needs-input-prompt" className="text-sm text-text-primary">{worker.waitingFor.prompt}</p>
          {answerSent ? (
            <p className="mt-2 text-sm text-status-success">Answer sent</p>
          ) : worker.waitingFor.options && worker.waitingFor.options.length > 0 ? (
            <div data-testid="worker-needs-input-options" className="flex flex-wrap gap-2 mt-3">
              {worker.waitingFor.options.map((opt, i) => (
                <button
                  key={i}
                  onClick={() => handleAnswer(opt)}
                  disabled={answerSending !== null}
                  className="px-3 py-1.5 text-xs bg-surface-3 text-text-primary rounded border border-border-default hover:bg-surface-4 hover:border-text-muted transition-colors disabled:opacity-50 cursor-pointer"
                >
                  {answerSending === opt ? 'Sending...' : opt}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      )}

      {/* Last question context (visible on completed/failed workers) */}
      {!isActive && worker.waitingFor && (
        <div className="mb-3 border border-border-default bg-surface-3 rounded-md p-3">
          <p className="font-mono text-[10px] font-medium text-text-muted uppercase tracking-[2.5px] mb-1">Last question before {worker.status === 'completed' ? 'completion' : 'failure'}</p>
          <p className="text-sm text-text-primary">{worker.waitingFor.prompt}</p>
        </div>
      )}

      {/* Activity Timeline */}
      <WorkerActivityTimeline
        milestones={worker.milestones || []}
        currentAction={isActive ? worker.currentAction : undefined}
      />

      {/* Team Panel (P2P — fetches directly from local-ui) */}
      {directStatus === 'connected' && resolvedLocalUiUrl && (
        <TeamPanel
          localUiUrl={resolvedLocalUiUrl}
          viewerToken={viewerToken}
          workerId={worker.id}
        />
      )}

      {/* Stats row */}
      <div className="flex items-center gap-4 mt-3 font-mono text-xs text-text-muted">
        <span>Turns: {worker.turns}</span>
        {worker.account?.authType === 'oauth' ? (
          <span>
            {((worker.inputTokens || 0) + (worker.outputTokens || 0)).toLocaleString()} tokens
          </span>
        ) : (
          <span>Cost: ${parseFloat(worker.costUsd || '0').toFixed(4)}</span>
        )}
        {worker.startedAt && (
          <span title={`Started: ${new Date(worker.startedAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' })}`}>
            {Math.round((Date.now() - new Date(worker.startedAt).getTime()) / 60000)}m elapsed
          </span>
        )}
        {worker.prUrl && (
          <a
            href={worker.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-status-success hover:underline"
          >
            PR #{worker.prNumber}
          </a>
        )}
      </div>

      {/* Git stats */}
      {((worker.commitCount ?? 0) > 0 || (worker.filesChanged ?? 0) > 0) && (
        <div className="flex items-center gap-4 mt-2 font-mono text-xs">
          {(worker.commitCount ?? 0) > 0 && (
            <span className="text-text-muted">
              {worker.commitCount} commit{worker.commitCount !== 1 ? 's' : ''}
            </span>
          )}
          {(worker.filesChanged ?? 0) > 0 && (
            <span className="text-text-muted">
              {worker.filesChanged} file{worker.filesChanged !== 1 ? 's' : ''}
            </span>
          )}
          {((worker.linesAdded ?? 0) > 0 || (worker.linesRemoved ?? 0) > 0) && (
            <span>
              <span className="text-status-success">+{worker.linesAdded ?? 0}</span>
              {' / '}
              <span className="text-status-error">-{worker.linesRemoved ?? 0}</span>
            </span>
          )}
          {worker.lastCommitSha && (
            <span className="text-text-muted">
              {worker.lastCommitSha.slice(0, 7)}
            </span>
          )}
        </div>
      )}

      {/* Per-model usage breakdown */}
      {worker.resultMeta?.modelUsage && Object.keys(worker.resultMeta.modelUsage).length > 0 && (
        <div className="mt-3 p-3 bg-surface-3 rounded-[8px] border border-border-default/50">
          <div className="font-mono text-[10px] uppercase tracking-[1.5px] text-text-muted mb-2">Model Usage</div>
          <div className="space-y-1.5">
            {Object.entries(worker.resultMeta.modelUsage).map(([model, usage]) => (
              <div key={model} className="flex items-center justify-between font-mono text-[11px]">
                <span className="text-text-secondary">{model.replace('claude-', '').replace(/-\d{8}$/, '')}</span>
                <div className="flex items-center gap-3 text-text-muted">
                  <span>{((usage.inputTokens + usage.cacheReadInputTokens) / 1000).toFixed(0)}k in</span>
                  <span>{(usage.outputTokens / 1000).toFixed(0)}k out</span>
                  {usage.cacheReadInputTokens > 0 && (
                    <span className="text-status-success">{(usage.cacheReadInputTokens / 1000).toFixed(0)}k cached</span>
                  )}
                  {usage.costUSD > 0 && <span>${usage.costUSD.toFixed(4)}</span>}
                </div>
              </div>
            ))}
          </div>
          {(worker.resultMeta.durationMs > 0 || worker.resultMeta.durationApiMs > 0) && (
            <div className="flex items-center gap-3 mt-2 pt-2 border-t border-border-default/30 font-mono text-[10px] text-text-muted">
              {worker.resultMeta.durationMs > 0 && <span>Total: {(worker.resultMeta.durationMs / 1000).toFixed(0)}s</span>}
              {worker.resultMeta.durationApiMs > 0 && <span>API: {(worker.resultMeta.durationApiMs / 1000).toFixed(0)}s</span>}
              {worker.resultMeta.stopReason && worker.resultMeta.stopReason !== 'end_turn' && (
                <span className="text-status-warning">Stop: {worker.resultMeta.stopReason}</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Instruction history and input */}
      {isActive && (
        <>
          <InstructionHistory
            history={worker.instructionHistory || []}
            pendingInstruction={worker.pendingInstructions}
          />
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <InstructWorkerForm
                workerId={worker.id}
                pendingInstructions={null}
              />
            </div>
            {worker.status === 'running' && (
              <RequestPlanButton workerId={worker.id} />
            )}
          </div>
        </>
      )}
    </div>
  );
}
