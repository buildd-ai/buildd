'use client';

/**
 * The feed's cards: the thinking checklist, the approval card, the hand-off
 * card, the empty state and the setup card.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  approvalChanges,
  approvalHeadline,
  approvalRowOutcome,
  isHeldBack,
  isSystemDenied,
  parseApprovalPreview,
  systemDeniedLine,
  systemDeniedNote,
  type ApprovalPreview,
  type ApprovalRowOutcome,
  type ChatToolPart,
  type ChatUnavailableReason,
  type HandoffData,
  toolNameOf,
  type StepData,
} from '@builddai/ai-kit/chat/contract';
import { greeting, humanizeToolName, liveStep, pinnedStep, stepGroups, stepWeight, THINKING_TAIL, THINKING_TAIL_ID } from './model';

// ── Thinking ──────────────────────────────────────────────────────────────────

export interface ThinkingPanelProps {
  steps: readonly StepData[];
  /**
   * The turn is live. Since 0.17.0 that is one free line: a pulsing square and
   * the live step's label (a button that unfolds the whole turn), the one
   * pinned key step under it, nothing else. Before the first step it is the
   * square alone. Once the turn is done it folds to a summary.
   */
  streaming: boolean;
  /** @deprecated 0.17.0: the live line has no header any more, so this is not drawn. */
  title?: ReactNode;
  /**
   * The live line's accessible name, before its label (0.17.0): "Working"
   * reads "Working: Reading a task". Default "Working".
   */
  name?: string;
  /**
   * Draw the pinned key step yourself (0.17.0), e.g. a write as the object it
   * returned. Undefined keeps the default row.
   */
  renderPinned?(step: StepData): ReactNode | undefined;
  /** How long the live step runs before its seconds show (0.17.0). Default 20s. */
  slowAfterMs?: number;
  /**
   * The folded line once the turn is done (0.13.0), e.g. "Did 6 steps · filed
   * 2 tasks". Default "N steps". Given, the panel shows even with no steps (a
   * turn of tool calls only), as the one line they fold under.
   */
  summary?: ReactNode;
  /** Settled only: whether it is unfolded (0.13.0). Default: the `<details>` keeps its own. */
  open?: boolean;
  /** Settled only: the person folded or unfolded it (0.13.0). */
  onToggle?(open: boolean): void;
  /**
   * Keep the live line while the answer is written (0.22.0): it reads
   * "Writing the answer" instead of going, and the pinned step goes instead.
   * The line's slot stays filled from the first step to the folded line, so
   * nothing under it moves when the turn lands (`ChatThread compose="turn"`).
   */
  holdLine?: boolean;
  className?: string;
}

const MARK_LABEL: Record<StepData['state'], string> = { done: 'done', active: 'in progress', pending: 'waiting for you' };

function StepRow({ step }: { step: StepData }) {
  return (
    <li className="kit-step" data-state={step.state} data-step-id={step.id} data-weight={stepWeight(step)}>
      <span className="kit-step-mark" aria-hidden="true" />
      <span>{step.label}</span>
      <span className="kit-sr-only">({MARK_LABEL[step.state]})</span>
    </li>
  );
}

/** Two or more routine steps in a row: one dim row, "5 routine steps", that unfolds in place. */
function RoutineFold({ steps }: { steps: readonly StepData[] }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <li className="kit-step-fold" data-testid="kit-step-fold" data-open={open || undefined}>
      <button type="button" className="kit-step-fold-btn" aria-expanded={open} aria-controls={open ? listId : undefined} onClick={() => setOpen(o => !o)}>
        <span className="kit-step-fold-count">{steps.length} routine steps</span>
        <span className="kit-step-fold-labels">{steps.map(s => s.label).join(' · ')}</span>
      </button>
      {open && <ol id={listId} className="kit-steps">{steps.map(s => <StepRow key={s.id} step={s} />)}</ol>}
    </li>
  );
}

/** The turn's steps unfolded: key steps as rows, routine runs folded, the live step last. */
function StepList({ steps, id }: { steps: readonly StepData[]; id?: string }) {
  return (
    <ol id={id} className="kit-steps">
      {stepGroups(steps).map(g => (g.kind === 'step'
        ? <StepRow key={g.step.id} step={g.step} />
        : <RoutineFold key={`fold-${g.id}`} steps={g.steps} />))}
    </ol>
  );
}

/** Seconds the live step has run, ticking once a second while there is one. */
function useLiveSeconds(key: string | null): number {
  const since = useRef<{ key: string; at: number } | null>(null);
  if (key && since.current?.key !== key) since.current = { key, at: Date.now() };
  if (!key) since.current = null;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!key) return;
    const t = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [key]);
  return since.current ? Math.floor((Date.now() - since.current.at) / 1000) : 0;
}

export function ThinkingPanel({
  steps, streaming, name = 'Working', renderPinned, slowAfterMs = 20_000,
  summary: settledSummary, open, onToggle, holdLine = false, className,
}: ThinkingPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const live = streaming ? liveStep(steps) : null;
  const tail = live?.id === THINKING_TAIL_ID ? live.label : null;
  // Before the first step: the square alone. Writing the answer: no live line.
  const squareOnly = streaming && (steps.length === 0 || tail === THINKING_TAIL.reading);
  const writing = tail === THINKING_TAIL.writing;
  const lineStep = live && !squareOnly && (!writing || holdLine) ? live : null;
  const seconds = useLiveSeconds(lineStep?.state === 'active' ? `${lineStep.id}:${tail ?? ''}` : null);

  if (!streaming) {
    if (steps.length === 0 && settledSummary == null) return null;
    const summary = settledSummary ?? `${steps.length} step${steps.length === 1 ? '' : 's'}`;
    return (
      <details
        className={`kit-thinking${className ? ` ${className}` : ''}`}
        open={open || undefined}
        data-settled
        data-testid="kit-thinking"
        onToggle={onToggle ? e => { const next = e.currentTarget.open; if (next !== !!open) onToggle(next); } : undefined}
      >
        <summary data-testid="kit-thinking-summary">{summary}</summary>
        {steps.length > 0 && <StepList steps={steps} />}
      </details>
    );
  }

  const done = steps.filter(s => s.id !== THINKING_TAIL_ID);
  const pinned = expanded || (writing && holdLine) ? null : pinnedStep(steps);
  const pinnedNode = pinned ? renderPinned?.(pinned) : undefined;
  const slow = lineStep?.state === 'active' && seconds * 1000 >= slowAfterMs;
  const canExpand = done.length > 0 && (lineStep != null || expanded);
  return (
    <div
      className={`kit-thinking${className ? ` ${className}` : ''}`}
      data-streaming
      data-expanded={(expanded && canExpand) || undefined}
      data-testid="kit-thinking"
    >
      {squareOnly && (
        <div className="kit-step kit-live-line" data-state="active" role="status" aria-label={name} data-testid="kit-thinking-live">
          <span className="kit-step-mark" aria-hidden="true" />
        </div>
      )}
      {!squareOnly && (lineStep || (expanded && canExpand)) && (
        <button
          type="button"
          className="kit-step kit-live-line"
          data-state={expanded ? undefined : lineStep!.state}
          data-testid="kit-thinking-live"
          aria-expanded={expanded && canExpand}
          aria-controls={expanded ? listId : undefined}
          aria-label={expanded ? undefined : `${name}: ${lineStep!.label}`}
          disabled={!canExpand}
          onClick={() => setExpanded(e => !e)}
        >
          {expanded
            ? <span className="kit-live-count">{done.length} step{done.length === 1 ? '' : 's'}</span>
            : (
              <>
                <span className="kit-step-mark" aria-hidden="true" />
                <span className="kit-live-label" aria-live="polite">{lineStep!.label}</span>
                {slow && <span className="kit-live-timer" data-testid="kit-thinking-timer">{seconds}s</span>}
              </>
            )}
          {canExpand && <span className="kit-live-chevron" aria-hidden="true">›</span>}
        </button>
      )}
      {expanded && canExpand && <StepList steps={writing ? done : steps} id={listId} />}
      {pinned && (
        <div className="kit-thinking-pinned" data-testid="kit-thinking-pinned" data-step-id={pinned.id}>
          {pinnedNode !== undefined ? pinnedNode : <ol className="kit-steps"><StepRow step={pinned} /></ol>}
        </div>
      )}
    </div>
  );
}

// ── Approval ──────────────────────────────────────────────────────────────────

export interface ApprovalCardProps {
  part: ChatToolPart;
  /** Answer the card: echoes the approval id back (`addToolApprovalResponse`). */
  onRespond(approvalId: string, approved: boolean, reason?: string): void;
  /** "Edit": e.g. prefill the composer with "Change it: ". Hidden when absent. */
  onEdit?(part: ChatToolPart): void;
  /** Who is approving, for the folded row ("approved by Sam"). */
  approverName?: string | null;
  className?: string;
  /**
   * The card's title (0.8.0). Default: the preview's headline, else the tool's
   * name in words. Set it for a write without a preview ("New initiative").
   */
  headline?: ReactNode;
  /** After the status in the card's head, e.g. what the write is ("TELL ME WHEN") (0.8.0). */
  eyebrow?: ReactNode;
  /** At the end of the card's head, e.g. the workspace it writes to (0.8.0). */
  meta?: ReactNode;
  /** App-rendered, under the title and always shown, e.g. a draft's goal (0.8.0). */
  body?: ReactNode;
  /**
   * App-rendered detail that replaces the preview's change list and the raw
   * fields, e.g. a draft's criteria and plan (0.8.0).
   */
  details?: ReactNode;
  /**
   * Fold the details (or the change list) behind "Show details" on a phone
   * (below 640px) (0.8.0). `summary` follows the button's label; default
   * "N changes" for a change list.
   */
  fold?: boolean | { summary?: ReactNode };
  /** The confirm button (0.8.0). Default "Confirm". */
  confirmLabel?: string;
  /** The confirm button once pressed (0.8.0). Default "Applying…". */
  busyLabel?: string;
  /**
   * A decided or discarded card as one line (`row`) instead of a card (0.8.0).
   * Default `card`.
   */
  settled?: 'card' | 'row';
  /**
   * What a discard means (0.8.0). Default "Nothing changed." (a row: "nothing changed").
   * Only the person's Discard: a write the server refused before showing a
   * card reads "not proposed" instead (0.12.0).
   */
  deniedNote?: string;
}

function ChangeValue({ before, after }: { before: string | null; after: string | null }) {
  return (
    <span>
      {before !== null && <del>{before}</del>}
      {before !== null && after !== null && <span aria-hidden="true" className="kit-change-arrow"> → </span>}
      {before !== null && after !== null && <span className="kit-sr-only"> becomes </span>}
      {after !== null && <span>{before === null && <><span className="kit-change-mark" data-mark="add">+</span>{' '}</>}{after}</span>}
    </span>
  );
}

/**
 * A write the model proposed. Nothing runs until Confirm; the server checks the
 * approval id, the input hash and the approver. The card shows the server's
 * preview (before → after) when there is one, else the raw fields, or the
 * app's own `details`. An admin write with `confirmText` needs the name typed.
 */
export function ApprovalCard({
  part, onRespond, onEdit, approverName, className,
  headline: headlineProp, eyebrow, meta, body, details, fold, confirmLabel = 'Confirm', busyLabel = 'Applying…', settled = 'card', deniedNote,
}: ApprovalCardProps) {
  const [sent, setSent] = useState<'confirm' | 'deny' | null>(null);
  const [typed, setTyped] = useState('');
  const [open, setOpen] = useState(false);
  const foldId = useId();
  const preview = parseApprovalPreview(part.approval?.requestReason);
  const approvalId = part.approval?.id ?? null;
  const headline = headlineProp ?? (preview ? approvalHeadline(preview) : humanizeToolName(toolNameOf(part)));
  const cls = `kit-card${className ? ` ${className}` : ''}`;
  const head = (status: ReactNode) => (eyebrow == null && meta == null
    ? <span className="kit-eyebrow">{status}</span>
    : (
      <div className="kit-card-head">
        <span className="kit-eyebrow">{status}</span>
        {eyebrow != null && <span className="kit-card-tag">{eyebrow}</span>}
        {meta != null && <span className="kit-card-meta">{meta}</span>}
      </div>
    ));

  const done = part.state === 'output-available' || part.state === 'output-error';
  // The server refused it before any card was shown (a full card, a card
  // that stands alone): the person never saw it, so it is never "discarded".
  if (isSystemDenied(part)) {
    const why = systemDeniedNote(part);
    return settled === 'row'
      ? (
        <div className={`${cls} kit-approval-row`} data-state="skipped" data-testid="kit-approval">
          <span className="kit-card-title">{headline}</span>
          <span className="kit-note">{systemDeniedLine(part)}</span>
        </div>
      )
      : (
        <div className={cls} data-state="skipped" data-testid="kit-approval">
          {head(isHeldBack(part) ? 'Not proposed yet' : 'Not proposed')}
          <p className="kit-card-title">{headline}</p>
          <p className="kit-note">{`${why.charAt(0).toUpperCase()}${why.slice(1)}. Nothing changed.`}</p>
        </div>
      );
  }
  const denied = part.state === 'output-denied' || (part.state === 'approval-responded' && part.approval?.approved === false);
  if ((done || denied) && settled === 'row') {
    const note = denied
      ? `discarded · ${deniedNote ?? 'nothing changed'}`
      : part.state === 'output-error' ? `failed${part.errorText ? ` · ${part.errorText}` : ''}` : approverName ? `approved by ${approverName}` : 'approved';
    return (
      <div className={`${cls} kit-approval-row`} data-state={denied ? 'denied' : 'done'} data-testid="kit-approval">
        <span className="kit-card-title">{headline}</span>
        <span className="kit-note">{note}</span>
      </div>
    );
  }
  if (done) {
    return (
      <div className={cls} data-state="done" data-testid="kit-approval">
        {head(part.state === 'output-error' ? 'Failed' : approverName ? `Approved by ${approverName}` : 'Approved')}
        <p className="kit-card-title">{headline}</p>
        {part.state === 'output-error' && part.errorText && <p className="kit-note">{part.errorText}</p>}
      </div>
    );
  }
  if (denied) {
    return (
      <div className={cls} data-state="denied" data-testid="kit-approval">
        {head('Discarded')}
        <p className="kit-card-title">{headline}</p>
        <p className="kit-note">{deniedNote ?? 'Nothing changed.'}</p>
      </div>
    );
  }

  const deciding = part.state === 'approval-responded' || sent !== null;
  const confirmText = preview?.confirmText ?? null;
  const typedOk = !confirmText || typed.trim() === confirmText.trim();
  const fields = details == null && !preview && part.input && typeof part.input === 'object' ? Object.entries(part.input as Record<string, unknown>) : [];
  const changes = details == null && preview ? approvalChanges(preview) : [];

  const detail = details != null ? details : (
    <>
      {changes.length > 0 && (
        <ul className="kit-changes">
          {changes.map((c, i) => (
            <li key={i} className="kit-change">
              <span className="kit-change-label">{c.label}</span>
              <ChangeValue before={c.before} after={c.after} />
            </li>
          ))}
        </ul>
      )}
      {fields.length > 0 && (
        <ul className="kit-changes">
          {fields.map(([k, v]) => (
            <li key={k} className="kit-change">
              <span className="kit-change-label">{humanizeToolName(k)}</span>
              <span>{typeof v === 'string' ? v : JSON.stringify(v)}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
  const count = changes.length || fields.length;
  const foldable = !!fold && (details != null || count > 0);
  const summary = typeof fold === 'object' && fold.summary != null
    ? fold.summary
    : details == null && count > 0 ? `${count} change${count === 1 ? '' : 's'}` : null;

  return (
    <section className={cls} data-state={deciding ? 'deciding' : 'awaiting'} data-approval-id={approvalId ?? undefined} aria-label={`Approval needed: ${typeof headline === 'string' ? headline : humanizeToolName(toolNameOf(part))}`} data-testid="kit-approval">
      {head(deciding ? (sent === 'deny' ? 'Discarding…' : 'Confirmed') : 'Approval needed')}
      <h3 className="kit-card-title">{headline}</h3>
      {body != null && <div className="kit-approval-body">{body}</div>}
      {foldable ? (
        <>
          <button type="button" className="kit-fold-toggle" aria-expanded={open} aria-controls={foldId} onClick={() => setOpen(o => !o)} data-testid="kit-approval-fold">
            <span aria-hidden="true">{open ? '▾' : '▸'}</span>
            <span className="kit-fold-label">{open ? 'Hide details' : 'Show details'}</span>
            {summary != null && <span className="kit-fold-summary">{summary}</span>}
          </button>
          <div id={foldId} className="kit-fold" data-open={open || undefined} data-testid="kit-approval-details">{detail}</div>
        </>
      ) : detail}
      {preview?.note && <p className="kit-note">{preview.note}</p>}
      {confirmText && (
        <label className="kit-confirm-field">
          <span className="kit-note">Type <strong>{confirmText}</strong> to confirm</span>
          <input className="kit-input" value={typed} onChange={e => setTyped(e.target.value)} disabled={deciding} autoComplete="off" data-testid="kit-approval-typed" />
        </label>
      )}
      <div className="kit-actions">
        <button
          type="button"
          className="kit-btn"
          data-variant="primary"
          disabled={deciding || !approvalId || !typedOk}
          onClick={() => { if (!approvalId) return; setSent('confirm'); onRespond(approvalId, true, confirmText ? typed.trim() : undefined); }}
          data-testid="kit-approval-confirm"
        >
          {sent === 'confirm' ? busyLabel : confirmLabel}
        </button>
        {onEdit && (
          <button type="button" className="kit-btn" disabled={deciding} onClick={() => onEdit(part)} data-testid="kit-approval-edit">Edit</button>
        )}
        <button
          type="button"
          className="kit-btn"
          data-variant="quiet"
          disabled={deciding || !approvalId}
          onClick={() => { if (!approvalId) return; setSent('deny'); onRespond(approvalId, false, 'Discarded by the user'); }}
          data-testid="kit-approval-deny"
        >
          Discard
        </button>
      </div>
    </section>
  );
}

// ── Approval rows (0.13.0) ────────────────────────────────────────────────────

export interface ApprovalRowsCardProps {
  /** The writes shown on the card, one row each (`approvalRowGroup(parts).rows`). */
  parts: readonly ChatToolPart[];
  /** Writes the server held back (the card was full): "not proposed yet", never a toggle. */
  held?: readonly ChatToolPart[];
  /**
   * Answer one row: echoes its approval id back. Confirm calls it once per
   * row, approved or not per the row's toggle; Discard calls it with `false`
   * for every row. The continuation goes when the last row is answered.
   */
  onRespond(approvalId: string, approved: boolean, reason?: string): void;
  /** Who is approving, for the settled rows ("done · Sam"). */
  approverName?: string | null;
  className?: string;
  /** After the status in the card's head. */
  eyebrow?: ReactNode;
  /** At the end of the card's head, e.g. the workspace it writes to. */
  meta?: ReactNode;
  /** A row's line. Default: from the preview (its target, its verb, or both), else the tool's name. */
  rowLabel?(part: ChatToolPart): ReactNode;
  /** The confirm button for `n` checked rows. Default "Confirm n". */
  confirmLabel?(n: number): string;
  /** The confirm button once pressed. Default "Applying…". */
  busyLabel?: string;
}

/**
 * The card's headline and how each row reads, from the rows' previews. `used`
 * is how many of a row's changes its label already says, so its second line
 * starts after them.
 */
function rowsShape(previews: readonly (ApprovalPreview | null)[]): { headline: string; row: (p: ApprovalPreview) => string; used: number } {
  const n = previews.length;
  const all = previews.every((p): p is ApprovalPreview => !!p);
  const target = (p: ApprovalPreview) => `${p.target.label}${p.target.detail ? ` (${p.target.detail})` : ''}`;
  const sameVerb = all && previews.every(p => p.verb === previews[0]!.verb);
  const sameTarget = all && previews.every(p => p.target.kind === previews[0]!.target.kind && p.target.id === previews[0]!.target.id);
  const first = (p: ApprovalPreview) => approvalChanges(p)[0];
  if (sameVerb && sameTarget && previews.every(p => first(p)?.after)) {
    // The same thing made several times in one place (three tasks in one
    // mission): headed by both, each row by what it makes.
    return { headline: `${previews[0]!.verb} ${target(previews[0]!)} · ${n}`, row: p => first(p)!.after!, used: 1 };
  }
  if (sameVerb) {
    // One intent across many targets: "Auto-dismiss · 3", a row per target.
    return { headline: `${previews[0]!.verb} · ${n}`, row: target, used: 0 };
  }
  if (sameTarget) {
    // Many intents on one subject: headed by the subject, each row its verb.
    return { headline: target(previews[0]!), row: p => p.verb, used: 0 };
  }
  return { headline: `${n} changes`, row: approvalHeadline, used: 0 };
}

const ROW_NOTE: Record<Exclude<ApprovalRowOutcome, 'awaiting' | 'held'>, string> = {
  deciding: 'applying…',
  ran: 'done',
  changed: 'changed since shown · nothing ran',
  failed: 'failed',
  discarded: 'discarded · nothing changed',
};

function failureText(part: ChatToolPart): string | null {
  if (part.errorText) return part.errorText;
  const data = (part.output as { data?: unknown } | undefined)?.data;
  return typeof data === 'string' ? data.replace(/^Error:\s*/, '') : null;
}

/**
 * One card for a turn's writes (0.13.0): a row each, all checked. One
 * Confirm answers every row (checked ones approved, the rest declined), one
 * Discard declines them all. Each row is still its own approval: the server
 * checks its approval id, input hash and preview on its own and runs it, or
 * refuses it, without touching the others, and the settled card says how
 * each went. Rows fold to one line; a tap shows the full target and what
 * changes.
 */
export function ApprovalRowsCard({
  parts, held = [], onRespond, approverName, className, eyebrow, meta, rowLabel,
  confirmLabel = n => `Confirm ${n}`, busyLabel = 'Applying…',
}: ApprovalRowsCardProps) {
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(() => new Set());
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [sent, setSent] = useState<'confirm' | 'deny' | null>(null);
  const baseId = useId();
  const previews = parts.map(p => parseApprovalPreview(p.approval?.requestReason));
  const shape = rowsShape(previews);
  const outcomes = parts.map(p => approvalRowOutcome(p));
  const awaiting = outcomes.includes('awaiting') && sent === null;
  const settled = !outcomes.some(o => o === 'awaiting' || o === 'deciding');
  const checkedCount = parts.filter(p => !unchecked.has(p.toolCallId)).length;
  const counts = (o: ApprovalRowOutcome) => outcomes.filter(x => x === o).length;
  const status = awaiting
    ? 'Approval needed'
    : !settled
      ? (sent === 'deny' ? 'Discarding…' : 'Confirmed')
      : [counts('ran') && `${counts('ran')} done`, counts('changed') && `${counts('changed')} changed`, counts('failed') && `${counts('failed')} failed`, counts('discarded') && `${counts('discarded')} discarded`]
        .filter(Boolean).join(' · ') || 'Done';
  const flip = (set: ReadonlySet<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  };

  const answerAll = (confirm: boolean) => {
    setSent(confirm ? 'confirm' : 'deny');
    for (const p of parts) {
      const id = p.approval?.id;
      if (!id || p.state !== 'approval-requested') continue;
      const approved = confirm && !unchecked.has(p.toolCallId);
      onRespond(id, approved, approved ? undefined : confirm ? 'Unchecked by the user' : 'Discarded by the user');
    }
  };

  const label = (p: ChatToolPart, i: number): ReactNode => rowLabel?.(p)
    ?? (previews[i] ? shape.row(previews[i]!) : humanizeToolName(toolNameOf(p)));

  return (
    <section
      className={`kit-card kit-approval-rows${className ? ` ${className}` : ''}`}
      data-state={awaiting ? 'awaiting' : settled ? 'done' : 'deciding'}
      aria-label={`Approval needed: ${shape.headline}`}
      data-testid="kit-approval-rows"
    >
      <div className="kit-card-head">
        <span className="kit-eyebrow">{status}</span>
        {eyebrow != null && <span className="kit-card-tag">{eyebrow}</span>}
        {meta != null && <span className="kit-card-meta">{meta}</span>}
      </div>
      <h3 className="kit-card-title">{shape.headline}</h3>
      <ul className="kit-apr-rows">
        {parts.map((p, i) => {
          const outcome = outcomes[i];
          const on = !unchecked.has(p.toolCallId);
          const titleId = `${baseId}-t${i}`;
          const detailId = `${baseId}-d${i}`;
          const expanded = open.has(p.toolCallId);
          const preview = previews[i];
          const changes = preview ? approvalChanges(preview) : [];
          const fields = !preview && p.input && typeof p.input === 'object' ? Object.entries(p.input as Record<string, unknown>) : [];
          const failure = outcome === 'failed' || outcome === 'changed' ? failureText(p) : null;
          // Folded, the second line is the first change the label doesn't already say.
          const next = changes[shape.used] ?? null;
          const note = outcome === 'awaiting'
            ? (on ? (next ? `${next.label}: ${next.after ?? next.before ?? ''}` : fields.length ? `${fields.length} field${fields.length === 1 ? '' : 's'}` : 'as shown') : 'won’t run')
            : outcome === 'ran' && approverName ? `done · ${approverName}` : ROW_NOTE[outcome as keyof typeof ROW_NOTE];
          return (
            <li key={p.toolCallId} className="kit-apr-row" data-outcome={outcome} data-checked={outcome === 'awaiting' ? on : undefined} data-approval-id={p.approval?.id} data-testid="kit-approval-row">
              {outcome === 'awaiting'
                ? (
                  <input
                    type="checkbox"
                    className="kit-apr-check"
                    checked={on}
                    disabled={!awaiting}
                    aria-labelledby={titleId}
                    onChange={() => setUnchecked(u => flip(u, p.toolCallId))}
                    data-testid="kit-approval-row-check"
                  />
                )
                : <span className="kit-apr-mark" aria-hidden="true">{outcome === 'ran' ? '✓' : outcome === 'deciding' ? '·' : outcome === 'discarded' ? '–' : '!'}</span>}
              <button type="button" className="kit-apr-main" aria-expanded={expanded} aria-controls={detailId} onClick={() => setOpen(o => flip(o, p.toolCallId))} data-testid="kit-approval-row-expand">
                <span id={titleId} className="kit-apr-title">{label(p, i)}</span>
                <span className="kit-apr-note">{note}</span>
              </button>
              <div id={detailId} className="kit-apr-detail" hidden={!expanded} data-testid="kit-approval-row-detail">
                <p className="kit-apr-full">{label(p, i)}</p>
                {changes.length > 0 && (
                  <ul className="kit-changes">
                    {changes.map((c, j) => (
                      <li key={j} className="kit-change">
                        <span className="kit-change-label">{c.label}</span>
                        <ChangeValue before={c.before} after={c.after} />
                      </li>
                    ))}
                  </ul>
                )}
                {fields.length > 0 && (
                  <ul className="kit-changes">
                    {fields.map(([k, v]) => (
                      <li key={k} className="kit-change">
                        <span className="kit-change-label">{humanizeToolName(k)}</span>
                        <span>{typeof v === 'string' ? v : JSON.stringify(v)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {failure && <p className="kit-note">{failure}</p>}
              </div>
            </li>
          );
        })}
        {held.map(p => (
          <li key={p.toolCallId} className="kit-apr-row" data-outcome="held" data-testid="kit-approval-row">
            <span className="kit-apr-mark" aria-hidden="true">·</span>
            <span className="kit-apr-main">
              <span className="kit-apr-title">{rowLabel?.(p) ?? humanizeToolName(toolNameOf(p))}</span>
              <span className="kit-apr-note">{systemDeniedLine(p)}</span>
            </span>
          </li>
        ))}
      </ul>
      {!settled && (
        <div className="kit-actions">
          <button
            type="button"
            className="kit-btn"
            data-variant="primary"
            disabled={!awaiting || checkedCount === 0}
            onClick={() => answerAll(true)}
            data-testid="kit-approval-confirm"
          >
            {awaiting || sent === 'deny' ? confirmLabel(checkedCount) : busyLabel}
          </button>
          <button
            type="button"
            className="kit-btn"
            data-variant="quiet"
            disabled={!awaiting}
            onClick={() => answerAll(false)}
            data-testid="kit-approval-deny"
          >
            Discard all
          </button>
        </div>
      )}
    </section>
  );
}

// ── Hand-off ──────────────────────────────────────────────────────────────────

const HANDOFF_STATE: Record<HandoffData['state'], string> = {
  filed: 'Filed as a task',
  running: 'Running',
  completed: 'Done',
  failed: 'Failed',
};

export interface HandoffCardProps {
  data: HandoffData;
  /** Link label. Default "Open task". */
  openLabel?: string;
  /** Replace the link (e.g. an in-app route). */
  renderLink?(data: HandoffData): ReactNode;
  className?: string;
}

/** A long job filed to a runner, as a live object. Pass the newest state (`latestHandoffs`). */
export function HandoffCard({ data, openLabel = 'Open task', renderLink, className }: HandoffCardProps) {
  const settled = data.state === 'completed' || data.state === 'failed';
  return (
    <section className={`kit-card${className ? ` ${className}` : ''}`} data-state={settled ? 'done' : 'live'} data-handoff-state={data.state} aria-label={`${HANDOFF_STATE[data.state]}: ${data.title ?? 'Task'}`} data-testid="kit-handoff">
      <span className="kit-eyebrow">{HANDOFF_STATE[data.state]}</span>
      <h3 className="kit-card-title">{data.title ?? 'Task'}</h3>
      {data.summary && <p className="kit-note">{data.summary}</p>}
      <div className="kit-actions">
        {renderLink ? renderLink(data) : <a className="kit-link" href={data.url}>{openLabel}</a>}
      </div>
    </section>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

/** A one-tap chip on the empty state. `send: false` prefills the composer instead of sending. */
export interface ChatEmptyChip {
  /** Stable id, e.g. for Jev ordering via `/surfaces`. */
  id?: string;
  label: string;
  text: string;
  send: boolean;
  /** A styling hook on the chip, as `data-tone`, e.g. `needs` for the one waiting on the person (0.8.0). */
  tone?: string;
}

export interface ChatEmptyProps {
  name?: string | null;
  /** The app's chip catalogue, already ordered (default order, or a `/surfaces` pick). */
  chips: readonly ChatEmptyChip[];
  onChip(chip: ChatEmptyChip): void;
  /** Replace the greeting line. */
  greeting?: ReactNode;
  className?: string;
  /** A small line above the greeting, e.g. the date (0.8.0). */
  overline?: ReactNode;
  /**
   * The canvas's mood, as `data-mood` on the box; with an `overline`, a dot
   * leads it (`.kit-mood-dot`) (0.8.0).
   */
  mood?: string | null;
  /** A line under the greeting (0.8.0). */
  sub?: ReactNode;
  /** A header over the chips, e.g. "Picked for you" (0.8.0). Read before the chips. */
  chipsHeader?: ReactNode;
  /** The header's right-hand side, e.g. "1 blocked" (0.8.0). */
  chipsAside?: ReactNode;
  /** `rows`: full-width rows in one ruled box instead of wrapping chips (0.8.0). */
  variant?: 'chips' | 'rows';
}

export function ChatEmpty({ name, chips, onChip, greeting: custom, className, overline, mood, sub, chipsHeader, chipsAside, variant = 'chips' }: ChatEmptyProps) {
  return (
    <div className={`kit-empty${className ? ` ${className}` : ''}`} data-mood={mood ?? undefined} data-testid="kit-empty">
      {overline != null && (
        <p className="kit-empty-overline" data-testid="kit-empty-overline">
          {mood && <span aria-hidden="true" className="kit-mood-dot" data-mood={mood} />}
          {overline}
        </p>
      )}
      <h2 className="kit-greeting">{custom ?? greeting(name)}</h2>
      {sub != null && <p className="kit-empty-sub">{sub}</p>}
      {chips.length > 0 && (chipsHeader != null || chipsAside != null) && (
        <div className="kit-chips-head" data-testid="kit-chips-head">
          <span>{chipsHeader}</span>
          {chipsAside != null && <span className="kit-chips-aside">{chipsAside}</span>}
        </div>
      )}
      {chips.length > 0 && (
        <ul className="kit-chips" data-variant={variant === 'rows' ? 'rows' : undefined} aria-label="Suggestions">
          {chips.map(c => (
            <li key={c.id ?? c.label}>
              <button type="button" className="kit-chip" data-send={c.send} data-chip={c.id} data-tone={c.tone} onClick={() => onChip(c)}>{c.label}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Setup ─────────────────────────────────────────────────────────────────────

export interface ChatSetupCardProps {
  reason: ChatUnavailableReason;
  /** A heading under the eyebrow, e.g. "Connect a model provider" (0.6.1). */
  title?: ReactNode;
  /** The server's message (the 4xx body's `message`), or the app's own copy. */
  message?: string;
  /** "Add your OpenRouter key" link or button. */
  action?: ReactNode;
  className?: string;
}

const SETUP_TITLE: Record<ChatUnavailableReason, string> = {
  no_key: 'Chat needs a key',
  budget_exhausted: 'Chat budget used up',
  rate_limited: 'Slow down a moment',
};

/** Shown when a turn is refused before any model call. Keep the draft in the composer. */
export function ChatSetupCard({ reason, title, message, action, className }: ChatSetupCardProps) {
  return (
    <section className={`kit-card${className ? ` ${className}` : ''}`} data-reason={reason} role="status" data-testid="kit-setup">
      <span className="kit-eyebrow">{SETUP_TITLE[reason]}</span>
      {title && <h3 className="kit-card-title" data-testid="kit-setup-title">{title}</h3>}
      {message && <p className="kit-note">{message}</p>}
      {action && <div className="kit-actions">{action}</div>}
    </section>
  );
}
