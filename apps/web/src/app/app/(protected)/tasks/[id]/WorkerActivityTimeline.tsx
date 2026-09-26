'use client';

import { useState } from 'react';
import { useDisplayTimezone } from '@/components/DisplayTimezone';
import { formatInZone } from '@/lib/zoned-time';
import type { WorkerMilestone } from '@buildd/core/db/schema';
import { buildTape, touchedFiles, countToolCalls, type TouchedRow } from './task-activity';

// `label` is optional on purpose: workspaces with dataClass 'sensitive' have their
// milestone labels stripped server-side (apps/web/src/app/api/workers/[id]/route.ts),
// so rows arrive as { type, ts } only. Declaring it required made every row renderer
// dereference undefined and crash the whole task page.
type Milestone = WorkerMilestone;

type LabelledMilestone = Milestone & { label: string };

const TYPE_FALLBACK_LABELS: Record<Milestone['type'], string> = {
  phase: 'Phase',
  status: 'Status update',
  checkpoint: 'Checkpoint',
  action: 'Action',
};

// Name the activity by its type when the label was withheld, so the row still shows
// when something happened without inventing detail we were not given.
export function milestoneLabel(milestone: { type: string; label?: string | null }): string {
  const label = milestone.label?.trim();
  if (label) return label;
  return TYPE_FALLBACK_LABELS[milestone.type as Milestone['type']] ?? 'Activity';
}

interface WorkerActivityTimelineProps {
  milestones: Milestone[];
  currentAction?: string | null;
  maxVisible?: number;
  /** Session start: the tape's left edge. Defaults to the first milestone. */
  startedAt?: string | number | null;
  /** Injectable clock for deterministic renders (tests); defaults to Date.now(). */
  nowMs?: number;
  /** Whether the worker is still live (the tape ends at "now", not the last event). */
  live?: boolean;
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

export function ageLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function splitPath(p: string): [string, string] {
  const i = p.replace(/\/+$/, '').lastIndexOf('/');
  return i >= 0 ? [p.slice(0, i + 1), p.slice(i + 1)] : ['', p];
}

const GLYPHS: Record<TouchedRow['kind'], { ch: string; cls: string; title: string }> = {
  new: { ch: '+', cls: 'border-2 border-accent text-accent-text', title: 'New file' },
  edit: { ch: 'E', cls: 'bg-accent text-[var(--on-accent)]', title: 'Edited' },
  run: { ch: '$', cls: 'bg-text-primary text-surface-1', title: 'Command' },
  read: { ch: 'R', cls: 'border border-border-strong text-text-muted', title: 'Read' },
};

function DiffCells({ add, rem }: { add: number; rem: number }) {
  const total = add + rem;
  if (total <= 0) return null;
  const green = Math.min(5, Math.max(add > 0 ? 1 : 0, Math.round((add / total) * 5)));
  return (
    <span className="inline-flex gap-[2px]" aria-hidden="true">
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className={`w-[6px] h-[12px] ${i < green ? 'bg-status-success' : 'bg-status-error'}`} />
      ))}
    </span>
  );
}

function TouchedRowView({ row, nowMs, latest }: { row: TouchedRow; nowMs: number; latest: boolean }) {
  const g = GLYPHS[row.kind];
  const [dir, base] = row.path ? splitPath(row.path) : ['', ''];
  const known = row.add != null || row.rem != null;
  return (
    <div
      data-testid="worker-touched-row"
      data-kind={row.kind}
      className={`flex items-center gap-3 px-3 md:px-4 min-h-11 md:min-h-12 border-b border-border-default last:border-b-0 ${latest ? 'bg-accent-soft' : ''}`}
    >
      <span title={g.title} className={`w-6 h-6 shrink-0 grid place-items-center font-mono text-[11px] font-bold ${g.cls}`}>{g.ch}</span>
      <span className="flex-1 min-w-0 truncate font-mono text-[13px]">
        {row.kind === 'run' ? (
          <span className="text-text-primary">$ {collapseWorkspacePath(row.cmd ?? '')}</span>
        ) : (
          <>
            <span className="text-text-muted">{dir}</span>
            <span className="text-text-primary">{base}</span>
          </>
        )}
        {row.count > 1 && row.kind !== 'read' && (
          <span className="ml-2 text-[11px] text-text-muted">×{row.count}</span>
        )}
      </span>
      <span className="hidden sm:flex items-center gap-2 shrink-0 font-mono text-[12px] tabular-nums">
        {row.kind === 'read' ? (
          <span className="text-text-muted">{row.count > 1 ? `read ×${row.count}` : 'read'}</span>
        ) : known && row.kind !== 'run' ? (
          <>
            {(row.add ?? 0) > 0 && <span className="text-status-success">+{row.add}</span>}
            {(row.rem ?? 0) > 0 && <span className="text-status-error">&minus;{row.rem}</span>}
            <DiffCells add={row.add ?? 0} rem={row.rem ?? 0} />
          </>
        ) : null}
      </span>
      <span className="w-10 text-right shrink-0 font-mono text-[12px] text-text-muted tabular-nums" suppressHydrationWarning>
        {ageLabel(nowMs - row.lastTs)}
      </span>
    </div>
  );
}

export function ActivityTape({
  milestones,
  startMs,
  nowMs,
  live,
}: {
  milestones: Milestone[];
  startMs: number;
  nowMs: number;
  live: boolean;
}) {
  const tape = buildTape(milestones, { startMs, nowMs });
  if (tape.ticks.length === 0 && tape.flags.length === 0) return null;
  const lastFlag = tape.flags[tape.flags.length - 1];
  return (
    <div data-testid="worker-activity-tape" className="relative pt-12">
      {tape.flags.map((f, i) => {
        const isLast = f === lastFlag;
        // Labels are wide: the latest always gets one, the one before only when
        // it sits far enough left not to run into it.
        const labelled = isLast || (i === tape.flags.length - 2 && lastFlag.pos - f.pos > 0.62);
        const flip = f.pos > 0.6;
        return (
          <div
            key={`${f.pos}-${i}`}
            className="absolute top-0 font-mono text-[11px] whitespace-nowrap"
            style={{ left: `${f.pos * 100}%`, transform: flip ? 'translateX(-100%)' : undefined }}
          >
            <div className={`flex items-center gap-2 ${flip ? 'flex-row-reverse' : ''}`}>
              <span className={`px-1 font-semibold tabular-nums ${isLast ? 'bg-accent text-[var(--on-accent)]' : 'bg-text-primary text-surface-1'}`}>{f.pct}%</span>
              {labelled && <span className="text-text-secondary max-w-[40vw] md:max-w-[360px] truncate">{f.label}</span>}
            </div>
            <div className={`text-text-muted tabular-nums ${flip ? 'text-right' : ''}`}>{f.at}</div>
          </div>
        );
      })}
      <div className="relative h-10 border border-border-default bg-surface-2" aria-label={`${tape.ticks.length} tool calls`}>
        {tape.flags.map((f, i) => (
          <span key={`l-${i}`} className="absolute -top-3 h-3 border-l border-dashed border-text-muted" style={{ left: `${f.pos * 100}%` }} aria-hidden="true" />
        ))}
        {tape.ticks.map((t, i) => (
          <span
            key={i}
            title={t.label}
            className={`absolute top-1/2 -translate-y-1/2 w-[5px] ${
              t.kind === 'edit' ? 'h-6 bg-accent' : t.kind === 'run' ? 'h-5 border-[1.5px] border-text-secondary bg-transparent' : 'h-5 bg-[var(--tape-read)]'
            }`}
            style={{ left: `calc(${t.pos * 100}% - ${t.pos * 5}px)` }}
          />
        ))}
        {live && <span className="absolute right-0 top-0 bottom-0 w-[2px] bg-accent" aria-hidden="true" />}
      </div>
      <div className="relative h-5 mt-1 font-mono text-[11px] text-text-muted tabular-nums">
        {tape.axis.map((a, i) => (
          <span key={i} className="absolute" style={{ left: `${i * 25}%` }}>{a}</span>
        ))}
        {live && <span className="absolute right-0 text-accent-text">now</span>}
      </div>
    </div>
  );
}

export function TouchedList({ milestones, nowMs }: { milestones: Milestone[]; nowMs: number }) {
  const [showReads, setShowReads] = useState(false);
  const { rows, reads } = touchedFiles(milestones);
  if (rows.length === 0 && reads.length === 0) return null;
  // One read stays visible so the list shows what the agent is consulting;
  // the rest fold away (reads outnumber edits by a wide margin).
  const visibleReads = showReads ? reads : reads.slice(0, 1);
  const hidden = reads.length - visibleReads.length;
  const list = [...rows, ...visibleReads];
  return (
    <div data-testid="worker-touched" className="mt-6">
      <div className="flex items-baseline justify-between border-b border-border-default pb-2 mb-3">
        <span className="section-label">Touched</span>
        {reads.length > 1 && (
          <button
            type="button"
            onClick={() => setShowReads(!showReads)}
            className="font-mono text-[11px] uppercase tracking-[2px] text-text-muted hover:text-text-primary min-h-11 md:min-h-0"
          >
            {showReads ? 'Hide reads' : `+ ${hidden} reads hidden · show all`}
          </button>
        )}
      </div>
      <div className="border-2 border-border-strong bg-card">
        {list.map((r, i) => (
          <TouchedRowView key={`${r.kind}-${r.path ?? r.cmd}-${i}`} row={r} nowMs={nowMs} latest={i === 0 && r.kind !== 'read'} />
        ))}
      </div>
    </div>
  );
}

export default function WorkerActivityTimeline({
  milestones,
  currentAction,
  maxVisible = 8,
  startedAt,
  nowMs: nowProp,
  live = false,
}: WorkerActivityTimelineProps) {
  const [expanded, setExpanded] = useState(false);
  const displayTz = useDisplayTimezone();

  if (!milestones.length && !currentAction) {
    return null;
  }

  const nowMs = nowProp ?? Date.now();
  const firstTs = milestones.reduce((m, x) => Math.min(m, x.ts), Infinity);
  const lastTs = milestones.reduce((m, x) => Math.max(m, x.ts), -Infinity);
  const startMs = startedAt != null ? new Date(startedAt).getTime() : Number.isFinite(firstTs) ? firstTs : nowMs;
  const endMs = live ? nowMs : Number.isFinite(lastTs) ? Math.max(lastTs, startMs + 1) : nowMs;
  const toolCalls = countToolCalls(milestones);

  // Guarantee a label before dispatching to the row renderers (see milestoneLabel).
  const labelledMilestones = milestones.map(
    (m) => ({ ...m, label: milestoneLabel(m) }) as LabelledMilestone
  );

  // The log: every milestone, newest first. The tape and Touched list are the
  // summary; this is the record, one tap away.
  const sortedMilestones = [...labelledMilestones].sort((a, b) => b.ts - a.ts);
  const visibleMilestones = expanded ? sortedMilestones : sortedMilestones.slice(0, maxVisible);
  const hasMore = sortedMilestones.length > maxVisible;

  const formatTime = (ts: number) => {
    const diffMs = nowMs - ts;
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    return displayTz ? formatInZone(ts, displayTz, 'date') : '';
  };

  // Rows without structured tool data (older runners, sensitive workspaces)
  // produce no tape; the log then opens by default so nothing is hidden.
  const hasTape = milestones.some(m => m.type === 'action' || (m.type === 'status' && typeof m.progress === 'number'));

  return (
    <div className="mt-6" data-testid="worker-activity-timeline">
      <div className="flex items-baseline justify-between border-b border-border-default pb-2 mb-3 gap-3">
        <span className="section-label">
          Activity{toolCalls > 0 ? ` · ${toolCalls} tool call${toolCalls === 1 ? '' : 's'}` : ''}
        </span>
        {hasTape && (
          <span className="hidden sm:flex items-center gap-3 font-mono text-[11px] text-text-muted">
            <span className="inline-flex items-center gap-1.5"><span className="w-[9px] h-[9px] bg-accent" />edit</span>
            <span className="inline-flex items-center gap-1.5"><span className="w-[9px] h-[9px] bg-[var(--tape-read)]" />read</span>
            <span className="inline-flex items-center gap-1.5"><span className="w-[9px] h-[9px] border-[1.5px] border-text-secondary" />run</span>
          </span>
        )}
      </div>

      <ActivityTape milestones={milestones} startMs={startMs} nowMs={endMs} live={live} />
      <TouchedList milestones={milestones} nowMs={nowMs} />

      {visibleMilestones.length > 0 && (
        <details className="mt-5 group" data-testid="worker-activity-log" open={!hasTape}>
          <summary className="cursor-pointer select-none font-mono text-[11px] uppercase tracking-[2px] text-text-muted hover:text-text-secondary min-h-11 md:min-h-0 flex items-center gap-2">
            <span className="group-open:rotate-90 transition-transform" aria-hidden="true">▸</span>
            Log · {sortedMilestones.length} {sortedMilestones.length === 1 ? 'entry' : 'entries'}
          </summary>
          <div className="space-y-1.5 mt-3">
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
          {hasMore && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="mt-2 text-xs text-accent-text hover:underline min-h-11 md:min-h-0"
            >
              {expanded ? 'Show less' : `Show ${sortedMilestones.length - maxVisible} more…`}
            </button>
          )}
        </details>
      )}
    </div>
  );
}

function PhaseRow({
  milestone,
  currentAction,
  formatTime,
}: {
  milestone: Extract<LabelledMilestone, { type: 'phase' }>;
  currentAction?: string | null;
  formatTime: (ts: number) => string;
}) {
  const [rowExpanded, setRowExpanded] = useState(false);
  const isLong = milestone.label.length > 40;

  return (
    <div
      className={`flex items-start gap-2 py-1 cursor-pointer ${
        !milestone.pending
          ? 'pl-1.5 border-l-2 border-border-default bg-surface-3/30 '
          : ''
      }`}
      onClick={() => setRowExpanded(!rowExpanded)}
    >
      <span className="mt-1 flex-shrink-0">
        {milestone.pending ? (
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full bg-status-running opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 bg-status-running" />
          </span>
        ) : (
          <span className="inline-flex h-2.5 w-2.5 bg-text-muted" />
        )}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className={`text-sm ${rowExpanded ? 'break-all' : 'truncate'} ${milestone.pending ? 'text-status-running font-medium' : 'text-text-primary'}`}>
            {milestone.label}
          </span>
          <span className="font-mono text-[11px] md:text-[10px] bg-surface-3 px-1 py-0.5 flex-shrink-0 text-text-muted">
            {milestone.toolCount}&nbsp;tool{milestone.toolCount !== 1 ? 's' : ''}
          </span>
          <span className="text-xs text-text-muted flex-shrink-0">
            {formatTime(milestone.ts)}
          </span>
          {isLong && (
            <span className="text-text-muted text-[11px] md:text-[10px] flex-shrink-0">
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
  milestone: Extract<LabelledMilestone, { type: 'status' }>;
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
          <span className="text-text-muted text-[11px] md:text-[10px]">
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
  milestone: Extract<LabelledMilestone, { type: 'checkpoint' }>;
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
          <span className="text-text-muted text-[11px] md:text-[10px]">
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
  milestone: Extract<LabelledMilestone, { type: 'action' }>;
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
      <span className={`flex-1 min-w-0 font-mono text-[11px] bg-surface-3/50 px-1 ${
        rowExpanded ? 'text-text-secondary whitespace-pre-wrap break-all' : 'text-text-muted truncate'
      }`}>
        {rowExpanded ? milestone.label : truncated}
      </span>
      <div className="flex items-center gap-1 flex-shrink-0">
        {isLong && (
          <span className="text-text-muted text-[11px] md:text-[10px]">
            {rowExpanded ? '▾' : '▸'}
          </span>
        )}
        <span className="text-[11px] md:text-[10px] text-text-muted/60">
          {formatTime(milestone.ts)}
        </span>
      </div>
    </div>
  );
}
