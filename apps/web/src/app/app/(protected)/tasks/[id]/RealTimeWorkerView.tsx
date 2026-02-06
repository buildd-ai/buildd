'use client';

import { useState, useEffect, useRef } from 'react';
import { subscribeToChannel, unsubscribeFromChannel } from '@/lib/pusher-client';
import WorkerActivityTimeline from './WorkerActivityTimeline';
import InstructionHistory from './InstructionHistory';
import InstructWorkerForm from './InstructWorkerForm';
import PlanReviewPanel from './PlanReviewPanel';

interface Worker {
  id: string;
  name: string;
  branch: string;
  status: string;
  progress: number;
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

function RequestPlanButton({ workerId }: { workerId: string }) {
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleRequestPlan() {
    setLoading(true);
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

  return (
    <button
      onClick={handleRequestPlan}
      disabled={loading}
      className="px-3 py-2 text-xs border border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 rounded-lg hover:bg-amber-50 dark:hover:bg-amber-900/30 disabled:opacity-50 whitespace-nowrap"
      title="Ask the worker to pause and submit a plan for review"
    >
      {loading ? '...' : 'Request Plan'}
    </button>
  );
}

export default function RealTimeWorkerView({ initialWorker, statusColors }: Props) {
  const [worker, setWorker] = useState<Worker>(initialWorker);
  const [actionLog, setActionLog] = useState<string[]>([]);
  const outputRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);

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
        console.log('[RealTimeWorkerView] Received update:', data.worker?.status, data.worker?.progress);
        setWorker(data.worker);
      };

      channel.bind('worker:progress', handleUpdate);
      channel.bind('worker:completed', handleUpdate);
      channel.bind('worker:failed', handleUpdate);
      channel.bind('worker:plan_approved', handleUpdate);
      channel.bind('worker:plan_revision_requested', handleUpdate);

      // Auto-show plan panel when plan is submitted
      const handlePlanSubmitted = (data: { worker: Worker }) => {
        console.log('[RealTimeWorkerView] Plan submitted:', data.worker?.status);
        setWorker(data.worker);
      };
      channel.bind('worker:plan_submitted', handlePlanSubmitted);

      // Log all events for debugging
      channel.bind_global((eventName: string, data: unknown) => {
        console.log('[RealTimeWorkerView] Event received:', eventName, data);
      });

      return () => {
        channel.unbind('worker:progress', handleUpdate);
        channel.unbind('worker:completed', handleUpdate);
        channel.unbind('worker:failed', handleUpdate);
        channel.unbind('worker:plan_approved', handleUpdate);
        channel.unbind('worker:plan_revision_requested', handleUpdate);
        channel.unbind('worker:plan_submitted', handlePlanSubmitted);
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

  const isActive = ['running', 'starting', 'waiting_input', 'awaiting_plan_approval'].includes(worker.status);

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
            <a
              href={`${worker.localUiUrl}/worker/${worker.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1 text-xs bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 rounded-full hover:bg-blue-200 dark:hover:bg-blue-800"
            >
              Open Terminal
            </a>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {worker.progress > 0 && (
        <div className="mb-3">
          <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-green-500 transition-all"
              style={{ width: `${worker.progress}%` }}
            />
          </div>
        </div>
      )}

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
          </div>
          <p data-testid="worker-needs-input-prompt" className="text-sm text-gray-800 dark:text-gray-200">{worker.waitingFor.prompt}</p>
          {worker.waitingFor.options && worker.waitingFor.options.length > 0 && (
            <div data-testid="worker-needs-input-options" className="flex flex-wrap gap-2 mt-2">
              {worker.waitingFor.options.map((opt, i) => (
                <span key={i} className="px-2 py-1 text-xs bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-300 rounded">
                  {opt}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Plan review panel */}
      {worker.status === 'awaiting_plan_approval' && (
        <PlanReviewPanel workerId={worker.id} />
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
