'use client';

import { useState, useEffect, useRef } from 'react';
import { subscribeToChannel, unsubscribeFromChannel, CHANNEL_PREFIX } from '@/lib/pusher-client';
import WorkerActivityTimeline from './WorkerActivityTimeline';
import InstructionHistory from './InstructionHistory';
import InstructWorkerForm from './InstructWorkerForm';
import StatusBadge from '@/components/StatusBadge';


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
  waitingFor: { type: string; prompt: string; options?: (string | { label: string; description?: string; recommended?: boolean })[] } | null;
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


interface TaskProgressEntry {
  taskId: string;
  agentName: string | null;
  toolCount: number;
  durationMs: number;
  cumulativeUsage: { inputTokens: number; outputTokens: number; costUsd: number } | null;
}

export default function RealTimeWorkerView({ initialWorker, statusColors }: Props) {
  const [worker, setWorker] = useState<Worker>(initialWorker);
  const [answerSending, setAnswerSending] = useState<string | null>(null);
  const [answerSent, setAnswerSent] = useState(false);
  const answeredPromptRef = useRef<string | null>(null);
  const [showAbortConfirm, setShowAbortConfirm] = useState(false);
  const [abortLoading, setAbortLoading] = useState(false);
  const [interruptMode, setInterruptMode] = useState(false);
  const [showMetricsDetail, setShowMetricsDetail] = useState(false);
  const [taskProgress, setTaskProgress] = useState<TaskProgressEntry[]>([]);

  // Subscribe to real-time updates
  useEffect(() => {
    const channelName = `${CHANNEL_PREFIX}worker-${worker.id}`;
    console.log('[RealTimeWorkerView] Setting up subscription for:', channelName);
    const channel = subscribeToChannel(channelName);

    if (channel) {
      const handleUpdate = (data: { worker: Worker; taskProgress?: TaskProgressEntry[] }) => {
        console.log('[RealTimeWorkerView] Received update:', data.worker?.status);
        // Clear answerSent when the worker's prompt changes or waitingFor clears
        const newPrompt = data.worker?.waitingFor?.prompt ?? null;
        if (answeredPromptRef.current && newPrompt !== answeredPromptRef.current) {
          answeredPromptRef.current = null;
          setAnswerSent(false);
        }
        if (!data.worker || typeof data.worker !== 'object') return;
        setWorker(data.worker);
        if (data.taskProgress) {
          setTaskProgress(data.taskProgress);
        } else {
          setTaskProgress([]);
        }
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

  // Send answer via respond endpoint — creates a fresh task from the existing worktree.
  // More stable than /instruct (which requires the session to be alive).
  async function handleAnswer(option: string) {
    setAnswerSending(option);
    try {
      const res = await fetch(`/api/workers/${worker.id}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: option }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to send answer');
      }
      answeredPromptRef.current = worker.waitingFor?.prompt ?? null;
      setAnswerSent(true);
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

  const isActive = ['running', 'starting', 'waiting_input'].includes(worker.status);

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
        </div>
      </div>

      {/* Current action */}
      {worker.currentAction && (
        <div className="mb-3 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full border-2 border-status-running border-t-transparent animate-spin" aria-hidden="true" />
          <p className="text-sm text-text-secondary">{worker.currentAction}</p>
        </div>
      )}

      {/* Subagent progress indicator */}
      {taskProgress.length > 0 && isActive && (
        <div className="mb-3 p-2.5 bg-surface-3 rounded-md border border-border-default/50">
          <div className="font-mono text-[10px] uppercase tracking-[1.5px] text-text-muted mb-1.5">Background Agents</div>
          <div className="space-y-1">
            {taskProgress.map((tp) => (
              <div key={tp.taskId} className="flex items-center justify-between font-mono text-[11px]">
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-status-running animate-pulse" />
                  <span className="text-text-secondary">{tp.agentName || tp.taskId.slice(0, 8)}</span>
                </div>
                <div className="flex items-center gap-3 text-text-muted">
                  <span>{tp.toolCount} tool{tp.toolCount !== 1 ? 's' : ''}</span>
                  <span>{Math.round(tp.durationMs / 1000)}s</span>
                  {tp.cumulativeUsage?.costUsd != null && tp.cumulativeUsage.costUsd > 0 && (
                    <span>${tp.cumulativeUsage.costUsd.toFixed(4)}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
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

      {/* Waiting for input banner */}
      {worker.status === 'waiting_input' && worker.waitingFor && (
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
          </div>
          <p data-testid="worker-needs-input-prompt" className="text-sm text-text-primary">{worker.waitingFor.prompt}</p>
          {answerSent ? (
            <p className="mt-2 text-sm text-status-success">Answer sent — a new task has been created to continue</p>
          ) : worker.waitingFor.options && worker.waitingFor.options.length > 0 ? (
            <div data-testid="worker-needs-input-options" className="flex flex-col gap-2 mt-3">
              {worker.waitingFor.options.map((opt, i) => {
                const label = typeof opt === 'string' ? opt : opt.label;
                const description = typeof opt === 'string' ? undefined : opt.description;
                const recommended = typeof opt === 'string' ? false : opt.recommended;
                return (
                  <button
                    key={i}
                    onClick={() => handleAnswer(label)}
                    disabled={answerSending !== null}
                    className="text-left px-3 py-2 text-sm bg-surface-3 text-text-primary rounded border border-border-default hover:bg-surface-4 hover:border-text-muted transition-colors disabled:opacity-50 cursor-pointer"
                  >
                    <span className="flex items-center gap-2">
                      <span className="font-medium">{answerSending === label ? 'Sending...' : label}</span>
                      {recommended && (
                        <span className="text-[10px] font-mono uppercase tracking-wider text-status-success bg-status-success/10 px-1.5 py-0.5 rounded">Recommended</span>
                      )}
                    </span>
                    {description && (
                      <span className="block mt-0.5 text-xs text-text-muted">{description}</span>
                    )}
                  </button>
                );
              })}
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


      {/* Stats row */}
      <div className="flex items-center gap-4 mt-3 font-mono text-xs text-text-muted">
        <span>Turns: {worker.turns}</span>
        {worker.account?.authType === 'oauth'
          ? ((worker.inputTokens || 0) + (worker.outputTokens || 0)) > 0 && (
              <span>
                {((worker.inputTokens || 0) + (worker.outputTokens || 0)).toLocaleString()} tokens
              </span>
            )
          : parseFloat(worker.costUsd || '0') > 0 && (
              <span>Cost: ${parseFloat(worker.costUsd || '0').toFixed(4)}</span>
            )
        }
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

      {/* Git stats & model usage — always visible on desktop, collapsible on mobile */}
      {(((worker.commitCount ?? 0) > 0 || (worker.filesChanged ?? 0) > 0) ||
        (worker.resultMeta?.modelUsage && Object.keys(worker.resultMeta.modelUsage).length > 0)) && (
        <>
          {/* Mobile: collapsible toggle */}
          <button
            onClick={() => setShowMetricsDetail(!showMetricsDetail)}
            className="md:hidden flex items-center gap-1.5 mt-3 text-xs text-text-muted hover:text-text-secondary transition-colors"
          >
            <svg
              className={`w-3 h-3 transition-transform ${showMetricsDetail ? 'rotate-90' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            Details
          </button>

          <div className={`${showMetricsDetail ? '' : 'hidden'} md:block`}>
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
                  {Object.entries(worker.resultMeta.modelUsage).map(([model, usage]) => {
                    if (!usage || typeof usage !== 'object') return null;
                    const inp = usage.inputTokens || 0;
                    const cached = usage.cacheReadInputTokens || 0;
                    const out = usage.outputTokens || 0;
                    const cost = usage.costUSD || 0;
                    return (
                    <div key={model} className="flex items-center justify-between font-mono text-[11px]">
                      <span className="text-text-secondary">{model.replace('claude-', '').replace(/-\d{8}$/, '')}</span>
                      <div className="flex items-center gap-3 text-text-muted">
                        <span>{((inp + cached) / 1000).toFixed(0)}k in</span>
                        <span>{(out / 1000).toFixed(0)}k out</span>
                        {cached > 0 && (
                          <span className="text-status-success">{(cached / 1000).toFixed(0)}k cached</span>
                        )}
                        {cost > 0 && <span>${cost.toFixed(4)}</span>}
                      </div>
                    </div>
                    );
                  })}
                </div>
                {((worker.resultMeta?.durationMs || 0) > 0 || (worker.resultMeta?.durationApiMs || 0) > 0) && (
                  <div className="flex items-center gap-3 mt-2 pt-2 border-t border-border-default/30 font-mono text-[10px] text-text-muted">
                    {(worker.resultMeta?.durationMs || 0) > 0 && <span>Total: {((worker.resultMeta?.durationMs || 0) / 1000).toFixed(0)}s</span>}
                    {(worker.resultMeta?.durationApiMs || 0) > 0 && <span>API: {((worker.resultMeta?.durationApiMs || 0) / 1000).toFixed(0)}s</span>}
                    {worker.resultMeta?.stopReason && worker.resultMeta.stopReason !== 'end_turn' && (
                      <span className="text-status-warning">Stop: {worker.resultMeta.stopReason}</span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* Instruction history and input */}
      {isActive && (
        <>
          <InstructionHistory
            history={worker.instructionHistory || []}
            pendingInstruction={worker.pendingInstructions}
          />
          <InstructWorkerForm
            workerId={worker.id}
            pendingInstructions={null}
          />
        </>
      )}
    </div>
  );
}
