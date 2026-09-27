'use client';

/**
 * A write the agent proposed, as the approval card itself (docs/design/agent-chat.md,
 * "Tool calls you can see"). Nothing is filed until Confirm, which echoes the
 * approval id back; the server checks the id, the input hash and the approver.
 * Once decided the card folds to its tool row, and the filed object renders
 * live right under it.
 *
 * An approval is a fleet object in the v3 language (docs/design/chat-canvas.md,
 * "Mobile canvas"): a square card with a 1px rule and a 3px offset shadow, a
 * 2px copper top edge for "needs you", mono chrome, and what changes said in
 * Newsreader. Plain buttons. No keycaps: nothing here has a key.
 */
import { useState } from 'react';
import type { ChatToolPart } from './chat-contract';
import { useChatActions } from './ChatActions';
import { approvalDraft, approvalLabel, type ApprovalDraft } from './approval-draft';
import { toolRowView } from './feed-model';
import { ToolCallRow } from './ToolCallRows';

/** What stays in view on a phone: the draft's title and goal. */
function DraftSummary({ draft }: { draft: ApprovalDraft }) {
  if (draft.kind === 'generic') return null;
  if (draft.kind === 'preview') {
    return (
      <h3 data-testid="approval-draft-title" className="font-voice text-[19px] md:text-[20px] leading-[1.3] text-[var(--chat-text)] [overflow-wrap:anywhere]">
        {draft.headline}
      </h3>
    );
  }
  return (
    <>
      <h3 data-testid="approval-draft-title" className="font-mono text-[17px] md:text-[20px] font-semibold leading-snug text-text-primary [overflow-wrap:anywhere]">
        {draft.title}
      </h3>
      {draft.goal && <p className="mt-1.5 line-clamp-2 md:line-clamp-none font-convo text-[14.5px] md:text-[15px] leading-relaxed text-text-secondary [overflow-wrap:anywhere]">{draft.goal}</p>}
    </>
  );
}

/** "4 criteria · constraints · plan": what the folded details hold. */
function detailsSummary(draft: ApprovalDraft): string {
  if (draft.kind === 'generic') return `${draft.fields.length} field${draft.fields.length === 1 ? '' : 's'}`;
  if (draft.kind === 'preview') return `${draft.changes.length} change${draft.changes.length === 1 ? '' : 's'}`;
  const bits: string[] = [];
  if (draft.criteria.length) bits.push(`${draft.criteria.length} criteri${draft.criteria.length === 1 ? 'on' : 'a'}`);
  if (draft.constraints) bits.push('constraints');
  if (draft.plan) bits.push('plan');
  return bits.join(' · ');
}

function hasDetails(draft: ApprovalDraft): boolean {
  if (draft.kind === 'preview') return draft.changes.length > 0 || !!draft.note;
  return draft.kind === 'generic' ? draft.fields.length > 0 : draft.criteria.length > 0 || !!draft.constraints || !!draft.plan;
}

/**
 * before → after, one ruled row per change: a mono label, the value in
 * Newsreader. A pure addition shows "+", a removal "−" struck through.
 */
function PreviewDetails({ draft }: { draft: Extract<ApprovalDraft, { kind: 'preview' }> }) {
  return (
    <div className="mt-2.5 md:mt-3">
      <ul data-testid="approval-changes" className="divide-y divide-[var(--chat-rule)] border-y border-[var(--chat-rule)]">
        {draft.changes.map((c, i) => (
          <li key={i} data-testid="approval-change" className="grid min-w-0 grid-cols-1 gap-x-4 py-2 md:grid-cols-[110px_1fr] md:items-baseline">
            <span className="font-mono text-[11px] uppercase tracking-[.14em] text-[var(--chat-muted)] [overflow-wrap:anywhere]">{c.label}</span>
            <span className="min-w-0 font-voice text-[16.5px] leading-[1.4] text-[var(--chat-text)] [overflow-wrap:anywhere]">
              {c.before === null && c.after !== null && <><span aria-label="added" className="font-mono text-[13px] text-[var(--mood-needs)]">+ </span>{c.after}</>}
              {c.after === null && c.before !== null && <><span aria-label="removed" className="font-mono text-[13px] text-[var(--chat-muted)]">− </span><s className="text-[var(--chat-muted)]">{c.before}</s></>}
              {c.before !== null && c.after !== null && (
                <><s className="text-[var(--chat-muted)]">{c.before}</s><span aria-hidden="true" className="px-1.5 font-mono text-[var(--chat-muted)]">→</span>{c.after}</>
              )}
              {c.before === null && c.after === null && '—'}
            </span>
          </li>
        ))}
      </ul>
      {draft.note && <p data-testid="approval-note" className="mt-2 font-voice text-[15px] italic text-[var(--chat-muted)]">{draft.note}</p>}
    </div>
  );
}

function DraftDetails({ draft }: { draft: ApprovalDraft }) {
  if (draft.kind === 'preview') return <PreviewDetails draft={draft} />;
  if (draft.kind === 'generic') {
    return (
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 font-mono text-[12.5px]">
        {draft.fields.map(f => (
          <div key={f.key} className="contents">
            <dt className="uppercase tracking-[1.5px] text-[11px] text-text-muted">{f.key}</dt>
            <dd className="min-w-0 [overflow-wrap:anywhere] text-text-primary">{f.value}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <>
      <dl className="mt-2 md:mt-4 grid grid-cols-1 md:grid-cols-[130px_1fr] gap-x-4 gap-y-2.5 font-mono text-[12.5px]">
        {draft.criteria.length > 0 && (
          <>
            <dt className="uppercase tracking-[1.5px] text-[11px] text-text-muted md:pt-0.5">Done when</dt>
            <dd>
              <ul data-testid="approval-draft-criteria" className="grid gap-1.5">
                {draft.criteria.map((c, i) => (
                  <li key={i} className="min-w-0">
                    <span className="flex items-center gap-2.5 text-text-primary">
                      <span aria-hidden="true" className="h-3.5 w-3.5 shrink-0 border-[1.5px] border-border-strong" />
                      <span className="min-w-0 [overflow-wrap:anywhere]">{c.label}</span>
                    </span>
                    {c.hint && <span className="mt-0.5 block pl-6 text-[11.5px] text-text-muted [overflow-wrap:anywhere]">{c.hint}</span>}
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
        {draft.constraints && (
          <>
            <dt className="uppercase tracking-[1.5px] text-[11px] text-text-muted">Constraints</dt>
            <dd className="text-text-primary [overflow-wrap:anywhere]">{draft.constraints}</dd>
          </>
        )}
        {draft.plan && (
          <>
            <dt className="uppercase tracking-[1.5px] text-[11px] text-text-muted">Plan</dt>
            <dd className="text-text-primary">{draft.plan}</dd>
          </>
        )}
      </dl>
    </>
  );
}

export default function ApprovalCard({ part }: { part: ChatToolPart }) {
  const actions = useChatActions();
  const [sent, setSent] = useState<'confirm' | 'deny' | null>(null);
  // Phone only (md: always open): the full draft outgrew the viewport.
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Admin writes: the target's name, typed, is the confirmation (checked on the server).
  const [typed, setTyped] = useState('');
  const draft = approvalDraft(part);
  const verb = approvalLabel(part);
  const wsName = draft.workspaceId ? actions.workspaceName(draft.workspaceId) : null;
  const approvalId = part.approval?.id ?? null;
  const approver = actions.viewerName ? `approved by ${actions.viewerName}` : 'approved';

  // Decided: the card is its row now; the object renders right after it.
  if (part.state === 'output-available' || part.state === 'output-error') {
    return <ToolCallRow view={toolRowView(part)} label={verb} note={approver} square />;
  }
  if (part.state === 'output-denied' || (part.state === 'approval-responded' && part.approval?.approved === false)) {
    return (
      <div data-testid="approval-card" data-state="denied" className="border border-[var(--chat-rule)] bg-[var(--chat-surface)] px-3.5 py-2 font-mono text-[12.5px] text-[var(--chat-muted)]">
        <span className="font-semibold text-[var(--chat-text)]">{verb}</span>
        {draft.kind === 'preview' ? ' · discarded · nothing changed' : ' · discarded · nothing filed'}
      </div>
    );
  }

  const deciding = part.state === 'approval-responded' || sent !== null;
  const isMission = draft.kind === 'mission';
  const confirmLabel = isMission ? 'Confirm & file' : 'Confirm';
  const isChange = draft.kind === 'preview';
  const confirmText = draft.kind === 'preview' ? draft.confirmText : null;
  const typedOk = !confirmText || typed.trim() === confirmText.trim();

  return (
    <section
      data-testid="approval-card"
      data-state={deciding ? 'deciding' : 'awaiting'}
      data-approval-id={approvalId ?? undefined}
      className="border border-t-2 border-[var(--chat-rule-strong)] border-t-[var(--mood-needs)] bg-[var(--chat-surface)] shadow-[3px_3px_0_0_var(--chat-rule)]"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-[var(--chat-rule)] px-4 py-2.5 md:px-5 md:py-3">
        <span data-testid="approval-eyebrow" className="flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[.16em] text-[var(--mood-needs)]">
          <span aria-hidden="true" className="h-2 w-2 bg-[var(--mood-needs)]" />{deciding ? 'Confirmed' : 'Needs your OK'}
        </span>
        <span className="font-mono text-[12px] font-semibold uppercase tracking-[.12em] text-[var(--chat-text)]">{verb}</span>
        {deciding && (
          <span className="hidden font-mono text-[11px] text-[var(--chat-muted)] md:inline">
            {sent === 'deny' ? 'discarding…' : isChange ? 'applying…' : 'filing…'}
          </span>
        )}
        {wsName && <span className="ml-auto font-mono text-[12px] text-[var(--chat-muted)]">{wsName}</span>}
      </header>
      <div className="px-4 py-3 md:px-5 md:py-4">
        <DraftSummary draft={draft} />
        {hasDetails(draft) && (
          <>
            <button
              type="button"
              data-testid="approval-details-toggle"
              aria-expanded={detailsOpen}
              aria-controls={approvalId ? `approval-details-${approvalId}` : undefined}
              onClick={() => setDetailsOpen(o => !o)}
              className={`${draft.kind === 'generic' ? '' : 'mt-2 '}flex min-h-9 w-full items-center gap-2 font-mono text-[12px] text-text-secondary hover:text-text-primary md:hidden`}
            >
              <span aria-hidden="true">{detailsOpen ? '▾' : '▸'}</span>
              <span className="shrink-0 whitespace-nowrap font-semibold">{detailsOpen ? 'Hide details' : 'Show details'}</span>
              <span className="min-w-0 truncate text-text-muted">{detailsSummary(draft)}</span>
            </button>
            <div
              id={approvalId ? `approval-details-${approvalId}` : undefined}
              data-testid="approval-details"
              className={`${detailsOpen ? '' : 'hidden '}md:block`}
            >
              <DraftDetails draft={draft} />
            </div>
          </>
        )}
        {confirmText && (
          <label className="mt-3 grid gap-1 font-mono text-[12px] text-text-secondary">
            <span>Type <span className="font-semibold text-text-primary">{confirmText}</span> to confirm</span>
            <input
              data-testid="approval-typed-confirm"
              value={typed}
              onChange={e => setTyped(e.target.value)}
              disabled={deciding}
              autoComplete="off"
              className="min-h-10 border-2 border-border-strong bg-surface-1 px-2.5 text-[13px] text-text-primary"
            />
          </label>
        )}
      </div>
      <footer className="flex flex-nowrap items-center gap-2 px-4 pb-4 pt-1 md:gap-2.5 md:px-5">
        <button
          type="button"
          data-testid="approval-confirm"
          disabled={deciding || !approvalId || !typedOk}
          onClick={() => { if (!approvalId) return; setSent('confirm'); actions.respondToApproval(approvalId, true, confirmText ? typed.trim() : undefined); }}
          className="min-h-11 shrink-0 whitespace-nowrap border-2 border-[var(--on-accent)] bg-accent px-4 md:px-5 font-convo text-[14px] font-semibold text-[var(--on-accent)] hover:bg-primary-hover disabled:opacity-60"
        >
          {sent === 'confirm' ? (isChange ? 'Applying…' : 'Filing…') : confirmLabel}
        </button>
        <button
          type="button"
          data-testid="approval-edit"
          disabled={deciding}
          onClick={() => actions.prefillComposer(isMission ? `Change the draft "${(draft as { title: string }).title}": ` : 'Change it: ')}
          className="min-h-11 shrink-0 border-[1.5px] border-border-strong bg-transparent px-3.5 md:px-4 font-convo text-[14px] font-medium text-text-primary hover:bg-surface-3 disabled:opacity-60"
        >
          Edit
        </button>
        <button
          type="button"
          data-testid="approval-deny"
          disabled={deciding || !approvalId}
          onClick={() => { if (!approvalId) return; setSent('deny'); actions.respondToApproval(approvalId, false, 'Discarded by the user'); }}
          className="min-h-11 shrink-0 px-2 md:px-3 font-convo text-[14px] font-medium text-text-secondary hover:text-text-primary disabled:opacity-60"
        >
          Discard
        </button>
      </footer>
    </section>
  );
}
