'use client';

import { useState } from 'react';
import type { WorkerMilestone } from '@buildd/core/db/schema';
import { buildTape, countToolCalls } from './task-activity';
import { buildMilestoneLog, type LogEntry } from './milestone-log';

// `label` is optional on purpose: workspaces with dataClass 'sensitive' have their
// milestone labels stripped server-side (apps/web/src/app/api/workers/[id]/route.ts),
// so rows arrive as { type, ts } only. Declaring it required made every row renderer
// dereference undefined and crash the whole task page.
type Milestone = WorkerMilestone;

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
        {/* The right edge prints the time it stands for, so the axis visibly
            reaches ELAPSED instead of stopping at the last labelled quarter. */}
        <span data-testid="worker-activity-axis-end" className="absolute right-0 flex gap-1.5">
          <span>{tape.end}</span>
          {live && <span className="text-accent-text">now</span>}
        </span>
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

  if (!milestones.length && !currentAction) {
    return null;
  }

  const nowMs = nowProp ?? Date.now();
  const firstTs = milestones.reduce((m, x) => Math.min(m, x.ts), Infinity);
  const lastTs = milestones.reduce((m, x) => Math.max(m, x.ts), -Infinity);
  const startMs = startedAt != null ? new Date(startedAt).getTime() : Number.isFinite(firstTs) ? firstTs : nowMs;
  const endMs = live ? nowMs : Number.isFinite(lastTs) ? Math.max(lastTs, startMs + 1) : nowMs;
  const toolCalls = countToolCalls(milestones);

  // The log: outcome milestones only, newest first, each with how long it
  // took. Narration is dropped and tool calls fold under the milestone they
  // happened in (see milestone-log.ts). The tape above is the heartbeat.
  const entries = buildMilestoneLog(milestones, { nowMs, live });
  const visibleEntries = expanded ? entries : entries.slice(0, maxVisible);
  const hasMore = entries.length > maxVisible;

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

      {visibleEntries.length > 0 && (
        <details className="mt-5 group" data-testid="worker-activity-log" open>
          <summary className="cursor-pointer select-none font-mono text-[11px] uppercase tracking-[2px] text-text-muted hover:text-text-secondary min-h-11 md:min-h-0 flex items-center gap-2">
            <span className="group-open:rotate-90 transition-transform" aria-hidden="true">▸</span>
            Log · {entries.length} {entries.length === 1 ? 'milestone' : 'milestones'}
          </summary>
          <div className="space-y-1.5 mt-3">
            {visibleEntries.map((entry, i) => (
              <LogEntryRow
                key={`${entry.startMs}-${i}`}
                entry={entry}
                currentAction={i === 0 && entry.endMs == null ? currentAction : undefined}
              />
            ))}
          </div>
          {hasMore && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="mt-2 text-xs text-accent-text hover:underline min-h-11 md:min-h-0"
            >
              {expanded ? 'Show less' : `Show ${entries.length - maxVisible} more…`}
            </button>
          )}
        </details>
      )}
    </div>
  );
}

type EntryTone = 'error' | 'success' | 'warning' | 'neutral';

/** The glyph and tone for a log entry, by type and (for status rows) label. */
export function entryGlyph(m: { type: string; label?: string; event?: string; progress?: number; pending?: boolean }): { ch: string; tone: EntryTone } {
  if (m.type === 'checkpoint') {
    if (m.event === 'task_error') return { ch: '!', tone: 'error' };
    if (m.event === 'task_completed') return { ch: '+', tone: 'success' };
    return { ch: '#', tone: 'neutral' };
  }
  if (m.type === 'phase') return { ch: '>', tone: 'neutral' };
  const lower = (m.label ?? '').toLowerCase();
  if (lower.includes('commit')) return { ch: '>', tone: 'neutral' };
  if (lower.includes('error') || lower.includes('fail') || lower.startsWith('🛑')) return { ch: '!', tone: 'error' };
  if (lower.includes('complete') || lower.includes('done') || lower.includes('pass')) return { ch: '+', tone: 'success' };
  if (lower.includes('plan')) return { ch: '~', tone: 'neutral' };
  if (lower.includes('question') || lower.includes('user:')) return { ch: '?', tone: 'neutral' };
  if (lower.includes('config changed')) return { ch: 'c', tone: 'warning' };
  if (lower.includes('skill')) return { ch: '*', tone: 'neutral' };
  if (typeof m.progress === 'number') return { ch: '%', tone: 'neutral' };
  return { ch: '-', tone: 'neutral' };
}

const TONE_GLYPH: Record<EntryTone, string> = {
  error: 'text-status-error',
  success: 'text-status-success',
  warning: 'text-status-warning',
  neutral: 'text-text-muted',
};
const TONE_TEXT: Record<EntryTone, string> = {
  error: 'text-status-error font-medium',
  success: 'text-text-primary',
  warning: 'text-status-warning',
  neutral: 'text-text-primary',
};

function LogEntryRow({ entry, currentAction }: { entry: LogEntry; currentAction?: string | null }) {
  const [rowExpanded, setRowExpanded] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const m = entry.milestone;
  const label = milestoneLabel(m);
  const open = entry.endMs == null;
  const glyph = entryGlyph(m as Parameters<typeof entryGlyph>[0]);
  const progress = m.type === 'status' && typeof m.progress === 'number' ? m.progress : null;
  const canOpenTools = entry.tools.length > 0;

  return (
    <div data-testid="worker-log-entry" data-open={open ? 'true' : undefined}>
      <div className="flex items-start gap-2 py-1 text-sm">
        <span className={`w-5 text-center flex-shrink-0 font-mono text-xs mt-0.5 ${open ? 'text-status-running' : TONE_GLYPH[glyph.tone]}`} aria-hidden="true">
          {open ? <span className="inline-block w-2 h-2 bg-status-running animate-status-pulse" /> : glyph.ch}
        </span>
        <button
          type="button"
          onClick={() => setRowExpanded(!rowExpanded)}
          className={`flex-1 min-w-0 text-left ${rowExpanded ? 'break-words' : 'line-clamp-2'} ${TONE_TEXT[glyph.tone]}`}
        >
          {label}
          {progress != null && <span className="ml-2 text-xs text-text-muted">{progress}%</span>}
        </button>
        {entry.toolCount > 0 && (
          canOpenTools ? (
            <button
              type="button"
              data-testid="worker-log-tools-chip"
              aria-expanded={toolsOpen}
              onClick={() => setToolsOpen(!toolsOpen)}
              className="font-mono text-[11px] md:text-[10px] bg-surface-3 px-1 py-0.5 flex-shrink-0 text-text-muted hover:text-text-primary min-h-11 md:min-h-0"
            >
              {entry.toolCount}&nbsp;tool{entry.toolCount !== 1 ? 's' : ''} {toolsOpen ? '▾' : '▸'}
            </button>
          ) : (
            <span data-testid="worker-log-tools-chip" className="font-mono text-[11px] md:text-[10px] bg-surface-3 px-1 py-0.5 flex-shrink-0 text-text-muted">
              {entry.toolCount}&nbsp;tool{entry.toolCount !== 1 ? 's' : ''}
            </span>
          )
        )}
        {entry.durationLabel && (
          <span data-testid="worker-log-duration" className={`font-mono text-xs flex-shrink-0 tabular-nums ${open ? 'text-status-running' : 'text-text-muted'}`} suppressHydrationWarning>
            {entry.durationLabel}
          </span>
        )}
      </div>
      {open && currentAction && (
        <p className="ml-7 text-xs text-text-secondary truncate">{collapseWorkspacePath(currentAction)}</p>
      )}
      {toolsOpen && (
        <div data-testid="worker-log-tools" className="mt-0.5 mb-1">
          {entry.tools.map((t, i) => (
            <ToolRow key={`${t.ts}-${i}`} label={milestoneLabel(t)} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolRow({ label }: { label: string }) {
  const [rowExpanded, setRowExpanded] = useState(false);
  const collapsed = collapseWorkspacePath(label);
  const truncated = middleTruncate(collapsed, 60);
  const isLong = collapsed !== truncated || label !== collapsed;

  return (
    <div
      className="flex items-start gap-2 py-0.5 ml-7 text-xs cursor-pointer"
      onClick={() => setRowExpanded(!rowExpanded)}
    >
      <span className="w-4 text-center flex-shrink-0 font-mono text-text-muted mt-0.5">$</span>
      <span className={`flex-1 min-w-0 font-mono text-[11px] bg-surface-3/50 px-1 ${
        rowExpanded ? 'text-text-secondary whitespace-pre-wrap break-all' : 'text-text-muted truncate'
      }`}>
        {rowExpanded ? label : truncated}
      </span>
      {isLong && (
        <span className="text-text-muted text-[11px] md:text-[10px] flex-shrink-0">{rowExpanded ? '▾' : '▸'}</span>
      )}
    </div>
  );
}
