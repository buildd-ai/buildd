'use client';

/**
 * Tool calls you can see (docs/design/agent-chat.md): every call is a compact
 * row — the tool as the verb, its key arguments, a live state and a one-line
 * result — and expands to the raw input and output. Consecutive calls group
 * under one header. They are part of the conversation, so they sit on a soft
 * tint with no frame (docs/design/chat-canvas.md); the running call is the
 * one row that takes the accent.
 */
import { useState } from 'react';
import type { ChatToolPart } from './chat-contract';
import { toolGroupSummary, toolRowView, type ToolRowState, type ToolRowView } from './feed-model';

const MARK: Record<ToolRowState, { glyph: string; cls: string; label: string }> = {
  running: { glyph: '■', cls: 'text-accent-text animate-status-pulse', label: 'running' },
  awaiting: { glyph: '?', cls: 'text-status-warning', label: 'waiting for you' },
  approved: { glyph: '■', cls: 'text-accent-text animate-status-pulse', label: 'approved, running' },
  done: { glyph: '✓', cls: 'text-status-success', label: 'done' },
  failed: { glyph: '✕', cls: 'text-status-error', label: 'failed' },
  denied: { glyph: '–', cls: 'text-text-muted', label: 'discarded' },
};

function json(v: unknown): string {
  if (v === undefined) return '—';
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export function ToolCallRow({ view, note, flush = false }: { view: ToolRowView; note?: string | null; flush?: boolean }) {
  const [open, setOpen] = useState(false);
  const mark = MARK[view.state];
  const result = view.state === 'running' ? 'running…' : view.result;
  const live = view.state === 'running' || view.state === 'approved';
  return (
    <div
      data-testid="tool-call-row"
      data-state={view.state}
      data-tool={view.name}
      className={`${flush ? '' : 'overflow-hidden rounded-[12px] bg-[var(--convo-soft)]'} ${live ? '!bg-[var(--accent-soft)]' : ''}`}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        className="flex min-h-11 md:min-h-9 w-full min-w-0 items-center gap-2.5 px-3.5 py-1.5 text-left font-mono text-[12.5px] hover:bg-[var(--convo-soft)]"
      >
        <span aria-label={mark.label} className={`w-3 shrink-0 text-center font-semibold ${mark.cls}`}>{mark.glyph}</span>
        <span className={`shrink-0 font-semibold ${live ? 'text-accent-text' : 'text-text-primary'}`}>{view.name}</span>
        {view.action && <span className="shrink-0 text-text-secondary">{view.action}</span>}
        {(view.output as { allowed?: boolean } | undefined)?.allowed === true && (
          <span data-testid="tool-call-allowed" className="shrink-0 border border-border-default px-1 text-[11px] md:text-[10.5px] uppercase tracking-[1px] text-text-muted">allowed</span>
        )}
        {view.args.length > 0 && !note && (
          <span className="hidden min-w-0 truncate text-text-muted sm:inline">{`· ${view.args.join(' · ')}`}</span>
        )}
        {note && <span className="hidden shrink-0 text-text-muted sm:inline">{`· ${note}`}</span>}
        {result && (
          <span className={`min-w-0 flex-1 truncate ${view.state === 'failed' ? 'text-status-error' : 'text-text-secondary'}`}>
            <span aria-hidden="true" className="text-text-muted">{'→ '}</span>{result}
          </span>
        )}
        <span aria-hidden="true" className={`ml-auto shrink-0 text-text-muted transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
      </button>
      {open && (
        <div data-testid="tool-call-raw" className="grid gap-2 border-t border-[var(--convo-line)] px-3.5 py-2.5 font-mono text-[11.5px]">
          <div>
            <div className="section-label !text-[11px] mb-1">Input</div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-[8px] bg-[var(--convo-soft)] p-2 text-text-secondary">{json(view.input)}</pre>
          </div>
          <div>
            <div className="section-label !text-[11px] mb-1">{view.state === 'failed' ? 'Error' : 'Output'}</div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-[8px] bg-[var(--convo-soft)] p-2 text-text-secondary">{view.state === 'failed' ? view.errorText ?? '—' : json(view.output)}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

/** A run of consecutive calls. One call is a bare row; more get a header that folds them. */
export function ToolCallGroup({ calls }: { calls: readonly ChatToolPart[] }) {
  const views = calls.map(toolRowView);
  const summary = toolGroupSummary(calls);
  const [open, setOpen] = useState(true);
  if (views.length === 1) return <ToolCallRow view={views[0]} />;
  const tail = summary.running > 0 ? `${summary.running} running` : summary.failed > 0 ? `${summary.failed} failed` : null;
  return (
    <div data-testid="tool-call-group" className="overflow-hidden rounded-[12px] bg-[var(--convo-soft)]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        className={`flex min-h-11 md:min-h-9 w-full items-center gap-2 px-3.5 font-mono text-[11.5px] text-text-muted hover:text-text-primary ${open ? 'border-b border-[var(--convo-line)]' : ''}`}
      >
        <span className="font-semibold text-text-secondary">{`${summary.count} tool calls`}</span>
        {summary.readOnly && <span>· read-only</span>}
        {tail && <span className={summary.failed > 0 && summary.running === 0 ? 'text-status-error' : 'text-accent-text'}>{`· ${tail}`}</span>}
        <span aria-hidden="true" className={`ml-auto transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
      </button>
      {open && (
        <div className="divide-y divide-[var(--convo-line)]">
          {views.map(v => <ToolCallRow key={v.id} view={v} flush />)}
        </div>
      )}
    </div>
  );
}
