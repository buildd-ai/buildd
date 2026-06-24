'use client';

import { useState } from 'react';

type Milestone =
  | { type: 'phase'; label: string; toolCount: number; ts: number; pending?: boolean }
  | { type: 'status'; label: string; progress?: number; ts: number }
  | { type: 'checkpoint'; event: string; label: string; ts: number }
  | { type: 'action'; label: string; ts: number };

const CHECKPOINT_ORDER = [
  'session_started', 'first_read', 'first_edit', 'first_commit', 'task_completed',
] as const;

const CHECKPOINT_SHORT_LABELS: Record<string, string> = {
  session_started: 'Started',
  first_read: 'Read',
  first_edit: 'Edit',
  first_commit: 'Commit',
  task_completed: 'Done',
};

interface WorkerActivityTimelineProps {
  milestones: Milestone[];
  currentAction?: string | null;
  maxVisible?: number;
}

// Collapse workspace-path prefixes to surface the distinguishing command tail.
// Handles `(Ran: )?cd /abs/path && rest` → `~/basename rest` and bare `cd /abs/path` → `~/basename`.
// Falls back to inline replacement for cd occurrences elsewhere in the string.
// Applied at render time only — never mutates stored data.
export function collapseWorkspacePath(text: string): string {
  if (!text) return text;
  const withRestMatch = text.match(/^(Ran:\s*)?cd\s+(\/[^\s]+)\s*&&\s*([\s\S]*)/);
  if (withRestMatch) {
    const ran = withRestMatch[1] || '';
    const path = withRestMatch[2];
    const rest = withRestMatch[3];
    const basename = path.split('/').filter(Boolean).pop() || path;
    return `${ran}~/${basename}${rest ? ' ' + rest : ''}`;
  }
  const bareMatch = text.match(/^(Ran:\s*)?cd\s+(\/[^\s]+)\s*$/);
  if (bareMatch) {
    const ran = bareMatch[1] || '';
    const path = bareMatch[2];
    const basename = path.split('/').filter(Boolean).pop() || path;
    return `${ran}~/${basename}`;
  }
  return text.replace(/\bcd (\/[^\s&]+)/g, (_match, p1: string) => {
    const lastSegment = p1.split('/').filter(Boolean).pop() || p1;
    return `cd ~/${lastSegment}`;
  });
}

function middleTruncate(str: string, maxLen: number, tailLen = 20): string {
  if (str.length <= maxLen) return str;
  const headLen = maxLen - tailLen - 1;
  return str.slice(0, headLen) + '…' + str.slice(-tailLen);
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

  // Compute checkpoint progress from milestones
  const checkpointEvents = new Set(
    milestones
      .filter((m): m is Extract<Milestone, { type: 'checkpoint' }> => m.type === 'checkpoint')
      .map(m => m.event)
  );
  const checkpointCount = CHECKPOINT_ORDER.filter(e => checkpointEvents.has(e)).length;

  return (
    <div className="mt-4">
      <h4 className="text-sm font-medium text-text-secondary mb-2">Activity</h4>

      {/* Checkpoint progress boxes */}
      {checkpointCount > 0 && (
        <div className="flex items-center gap-1 mb-3">
          {CHECKPOINT_ORDER.map(event => (
            <div
              key={event}
              className={`h-2 flex-1 rounded-sm ${checkpointEvents.has(event) ? 'bg-primary' : 'bg-surface-3'}`}
              title={CHECKPOINT_SHORT_LABELS[event] || event}
            />
          ))}
          <span className="text-xs text-text-muted ml-2 tabular-nums">
            {checkpointCount}/{CHECKPOINT_ORDER.length}
          </span>
        </div>
      )}

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
              ) : milestone.type === 'checkpoint' ? (
                <CheckpointRow milestone={milestone} formatTime={formatTime} />
              ) : milestone.type === 'action' ? (
                <ActionRow milestone={milestone} formatTime={formatTime} />
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
  const [rowExpanded, setRowExpanded] = useState(false);
  const isLong = milestone.label.length > 40;

  return (
    <div
      className={`flex items-start gap-2 py-1 cursor-pointer ${
        !milestone.pending
          ? 'pl-1.5 border-l-2 border-border-default bg-surface-3/30 rounded-sm'
          : ''
      }`}
      onClick={() => setRowExpanded(!rowExpanded)}
    >
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
          <span className={`text-sm ${rowExpanded ? 'break-all' : 'truncate'} ${milestone.pending ? 'text-status-running font-medium' : 'text-text-primary'}`}>
            {milestone.label}
          </span>
          <span className="font-mono text-[10px] bg-surface-3 px-1 py-0.5 rounded flex-shrink-0 text-text-muted">
            {milestone.toolCount}&nbsp;tool{milestone.toolCount !== 1 ? 's' : ''}
          </span>
          <span className="text-xs text-text-muted flex-shrink-0">
            {formatTime(milestone.ts)}
          </span>
          {isLong && (
            <span className="text-text-muted text-[10px] flex-shrink-0">
              {rowExpanded ? '▾' : '▸'}
            </span>
          )}
        </div>
        {/* Show currentAction as sub-line for live phase with path collapsed */}
        {milestone.pending && currentAction && (
          <p className="text-xs text-text-secondary truncate mt-0.5">
            {collapseWorkspacePath(currentAction)}
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
  const [rowExpanded, setRowExpanded] = useState(false);

  const getIcon = (label: string) => {
    const lower = (label ?? '').toLowerCase();
    if (lower.includes('commit')) return '>';
    if (lower.includes('error') || lower.includes('fail') || lower.startsWith('🛑')) return '!';
    if (lower.includes('complete') || lower.includes('done')) return '+';
    if (lower.includes('plan')) return '~';
    if (lower.includes('question') || lower.includes('user:')) return '?';
    if (lower.includes('config changed')) return 'c';
    if (lower.includes('skill')) return '*';
    if (typeof milestone.progress === 'number') return '%';
    return '-';
  };

  const icon = getIcon(milestone.label);
  const isError = icon === '!';
  const isComplete = icon === '+';
  const isConfigChange = icon === 'c';
  const isLong = milestone.label.length > 80;

  return (
    <div
      className="flex items-start gap-2 py-1 text-sm cursor-pointer"
      onClick={() => setRowExpanded(!rowExpanded)}
    >
      <span className={`w-5 text-center flex-shrink-0 font-mono text-xs mt-0.5 ${
        isError ? 'text-status-error' : isComplete ? 'text-status-success' : isConfigChange ? 'text-status-warning' : 'text-text-muted'
      }`}>
        {icon}
      </span>
      <span className={`flex-1 min-w-0 ${!isError && !rowExpanded ? 'line-clamp-2' : ''} ${
        isError ? 'text-status-error font-medium' : isConfigChange ? 'text-status-warning' : 'text-text-secondary'
      }`}>
        {milestone.label}
        {typeof milestone.progress === 'number' && (
          <span className="ml-2 text-xs text-text-muted">{milestone.progress}%</span>
        )}
      </span>
      <div className="flex items-center gap-1 flex-shrink-0">
        {isLong && (
          <span className="text-text-muted text-[10px]">
            {rowExpanded ? '▾' : '▸'}
          </span>
        )}
        <span className="text-xs text-text-muted">
          {formatTime(milestone.ts)}
        </span>
      </div>
    </div>
  );
}

function CheckpointRow({
  milestone,
  formatTime,
}: {
  milestone: { type: 'checkpoint'; event: string; label: string; ts: number };
  formatTime: (ts: number) => string;
}) {
  const [rowExpanded, setRowExpanded] = useState(false);
  const isError = milestone.event === 'task_error';
  const isComplete = milestone.event === 'task_completed';
  const isLong = milestone.label.length > 50;

  return (
    <div
      className="flex items-start gap-2 py-1 text-sm cursor-pointer"
      onClick={() => setRowExpanded(!rowExpanded)}
    >
      <span className={`w-5 text-center flex-shrink-0 font-mono text-xs mt-0.5 ${
        isError ? 'text-status-error' : isComplete ? 'text-status-success' : 'text-primary'
      }`}>
        {isError ? '!' : isComplete ? '+' : '#'}
      </span>
      <span className={`flex-1 min-w-0 font-medium ${rowExpanded ? '' : 'line-clamp-2'} ${
        isError ? 'text-status-error' : isComplete ? 'text-status-success' : 'text-text-primary'
      }`}>
        {milestone.label}
      </span>
      <div className="flex items-center gap-1 flex-shrink-0">
        {isLong && (
          <span className="text-text-muted text-[10px]">
            {rowExpanded ? '▾' : '▸'}
          </span>
        )}
        <span className="text-xs text-text-muted">
          {formatTime(milestone.ts)}
        </span>
      </div>
    </div>
  );
}

function ActionRow({
  milestone,
  formatTime,
}: {
  milestone: { type: 'action'; label: string; ts: number };
  formatTime: (ts: number) => string;
}) {
  const [rowExpanded, setRowExpanded] = useState(false);
  const collapsed = collapseWorkspacePath(milestone.label);
  const truncated = middleTruncate(collapsed, 60);
  const isLong = collapsed !== truncated || milestone.label !== collapsed;

  return (
    <div
      className="flex items-start gap-2 py-0.5 ml-5 text-xs cursor-pointer"
      onClick={() => setRowExpanded(!rowExpanded)}
    >
      <span className="w-4 text-center flex-shrink-0 font-mono text-text-muted mt-0.5">
        $
      </span>
      <span className={`flex-1 min-w-0 font-mono text-[11px] bg-surface-3/50 rounded px-1 ${
        rowExpanded ? 'text-text-secondary whitespace-pre-wrap break-all' : 'text-text-muted'
      }`}>
        {rowExpanded ? milestone.label : truncated}
      </span>
      <div className="flex items-center gap-1 flex-shrink-0">
        {isLong && (
          <span className="text-text-muted text-[10px]">
            {rowExpanded ? '▾' : '▸'}
          </span>
        )}
        <span className="text-[10px] text-text-muted/60">
          {formatTime(milestone.ts)}
        </span>
      </div>
    </div>
  );
}
