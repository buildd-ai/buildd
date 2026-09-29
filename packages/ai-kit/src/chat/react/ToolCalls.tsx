'use client';

/**
 * Rich tool rows (0.11.0, lifted from buildd's chat): every call is a compact
 * row (the tool as the verb, its key arguments, a live state and a one-line
 * result) that expands to the raw input and output. A write that ran under
 * "Allow" carries an `allowed` badge. Consecutive calls group under one
 * header ("2 tool calls · read-only") that folds them.
 *
 * `ChatThread toolRows="rich"` draws each run of calls with `ToolCallGroup`;
 * an app with its own group renderer uses the two components directly.
 * Styled only through `kit-toolcall*` classes and `--kit-*` properties.
 */
import { useState } from 'react';
import type { ChatToolPart } from '@builddai/ai-kit/chat/contract';
import { toolCallView, toolGroupSummary, type ToolCallOptions, type ToolCallState, type ToolCallView } from './tool-calls';

const MARK: Record<ToolCallState, { glyph: string; label: string }> = {
  running: { glyph: '■', label: 'running' },
  awaiting: { glyph: '?', label: 'waiting for you' },
  approved: { glyph: '■', label: 'approved, running' },
  done: { glyph: '✓', label: 'done' },
  failed: { glyph: '✕', label: 'failed' },
  denied: { glyph: '–', label: 'discarded' },
};

function json(v: unknown): string {
  if (v === undefined) return '—';
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export interface ToolCallRowProps {
  view: ToolCallView;
  /** Replaces the tool's label and action (a decided approval reads "New mission"). */
  label?: string;
  /** Shown instead of the key arguments, e.g. "approved by Sam". */
  note?: string | null;
  /** No frame of its own: a row inside `ToolCallGroup`. */
  flush?: boolean;
  className?: string;
}

export function ToolCallRow({ view, label, note, flush = false, className }: ToolCallRowProps) {
  const [open, setOpen] = useState(false);
  const mark = MARK[view.state];
  const result = view.state === 'running' ? 'running…' : view.result;
  const live = view.state === 'running' || view.state === 'approved';
  return (
    <div
      data-testid="tool-call-row"
      data-state={view.state}
      data-tool={view.name}
      data-flush={flush || undefined}
      data-live={live || undefined}
      className={`kit-toolcall${className ? ` ${className}` : ''}`}
    >
      <button type="button" aria-expanded={open} onClick={() => setOpen(o => !o)} className="kit-toolcall-head">
        <span aria-label={mark.label} className="kit-toolcall-mark">{mark.glyph}</span>
        <span className="kit-toolcall-name">{label ?? view.label}</span>
        {!label && view.action && <span className="kit-toolcall-action">{view.action}</span>}
        {view.allowed && <span data-testid="tool-call-allowed" className="kit-toolcall-badge">allowed</span>}
        {view.args.length > 0 && !note && <span className="kit-toolcall-args">{`· ${view.args.join(' · ')}`}</span>}
        {note && <span className="kit-toolcall-note">{`· ${note}`}</span>}
        {result && (
          <span className="kit-toolcall-result">
            <span aria-hidden="true" className="kit-toolcall-arrow">{'→ '}</span>{result}
          </span>
        )}
        <span aria-hidden="true" className="kit-toolcall-chevron">›</span>
      </button>
      {open && (
        <div data-testid="tool-call-raw" className="kit-toolcall-raw">
          <div>
            <div className="kit-toolcall-raw-label">Input</div>
            <pre className="kit-toolcall-pre">{json(view.input)}</pre>
          </div>
          <div>
            <div className="kit-toolcall-raw-label">{view.state === 'failed' ? 'Error' : 'Output'}</div>
            <pre className="kit-toolcall-pre">{view.state === 'failed' ? view.errorText ?? '—' : json(view.output)}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

export interface ToolCallGroupProps extends ToolCallOptions {
  calls: readonly ChatToolPart[];
  className?: string;
}

/** A run of consecutive calls. One call is a bare row; more get a header that folds them (open by default). */
export function ToolCallGroup({ calls, className, ...opts }: ToolCallGroupProps) {
  const [open, setOpen] = useState(true);
  const views = calls.map(p => toolCallView(p, opts));
  if (views.length === 0) return null;
  if (views.length === 1) return <ToolCallRow view={views[0]} className={className} />;
  const summary = toolGroupSummary(views);
  const tail = summary.running > 0 ? `${summary.running} running` : summary.failed > 0 ? `${summary.failed} failed` : null;
  return (
    <div data-testid="tool-call-group" data-open={open || undefined} className={`kit-toolcalls${className ? ` ${className}` : ''}`}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(o => !o)} className="kit-toolcalls-head">
        <span className="kit-toolcalls-count">{`${summary.count} tool calls`}</span>
        {summary.readOnly && <span>· read-only</span>}
        {tail && <span className="kit-toolcalls-tail" data-tone={summary.running > 0 ? 'running' : 'failed'}>{`· ${tail}`}</span>}
        <span aria-hidden="true" className="kit-toolcall-chevron">›</span>
      </button>
      {open && (
        <div className="kit-toolcalls-body">
          {views.map(v => <ToolCallRow key={v.id} view={v} flush />)}
        </div>
      )}
    </div>
  );
}
