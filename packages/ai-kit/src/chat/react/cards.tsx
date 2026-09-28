'use client';

/**
 * The feed's cards: the thinking checklist, the approval card, the hand-off
 * card, the empty state and the setup card.
 */
import { useState, type ReactNode } from 'react';
import {
  approvalHeadline,
  parseApprovalPreview,
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
  title?: string;
  className?: string;
}

const MARK_LABEL: Record<StepData['state'], string> = { done: 'done', active: 'in progress', pending: 'waiting for you' };

export function ThinkingPanel({ steps, streaming, title = 'Thinking', className }: ThinkingPanelProps) {
  if (steps.length === 0) return null;
  const summary = streaming ? title : `${steps.length} step${steps.length === 1 ? '' : 's'}`;
  return (
    <details className={`kit-thinking${className ? ` ${className}` : ''}`} open={streaming || undefined} data-streaming={streaming || undefined} data-testid="kit-thinking">
      <summary>{summary}</summary>
      <ol className="kit-steps" aria-live={streaming ? 'polite' : undefined}>
        {steps.map(s => (
          <li key={s.id} className="kit-step" data-state={s.state} data-step-id={s.id}>
            <span className="kit-step-mark" aria-hidden="true" />
            <span>{s.label}</span>
            <span className="kit-sr-only">({MARK_LABEL[s.state]})</span>
          </li>
        ))}
      </ol>
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
}

/**
 * A write the model proposed. Nothing runs until Confirm; the server checks the
 * approval id, the input hash and the approver. The card shows the server's
 * preview (before → after) when there is one, else the raw fields. An admin
 * write with `confirmText` needs the name typed.
 */
export function ApprovalCard({ part, onRespond, onEdit, approverName, className }: ApprovalCardProps) {
  const [sent, setSent] = useState<'confirm' | 'deny' | null>(null);
  const [typed, setTyped] = useState('');
  const preview = parseApprovalPreview(part.approval?.requestReason);
  const approvalId = part.approval?.id ?? null;
  const headline = preview ? approvalHeadline(preview) : humanizeToolName(toolNameOf(part));
  const cls = `kit-card${className ? ` ${className}` : ''}`;

  if (part.state === 'output-available' || part.state === 'output-error') {
    return (
      <div className={cls} data-state="done" data-testid="kit-approval">
        <span className="kit-eyebrow">{part.state === 'output-error' ? 'Failed' : approverName ? `Approved by ${approverName}` : 'Approved'}</span>
        <p className="kit-card-title">{headline}</p>
        {part.state === 'output-error' && part.errorText && <p className="kit-note">{part.errorText}</p>}
      </div>
    );
  }
  if (part.state === 'output-denied' || (part.state === 'approval-responded' && part.approval?.approved === false)) {
    return (
      <div className={cls} data-state="denied" data-testid="kit-approval">
        <span className="kit-eyebrow">Discarded</span>
        <p className="kit-card-title">{headline}</p>
        <p className="kit-note">Nothing changed.</p>
      </div>
    );
  }

  const deciding = part.state === 'approval-responded' || sent !== null;
  const confirmText = preview?.confirmText ?? null;
  const typedOk = !confirmText || typed.trim() === confirmText.trim();
  const fields = !preview && part.input && typeof part.input === 'object' ? Object.entries(part.input as Record<string, unknown>) : [];

  return (
    <section className={cls} data-state={deciding ? 'deciding' : 'awaiting'} data-approval-id={approvalId ?? undefined} aria-label={`Needs your OK: ${headline}`} data-testid="kit-approval">
      <span className="kit-eyebrow">{deciding ? (sent === 'deny' ? 'Discarding…' : 'Confirmed') : 'Needs your OK'}</span>
      <h3 className="kit-card-title">{headline}</h3>
      {preview && preview.changes.length > 0 && (
        <ul className="kit-changes">
          {preview.changes.map((c, i) => (
            <li key={i} className="kit-change">
              <span className="kit-change-label">{c.label}</span>
              <span>
                {c.before !== null && <del>{c.before}</del>}
                {c.before !== null && c.after !== null && <span aria-hidden="true"> → </span>}
                {c.before !== null && c.after !== null && <span className="kit-sr-only"> becomes </span>}
                {c.after !== null && <span>{c.before === null ? '+ ' : ''}{c.after}</span>}
              </span>
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
          {sent === 'confirm' ? 'Applying…' : 'Confirm'}
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
}

export interface ChatEmptyProps {
  name?: string | null;
  /** The app's chip catalogue, already ordered (default order, or a `/surfaces` pick). */
  chips: readonly ChatEmptyChip[];
  onChip(chip: ChatEmptyChip): void;
  /** Replace the greeting line. */
  greeting?: ReactNode;
  className?: string;
}

export function ChatEmpty({ name, chips, onChip, greeting: custom, className }: ChatEmptyProps) {
  return (
    <div className={`kit-empty${className ? ` ${className}` : ''}`} data-testid="kit-empty">
      <h2 className="kit-greeting">{custom ?? greeting(name)}</h2>
      {chips.length > 0 && (
        <ul className="kit-chips" aria-label="Suggestions">
          {chips.map(c => (
            <li key={c.id ?? c.label}>
              <button type="button" className="kit-chip" data-send={c.send} data-chip={c.id} onClick={() => onChip(c)}>{c.label}</button>
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
export function ChatSetupCard({ reason, message, action, className }: ChatSetupCardProps) {
  return (
    <section className={`kit-card${className ? ` ${className}` : ''}`} data-reason={reason} role="status" data-testid="kit-setup">
      <span className="kit-eyebrow">{SETUP_TITLE[reason]}</span>
      {message && <p className="kit-note">{message}</p>}
      {action && <div className="kit-actions">{action}</div>}
    </section>
  );
}
