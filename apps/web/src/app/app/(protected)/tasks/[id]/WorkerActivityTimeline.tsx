'use client';

import { useState } from 'react';

type Milestone =
  | { type: 'phase'; label: string; toolCount: number; ts: number; pending?: boolean }
  | { type: 'status'; label: string; progress?: number; ts: number };

interface WorkerActivityTimelineProps {
  milestones: Milestone[];
  currentAction?: string | null;
  maxVisible?: number;
}

export default function WorkerActivityTimeline({
  milestones,
  currentAction,
  maxVisible = 8,
}: WorkerActivityTimelineProps) {
  const [expanded, setExpanded] = useState(false);

  if (!milestones.length && !currentAction) {
    return null;
  }

  // Sort milestones by ts (newest first for display)
  const sortedMilestones = [...milestones].sort((a, b) => b.ts - a.ts);
  const visibleMilestones = expanded ? sortedMilestones : sortedMilestones.slice(0, maxVisible);
  const hasMore = sortedMilestones.length > maxVisible;

  const formatTime = (ts: number) => {
    const diffMs = Date.now() - ts;
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    return new Date(ts).toLocaleDateString();
  };

  return (
    <div className="mt-4">
      <h4 className="text-sm font-medium text-text-secondary mb-2">Activity</h4>

      {/* Milestones timeline */}
      {visibleMilestones.length > 0 && (
        <div className="space-y-1.5">
          {visibleMilestones.map((milestone, i) => (
            <div key={`${milestone.ts}-${i}`}>
              {milestone.type === 'phase' ? (
                <PhaseRow
                  milestone={milestone}
                  currentAction={i === 0 && milestone.pending ? currentAction : undefined}
                  formatTime={formatTime}
                />
              ) : (
                <StatusRow milestone={milestone} formatTime={formatTime} />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Expand/collapse button */}
      {hasMore && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-2 text-xs text-primary hover:text-primary-hover"
        >
          {expanded
            ? 'Show less'
            : `Show ${sortedMilestones.length - maxVisible} more...`}
        </button>
      )}
    </div>
  );
}

function PhaseRow({
  milestone,
  currentAction,
  formatTime,
}: {
  milestone: { type: 'phase'; label: string; toolCount: number; ts: number; pending?: boolean };
  currentAction?: string | null;
  formatTime: (ts: number) => string;
}) {
  return (
    <div className="flex items-start gap-2 py-1">
      <span className="mt-1 flex-shrink-0">
        {milestone.pending ? (
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-status-running opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-status-running" />
          </span>
        ) : (
          <span className="inline-flex h-2.5 w-2.5 rounded-full bg-text-muted" />
        )}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className={`text-sm truncate ${milestone.pending ? 'text-status-running font-medium' : 'text-text-primary'}`}>
            {milestone.label}
          </span>
          <span className="text-xs text-text-muted flex-shrink-0 tabular-nums">
            {milestone.toolCount} tool{milestone.toolCount !== 1 ? 's' : ''}
          </span>
          <span className="text-xs text-text-muted flex-shrink-0">
            {formatTime(milestone.ts)}
          </span>
        </div>
        {/* Show currentAction as sub-line for live phase */}
        {milestone.pending && currentAction && (
          <p className="text-xs text-text-secondary truncate mt-0.5">
            {currentAction}
          </p>
        )}
      </div>
    </div>
  );
}

function StatusRow({
  milestone,
  formatTime,
}: {
  milestone: { type: 'status'; label: string; progress?: number; ts: number };
  formatTime: (ts: number) => string;
}) {
  const getIcon = (label: string) => {
    const lower = label.toLowerCase();
    if (lower.includes('commit')) return '>';
    if (lower.includes('error') || lower.includes('fail') || lower.startsWith('🛑')) return '!';
    if (lower.includes('complete') || lower.includes('done')) return '+';
    if (lower.includes('plan')) return '~';
    if (lower.includes('question') || lower.includes('user:')) return '?';
    if (lower.includes('skill')) return '*';
    if (typeof milestone.progress === 'number') return '%';
    return '-';
  };

  const icon = getIcon(milestone.label);
  const isError = icon === '!';
  const isComplete = icon === '+';

  return (
    <div className="flex items-start gap-2 py-1 text-sm">
      <span className={`w-5 text-center flex-shrink-0 font-mono text-xs mt-0.5 ${
        isError ? 'text-status-error' : isComplete ? 'text-status-success' : 'text-text-muted'
      }`}>
        {icon}
      </span>
      <span className={`flex-1 truncate ${
        isError ? 'text-status-error' : 'text-text-secondary'
      }`}>
        {milestone.label}
        {typeof milestone.progress === 'number' && (
          <span className="ml-2 text-xs text-text-muted">{milestone.progress}%</span>
        )}
      </span>
      <span className="text-xs text-text-muted flex-shrink-0">
        {formatTime(milestone.ts)}
      </span>
    </div>
  );
}
