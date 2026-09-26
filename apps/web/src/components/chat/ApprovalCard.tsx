'use client';

/**
 * A write the agent proposed, as the approval card itself (docs/design/agent-chat.md,
 * "Tool calls you can see"). Nothing is filed until Confirm, which echoes the
 * approval id back; the server checks the id, the input hash and the approver.
 * Once decided the card folds to its tool row, and the filed object renders
 * live right under it.
 */
import { useState } from 'react';
import type { ChatToolPart } from './chat-contract';
import { useChatActions } from './ChatActions';
import { approvalDraft, approvalVerb, type ApprovalDraft } from './approval-draft';
import { toolRowView } from './feed-model';
import { ToolCallRow } from './ToolCallRows';

function DraftBody({ draft }: { draft: ApprovalDraft }) {
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
      <h3 data-testid="approval-draft-title" className="font-mono text-[18px] md:text-[20px] font-semibold leading-snug text-text-primary [overflow-wrap:anywhere]">
        {draft.title}
      </h3>
      {draft.goal && <p className="mt-1.5 font-[family-name:var(--font-outfit)] text-[15px] leading-relaxed text-text-secondary [overflow-wrap:anywhere]">{draft.goal}</p>}
      <dl className="mt-4 grid grid-cols-1 md:grid-cols-[130px_1fr] gap-x-4 gap-y-2.5 font-mono text-[12.5px]">
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
  const draft = approvalDraft(part);
  const verb = approvalVerb(part);
  const wsName = draft.workspaceId ? actions.workspaceName(draft.workspaceId) : null;
  const approvalId = part.approval?.id ?? null;
  const approver = actions.viewerName ? `approved by ${actions.viewerName}` : 'approved';

  // Decided: the card is its row now; the object renders right after it.
  if (part.state === 'output-available' || part.state === 'output-error') {
    return <ToolCallRow view={toolRowView(part)} note={approver} />;
  }
  if (part.state === 'output-denied' || (part.state === 'approval-responded' && part.approval?.approved === false)) {
    return (
      <div data-testid="approval-card" data-state="denied" className="border-[1.5px] border-dashed border-border-default px-3 py-2 font-mono text-[12.5px] text-text-muted">
        <span className="font-semibold text-text-secondary">{verb}</span>
        {' · discarded · nothing filed'}
      </div>
    );
  }

  const deciding = part.state === 'approval-responded' || sent !== null;
  const isMission = draft.kind === 'mission';
  const confirmLabel = isMission ? 'Confirm & file' : 'Confirm';

  return (
    <section
      data-testid="approval-card"
      data-state={deciding ? 'deciding' : 'awaiting'}
      data-approval-id={approvalId ?? undefined}
      className="border-2 border-dashed border-accent bg-card shadow-[var(--accent-shadow)]"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border-default px-4 py-3 md:px-5">
        <span className="bg-accent px-2 py-0.5 font-mono text-[11px] font-bold uppercase tracking-[1.5px] text-[var(--on-accent)]">
          {deciding ? 'Confirmed' : 'Needs approval'}
        </span>
        <span className="font-mono text-[13px] font-semibold text-text-primary">{verb}</span>
        <span className="border-[1.5px] border-border-strong px-1.5 py-px font-mono text-[11px] text-text-secondary">
          {deciding ? (sent === 'deny' ? 'discarding…' : 'filing…') : 'not filed'}
        </span>
        {wsName && <span className="ml-auto font-mono text-[12px] text-text-muted">{wsName}</span>}
      </header>
      <div className="px-4 py-4 md:px-5">
        <DraftBody draft={draft} />
      </div>
      <footer className="flex flex-wrap items-center gap-2.5 border-t border-border-default px-4 py-3 md:px-5">
        <button
          type="button"
          data-testid="approval-confirm"
          disabled={deciding || !approvalId}
          onClick={() => { if (!approvalId) return; setSent('confirm'); actions.respondToApproval(approvalId, true); }}
          className="min-h-11 border-2 border-[var(--on-accent)] bg-accent px-5 font-mono text-[13.5px] font-semibold text-[var(--on-accent)] shadow-[3px_3px_0_0_var(--on-accent)] hover:bg-primary-hover disabled:opacity-60"
        >
          {sent === 'confirm' ? 'Filing…' : confirmLabel}
        </button>
        <button
          type="button"
          data-testid="approval-edit"
          disabled={deciding}
          onClick={() => actions.prefillComposer(isMission ? `Change the draft "${(draft as { title: string }).title}": ` : 'Change it: ')}
          className="min-h-11 border-2 border-border-strong bg-surface-3 px-4 font-mono text-[13.5px] font-medium text-text-primary hover:bg-surface-4 disabled:opacity-60"
        >
          Edit
        </button>
        <button
          type="button"
          data-testid="approval-deny"
          disabled={deciding || !approvalId}
          onClick={() => { if (!approvalId) return; setSent('deny'); actions.respondToApproval(approvalId, false, 'Discarded by the user'); }}
          className="min-h-11 px-3 font-mono text-[13.5px] font-medium text-text-secondary hover:text-text-primary disabled:opacity-60"
        >
          Discard
        </button>
        <span className="font-mono text-[11.5px] text-text-muted">{`files through ${verb.split(' · ')[0]}`}</span>
      </footer>
    </section>
  );
}
