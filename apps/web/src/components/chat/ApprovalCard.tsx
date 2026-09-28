'use client';

/**
 * A write the agent proposed, as the approval card itself (docs/design/agent-chat.md,
 * "Tool calls you can see"). Nothing is filed until Confirm, which echoes the
 * approval id back; the server checks the id, the input hash and the approver.
 * Once decided the card folds to its tool row, and the filed object renders
 * live right under it.
 *
 * A change to an existing object (the server's before → after preview, an
 * admin write's typed confirmation) and any other write are the kit's card
 * (`ApprovalCard` from @builddai/ai-kit/chat/react), themed in globals.css
 * ("Chat on the kit"). A new mission stays buildd's own card below: the kit's
 * card has no slot for a draft's goal, its done-when criteria, constraints and
 * plan, or a phone fold for them, and no "Confirm & file" label.
 *
 * An approval is a fleet object in the v3 language (docs/design/chat-canvas.md,
 * "Mobile canvas"): a square card with a 1px rule and a 3px offset shadow, a
 * 2px copper top edge for "needs you", mono chrome, and what changes said in
 * Newsreader. Plain buttons. No keycaps: nothing here has a key.
 */
import { useState, type CSSProperties } from 'react';
import { ApprovalCard as KitApprovalCard } from '@builddai/ai-kit/chat/react';
import type { ChatToolPart } from './chat-contract';
import { useChatActions } from './ChatActions';
import { approvalDraft, approvalLabel, type ApprovalDraft, type MissionDraft } from './approval-draft';
import { toolRowView } from './feed-model';
import { ToolCallRow } from './ToolCallRows';

/** "4 criteria · constraints · plan": what the folded details hold. */
function detailsSummary(draft: MissionDraft): string {
  const bits: string[] = [];
  if (draft.criteria.length) bits.push(`${draft.criteria.length} criteri${draft.criteria.length === 1 ? 'on' : 'a'}`);
  if (draft.constraints) bits.push('constraints');
  if (draft.plan) bits.push('plan');
  return bits.join(' · ');
}

function hasDetails(draft: MissionDraft): boolean {
  return draft.criteria.length > 0 || !!draft.constraints || !!draft.plan;
}

function MissionDetails({ draft }: { draft: MissionDraft }) {
  return (
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
  );
}

/**
 * The part as the kit's card should read it. A preview carries its own
 * headline; any other write is headed by what it is in words ("New
 * initiative", never the tool it runs through) and shows the draft's fields,
 * not the raw input (no action, no workspace id).
 */
export function kitApprovalPart(part: ChatToolPart, draft: Exclude<ApprovalDraft, MissionDraft>, verb: string): ChatToolPart {
  if (draft.kind === 'preview') return part;
  return { ...part, type: `tool-${verb}`, input: Object.fromEntries(draft.fields.map(f => [f.key, f.value])) } as ChatToolPart;
}

/** A new mission: buildd's draft card (the kit's has no draft body). */
function MissionApprovalCard({ part, draft, verb, wsName }: { part: ChatToolPart; draft: MissionDraft; verb: string; wsName: string | null }) {
  const actions = useChatActions();
  const [sent, setSent] = useState<'confirm' | 'deny' | null>(null);
  // Phone only (md: always open): the full draft outgrew the viewport.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const approvalId = part.approval?.id ?? null;
  const deciding = part.state === 'approval-responded' || sent !== null;

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
            {sent === 'deny' ? 'discarding…' : 'filing…'}
          </span>
        )}
        {wsName && <span className="ml-auto font-mono text-[12px] text-[var(--chat-muted)]">{wsName}</span>}
      </header>
      <div className="px-4 py-3 md:px-5 md:py-4">
        <h3 data-testid="approval-draft-title" className="font-mono text-[17px] md:text-[20px] font-semibold leading-snug text-text-primary [overflow-wrap:anywhere]">
          {draft.title}
        </h3>
        {draft.goal && <p className="mt-1.5 line-clamp-2 md:line-clamp-none font-convo text-[14.5px] md:text-[15px] leading-relaxed text-text-secondary [overflow-wrap:anywhere]">{draft.goal}</p>}
        {hasDetails(draft) && (
          <>
            <button
              type="button"
              data-testid="approval-details-toggle"
              aria-expanded={detailsOpen}
              aria-controls={approvalId ? `approval-details-${approvalId}` : undefined}
              onClick={() => setDetailsOpen(o => !o)}
              className="mt-2 flex min-h-9 w-full items-center gap-2 font-mono text-[12px] text-text-secondary hover:text-text-primary md:hidden"
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
              <MissionDetails draft={draft} />
            </div>
          </>
        )}
      </div>
      <footer className="flex flex-nowrap items-center gap-2 px-4 pb-4 pt-1 md:gap-2.5 md:px-5">
        <button
          type="button"
          data-testid="approval-confirm"
          disabled={deciding || !approvalId}
          onClick={() => { if (!approvalId) return; setSent('confirm'); actions.respondToApproval(approvalId, true); }}
          className="min-h-11 shrink-0 whitespace-nowrap border-2 border-[var(--on-accent)] bg-accent px-4 md:px-5 font-convo text-[14px] font-semibold text-[var(--on-accent)] hover:bg-primary-hover disabled:opacity-60"
        >
          {sent === 'confirm' ? 'Filing…' : 'Confirm & file'}
        </button>
        <button
          type="button"
          data-testid="approval-edit"
          disabled={deciding}
          onClick={() => actions.prefillComposer(`Change the draft "${draft.title}": `)}
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

export default function ApprovalCard({ part }: { part: ChatToolPart }) {
  const actions = useChatActions();
  const [answered, setAnswered] = useState(false);
  const draft = approvalDraft(part);
  const verb = approvalLabel(part);
  const wsName = draft.workspaceId ? actions.workspaceName(draft.workspaceId) : null;
  const approver = actions.viewerName ? `approved by ${actions.viewerName}` : 'approved';

  // Decided: the card is its row now; the object renders right after it.
  if (part.state === 'output-available' || part.state === 'output-error') {
    return <ToolCallRow view={toolRowView(part)} label={verb} note={approver} />;
  }
  if (part.state === 'output-denied' || (part.state === 'approval-responded' && part.approval?.approved === false)) {
    return (
      <div data-testid="approval-card" data-state="denied" className="border border-[var(--chat-rule)] bg-[var(--chat-surface)] px-3.5 py-2 font-mono text-[12.5px] text-[var(--chat-muted)]">
        <span className="font-semibold text-[var(--chat-text)]">{verb}</span>
        {draft.kind === 'preview' ? ' · discarded · nothing changed' : ' · discarded · nothing filed'}
      </div>
    );
  }

  if (draft.kind === 'mission') return <MissionApprovalCard part={part} draft={draft} verb={verb} wsName={wsName} />;

  const deciding = part.state === 'approval-responded' || answered;
  // The kit's eyebrow takes no extra text, so what the write is ("TELL ME
  // WHEN") follows it as CSS content (globals.css, "Chat on the kit"); on a
  // phone the workspace joins it there, on wider screens it sits at the right.
  const tag = { '--buildd-approval-verb': cssString(verb), '--buildd-approval-tag': cssString(wsName ? `${verb} · ${wsName}` : verb) } as CSSProperties;
  return (
    <div
      data-testid="approval-card"
      data-state={deciding ? 'deciding' : 'awaiting'}
      data-approval-id={part.approval?.id ?? undefined}
      data-kind={draft.kind}
      data-ws={wsName ? '' : undefined}
      className="relative"
      style={tag}
    >
      <KitApprovalCard
        part={kitApprovalPart(part, draft, verb)}
        className="buildd-approval"
        onRespond={(id, approved, reason) => { setAnswered(true); actions.respondToApproval(id, approved, reason); }}
        onEdit={() => actions.prefillComposer('Change it: ')}
      />
      {wsName && (
        <span data-testid="approval-workspace" className="pointer-events-none absolute right-5 top-3 hidden max-w-[40%] truncate font-mono text-[12px] text-[var(--chat-muted)] md:block">{wsName}</span>
      )}
    </div>
  );
}

/** A CSS string literal, for `content: var(--…)`. */
export function cssString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`;
}
