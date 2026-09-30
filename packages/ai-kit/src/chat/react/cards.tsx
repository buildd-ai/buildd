'use client';

/**
 * The feed's cards: the thinking checklist, the approval card, the hand-off
 * card, the empty state and the setup card.
 */
import { useId, useState, type ReactNode } from 'react';
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
import { greeting, humanizeToolName } from './model';

// ── Thinking ──────────────────────────────────────────────────────────────────

export interface ThinkingPanelProps {
  steps: readonly StepData[];
  /** Open while the turn streams; folded to a summary once it's done. */
  streaming: boolean;
  /** The summary while streaming. Default "Thinking". A node since 0.9.0. */
  title?: ReactNode;
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
  className?: string;
}

const MARK_LABEL: Record<StepData['state'], string> = { done: 'done', active: 'in progress', pending: 'waiting for you' };

export function ThinkingPanel({ steps, streaming, title = 'Thinking', summary: settledSummary, open, onToggle, className }: ThinkingPanelProps) {
  if (steps.length === 0 && (streaming || settledSummary == null)) return null;
  const summary = streaming ? title : settledSummary ?? `${steps.length} step${steps.length === 1 ? '' : 's'}`;
  return (
    <details
      className={`kit-thinking${className ? ` ${className}` : ''}`}
      open={streaming || open || undefined}
      data-streaming={streaming || undefined}
      data-settled={!streaming || undefined}
      data-testid="kit-thinking"
      onToggle={streaming || !onToggle ? undefined : e => { const next = e.currentTarget.open; if (next !== !!open) onToggle(next); }}
    >
      <summary data-testid="kit-thinking-summary">{summary}</summary>
      {steps.length > 0 && (
        <ol className="kit-steps" aria-live={streaming ? 'polite' : undefined}>
          {steps.map(s => (
            <li key={s.id} className="kit-step" data-state={s.state} data-step-id={s.id}>
              <span className="kit-step-mark" aria-hidden="true" />
              <span>{s.label}</span>
              <span className="kit-sr-only">({MARK_LABEL[s.state]})</span>
            </li>
          ))}
        </ol>
      )}
    </details>
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
    <section className={cls} data-state={deciding ? 'deciding' : 'awaiting'} data-approval-id={approvalId ?? undefined} aria-label={`Needs your OK: ${typeof headline === 'string' ? headline : humanizeToolName(toolNameOf(part))}`} data-testid="kit-approval">
      {head(deciding ? (sent === 'deny' ? 'Discarding…' : 'Confirmed') : 'Needs your OK')}
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
    ? 'Needs your OK'
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
      aria-label={`Needs your OK: ${shape.headline}`}
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
