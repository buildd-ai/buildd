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
  | { type: 'status'; label: string; progress?: number; ts: number };

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

export default function RealTimeWorkerView({ initialWorker, statusColors }: Props) {
  const [worker, setWorker] = useState<Worker>(initialWorker);
  const [answerSending, setAnswerSending] = useState<string | null>(null);
  const [answerSent, setAnswerSent] = useState(false);
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
