'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { subscribeToChannel, unsubscribeFromChannel } from '@/lib/pusher-client';
import WorkerActivityTimeline from './WorkerActivityTimeline';
import InstructionHistory from './InstructionHistory';
import InstructWorkerForm from './InstructWorkerForm';


interface Worker {
  id: string;
  name: string;
  branch: string;
  status: string;
  currentAction: string | null;
  milestones: Array<{ label: string; timestamp: number }>;
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
  statusColors: Record<string, string>;
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

  return { status, sendDirect };
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
      <span className="px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
        Plan requested
      </span>
    );
  }

  if (showConfirm) {
    return (
      <div className="flex flex-col gap-2">
        <div className="text-xs text-gray-700 dark:text-gray-300 max-w-md">
          <p className="mb-1 font-medium">Request Plan Mode?</p>
          <p className="mb-2">The agent will pause, investigate the codebase, and write a plan in the output below. You'll then see a prompt to approve or request changes before it continues.</p>
          <p className="text-gray-500 dark:text-gray-400 text-[11px]">The session stays alive — no restart needed.</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleRequestPlan}
            disabled={loading}
            className="px-3 py-1.5 text-xs bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50"
          >
            Confirm
          </button>
          <button
            onClick={() => setShowConfirm(false)}
            className="px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800"
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
      className="px-3 py-2 text-xs border border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 rounded-lg hover:bg-amber-50 dark:hover:bg-amber-900/30 disabled:opacity-50 whitespace-nowrap"
      title="Ask the agent to pause and propose a plan before continuing implementation"
    >
      {loading ? '...' : 'Request Plan'}
    </button>
  );
}

export default function RealTimeWorkerView({ initialWorker, statusColors }: Props) {
  const [worker, setWorker] = useState<Worker>(initialWorker);
  const [actionLog, setActionLog] = useState<string[]>([]);
  const [answerSending, setAnswerSending] = useState<string | null>(null);
  const [answerSent, setAnswerSent] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);
  const { status: directStatus, sendDirect } = useDirectConnect(worker.localUiUrl);

  // Track action history for output display
  useEffect(() => {
    if (worker.currentAction) {
      setActionLog(prev => {
        const newLog = [...prev, `[${new Date().toLocaleTimeString()}] ${worker.currentAction}`];
        return newLog.slice(-50); // Keep last 50 lines
      });
    }
  }, [worker.currentAction]);

  // Auto-scroll output (respecting user scroll)
  useEffect(() => {
    const box = outputRef.current;
    if (box && !userScrolledRef.current) {
      box.scrollTop = box.scrollHeight;
    }
  }, [actionLog]);

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

  const handleScroll = () => {
    const box = outputRef.current;
    if (box) {
      const isAtBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 50;
      userScrolledRef.current = !isAtBottom;
    }
  };

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
    <div className="border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/30 rounded-lg p-4">
      <div className="flex justify-between items-start mb-3">
        <div>
          <h3 className="font-medium text-lg">{worker.name}</h3>
          <p className="text-sm text-gray-500">Branch: {worker.branch}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`px-2 py-1 text-xs rounded-full ${statusColors[worker.status] || statusColors.idle}`}>
            {worker.status}
          </span>
          {worker.localUiUrl && (
            <div className="flex items-center gap-1.5">
              {directStatus === 'connected' && (
                <span
                  className="flex items-center gap-1 px-2 py-1 text-[10px] text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 rounded-full"
                  title="Direct connection to local-ui available (Tailscale/LAN)"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  Direct
                </span>
              )}
              <a
                href={`${worker.localUiUrl}/worker/${worker.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-1 text-xs bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 rounded-full hover:bg-blue-200 dark:hover:bg-blue-800"
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
          <span className="w-2 h-2 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
          <p className="text-sm text-gray-600 dark:text-gray-400">{worker.currentAction}</p>
        </div>
      )}

      {/* Waiting for input banner */}
      {worker.status === 'waiting_input' && worker.waitingFor && (
        <div
          data-testid="worker-needs-input-banner"
          className="mb-3 border border-purple-200 dark:border-purple-800 bg-purple-50 dark:bg-purple-950/30 rounded-lg p-3"
        >
          <div className="flex items-center gap-2 mb-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-purple-500" />
            </span>
            <span data-testid="worker-needs-input-label" className="text-xs font-medium text-purple-700 dark:text-purple-300 uppercase">Needs input</span>
            {directStatus === 'connected' && (
              <span className="text-[10px] text-emerald-600 dark:text-emerald-400">instant delivery</span>
            )}
          </div>
          <p data-testid="worker-needs-input-prompt" className="text-sm text-gray-800 dark:text-gray-200">{worker.waitingFor.prompt}</p>
          {answerSent ? (
            <p className="mt-2 text-sm text-green-600 dark:text-green-400">Answer sent</p>
          ) : worker.waitingFor.options && worker.waitingFor.options.length > 0 ? (
            <div data-testid="worker-needs-input-options" className="flex flex-wrap gap-2 mt-3">
              {worker.waitingFor.options.map((opt, i) => (
                <button
                  key={i}
                  onClick={() => handleAnswer(opt)}
                  disabled={answerSending !== null}
                  className="px-3 py-1.5 text-xs bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-300 rounded-lg border border-purple-200 dark:border-purple-700 hover:bg-purple-200 dark:hover:bg-purple-800/60 hover:border-purple-400 dark:hover:border-purple-500 transition-colors disabled:opacity-50 cursor-pointer"
                >
                  {answerSending === opt ? 'Sending...' : opt}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      )}

      {/* Terminal-style output box */}
      {actionLog.length > 0 && (
        <div className="mb-3">
          <h4 className="text-sm font-medium text-gray-500 mb-2">Output</h4>
          <div
            ref={outputRef}
            onScroll={handleScroll}
            className="bg-gray-900 text-green-400 font-mono text-xs p-3 rounded-lg max-h-48 overflow-y-auto"
          >
            {actionLog.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap">{line}</div>
            ))}
          </div>
        </div>
      )}

      {/* Activity Timeline */}
      {worker.localUiUrl ? (
        <WorkerActivityTimeline
          milestones={worker.milestones || []}
          currentAction={worker.currentAction}
        />
      ) : (
        /* Milestone boxes for MCP workers */
        worker.milestones && worker.milestones.length > 0 && (
          <div className="flex items-center gap-1 mt-2">
            {Array.from({ length: Math.min(worker.milestones.length, 10) }).map((_, i) => (
              <div key={i} className="w-6 h-2 bg-blue-500 rounded-sm" />
            ))}
            {Array.from({ length: Math.max(0, 10 - worker.milestones.length) }).map((_, i) => (
              <div key={i} className="w-6 h-2 bg-gray-200 dark:bg-gray-700 rounded-sm" />
            ))}
            <span className="text-xs text-gray-500 ml-2">
              {worker.milestones.length} milestones
            </span>
          </div>
        )
      )}

      {/* Stats row */}
      <div className="flex items-center gap-4 mt-3 text-xs text-gray-500">
        <span>Turns: {worker.turns}</span>
        {worker.account?.authType === 'oauth' ? (
          <span>
            {((worker.inputTokens || 0) + (worker.outputTokens || 0)).toLocaleString()} tokens
          </span>
        ) : (
          <span>Cost: ${parseFloat(worker.costUsd || '0').toFixed(4)}</span>
        )}
        {worker.startedAt && (
          <span>
            {Math.round((Date.now() - new Date(worker.startedAt).getTime()) / 60000)}m elapsed
          </span>
        )}
        {worker.prUrl && (
          <a
            href={worker.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-green-600 hover:underline"
          >
            PR #{worker.prNumber}
          </a>
        )}
      </div>

      {/* Git stats */}
      {((worker.commitCount ?? 0) > 0 || (worker.filesChanged ?? 0) > 0) && (
        <div className="flex items-center gap-4 mt-2 text-xs">
          {(worker.commitCount ?? 0) > 0 && (
            <span className="text-gray-500">
              {worker.commitCount} commit{worker.commitCount !== 1 ? 's' : ''}
            </span>
          )}
          {(worker.filesChanged ?? 0) > 0 && (
            <span className="text-gray-500">
              {worker.filesChanged} file{worker.filesChanged !== 1 ? 's' : ''}
            </span>
          )}
          {((worker.linesAdded ?? 0) > 0 || (worker.linesRemoved ?? 0) > 0) && (
            <span>
              <span className="text-green-600">+{worker.linesAdded ?? 0}</span>
              {' / '}
              <span className="text-red-500">-{worker.linesRemoved ?? 0}</span>
            </span>
          )}
          {worker.lastCommitSha && (
            <span className="text-gray-400 font-mono">
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
          <div className="flex items-start gap-2">
            <div className="flex-1">
              <InstructWorkerForm
                workerId={worker.id}
                pendingInstructions={null}
              />
            </div>
            {worker.status === 'running' && (
              <div className="mt-4 pt-4 border-t border-transparent">
                <RequestPlanButton workerId={worker.id} />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
