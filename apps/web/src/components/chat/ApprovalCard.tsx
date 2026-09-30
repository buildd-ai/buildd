'use client';

/**
 * A write the agent proposed, as the approval card itself (docs/design/agent-chat.md,
 * "Tool calls you can see"). Nothing is filed until Confirm, which echoes the
 * approval id back; the server checks the id, the input hash and the approver.
 * Once decided the card folds to its tool row, and the filed object renders
 * live right under it.
 *
 * Every card is the kit's (`ApprovalCard` from @builddai/ai-kit/chat/react),
 * themed in globals.css ("Chat on the kit"): a change to an existing object
 * (the server's before → after preview, an admin write's typed confirmation),
 * any other write, and a new mission, whose draft (goal, done-when criteria,
 * constraints, plan) buildd renders into the kit card's body and details. On
 * a phone the details fold behind "Show details".
 *
 * An approval is a fleet object in the v3 language (docs/design/chat-canvas.md,
 * "Mobile canvas"): a square card with a 1px rule and a 3px offset shadow, a
 * 2px copper top edge for "needs you", mono chrome, and what changes said in
 * Newsreader. Plain buttons. No keycaps: nothing here has a key.
 */
import { useState, type ReactNode } from 'react';
import { ApprovalCard as KitApprovalCard, ToolCallRow } from '@builddai/ai-kit/chat/react';
import { isSystemDenied } from '@builddai/ai-kit/chat/contract';
import type { ChatToolPart } from './chat-contract';
import { useChatActions } from './ChatActions';
import { approvalDraft, approvalLabel, type ApprovalDraft, type MissionDraft } from './approval-draft';
import { toolRowView } from './feed-model';

/** "4 criteria · constraints · plan": what the folded details hold. */
export function detailsSummary(draft: MissionDraft): string {
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
    <dl className="md:mt-1.5 grid grid-cols-1 md:grid-cols-[130px_1fr] gap-x-4 gap-y-2.5 font-mono text-[12.5px]">
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
 * The part as the kit's card should read its raw fields: a write without a
 * preview shows the draft's fields (never the action or a workspace id).
 */
export function kitApprovalPart(part: ChatToolPart, draft: Exclude<ApprovalDraft, MissionDraft>): ChatToolPart {
  if (draft.kind === 'preview') return part;
  return { ...part, input: Object.fromEntries(draft.fields.map(f => [f.key, f.value])) };
}

export default function ApprovalCard({ part }: { part: ChatToolPart }) {
  const actions = useChatActions();
  const [answered, setAnswered] = useState(false);
  const draft = approvalDraft(part);
  const verb = approvalLabel(part);
  const wsName = draft.workspaceId ? actions.workspaceName(draft.workspaceId) : null;
  const approver = actions.viewerName ? `approved by ${actions.viewerName}` : 'approved';

  // Every state shares one wrapper, so a decided card folds to its row in
  // place (same node, nothing removed and re-inserted), and the feed can find
  // the reply that follows it by the approval id (ChatWorkspace's anchor).
  const wrap = (state: string, kind: string | undefined, children: ReactNode) => (
    <div data-testid="approval-card" data-state={state} data-approval-id={part.approval?.id ?? undefined} data-kind={kind}>{children}</div>
  );

  // Decided: the card is its row now (buildd's feed row, like every other
  // tool call); the object renders right after it.
  if (part.state === 'output-available' || part.state === 'output-error') {
    return wrap('done', undefined, <ToolCallRow view={toolRowView(part)} label={verb} note={approver} />);
  }

  const denied = part.state === 'output-denied' || (part.state === 'approval-responded' && part.approval?.approved === false);
  const deciding = part.state === 'approval-responded' || answered;
  const onRespond = (id: string, approved: boolean, reason?: string) => { setAnswered(true); actions.respondToApproval(id, approved, reason); };
  const shared = {
    className: 'buildd-approval',
    onRespond,
    eyebrow: verb,
    meta: wsName ? <span data-testid="approval-workspace">{wsName}</span> : undefined,
    settled: 'row' as const,
  };

  // Refused before any card was shown (one card per turn): the kit's "not
  // proposed" row. Never "discarded": nobody saw it.
  if (isSystemDenied(part)) {
    return wrap('skipped', undefined, <KitApprovalCard {...shared} part={part} headline={verb} />);
  }
  // Discarded: one row, headed by what the write was.
  if (denied) {
    return wrap('denied', undefined, <KitApprovalCard {...shared} part={part} headline={verb} deniedNote={draft.kind === 'preview' ? 'nothing changed' : 'nothing filed'} />);
  }
  const state = deciding ? 'deciding' : 'awaiting';

  if (draft.kind === 'mission') {
    return wrap(state, 'mission', (
      <KitApprovalCard
        {...shared}
        part={part}
        headline={draft.title}
        body={draft.goal ? <p className="line-clamp-2 md:line-clamp-none font-convo text-[14.5px] md:text-[15px] leading-relaxed text-text-secondary">{draft.goal}</p> : undefined}
        details={hasDetails(draft) ? <MissionDetails draft={draft} /> : undefined}
        fold={hasDetails(draft) ? { summary: detailsSummary(draft) } : undefined}
        confirmLabel="Confirm & file"
        busyLabel="Filing…"
        onEdit={() => actions.prefillComposer(`Change the draft "${draft.title}": `)}
      />
    ));
  }
  return wrap(state, draft.kind, (
    <KitApprovalCard
      {...shared}
      part={kitApprovalPart(part, draft)}
      // A preview carries its own headline; any other write is headed by what
      // it is in words ("New initiative"), never the tool it runs through.
      headline={draft.kind === 'preview' ? undefined : verb}
      fold
      onEdit={() => actions.prefillComposer('Change it: ')}
    />
  ));
}
