/**
 * Pure model for the directive card (DirectiveCard.tsx): which parts are
 * cards, the scope options, what a save sends, and the copy for each state.
 */
import {
  CHAT_DIRECTIVE_PART_TYPE,
  type ChatDirectiveCandidateData,
  type ChatDirectiveScope,
  type CreateChatDirectiveRequest,
} from '@buildd/shared';

type AnyPart = { type: string };

function isCandidate(d: unknown): d is ChatDirectiveCandidateData {
  if (!d || typeof d !== 'object') return false;
  const r = d as Record<string, unknown>;
  return typeof r.text === 'string' && r.text.trim() !== '' && typeof r.conversationId === 'string'
    && (r.suggestedScope === 'everywhere' || r.suggestedScope === 'workspace');
}

/** The directive cards on a message, in order. Malformed parts are skipped. */
export function directiveCandidates(parts: readonly AnyPart[]): ChatDirectiveCandidateData[] {
  return parts.flatMap(p => {
    const data = (p as { data?: unknown }).data;
    return p.type === CHAT_DIRECTIVE_PART_TYPE && isCandidate(data) ? [data] : [];
  });
}

export interface ScopeOption { value: ChatDirectiveScope; label: string }

/** "Everywhere", plus "Only <workspace>" when the turn had one. */
export function scopeOptions(d: ChatDirectiveCandidateData): ScopeOption[] {
  const out: ScopeOption[] = [{ value: 'everywhere', label: 'Everywhere' }];
  if (d.workspace) out.push({ value: 'workspace', label: `Only ${d.workspace.name}` });
  return out;
}

/** The preselected scope: Jev's suggestion when there is a workspace to scope to, else everywhere. */
export function initialScope(d: ChatDirectiveCandidateData): ChatDirectiveScope {
  return d.workspace && d.suggestedScope === 'workspace' ? 'workspace' : 'everywhere';
}

export function saveRequest(d: ChatDirectiveCandidateData, scope: ChatDirectiveScope, messageId: string): CreateChatDirectiveRequest {
  return {
    text: d.text,
    workspaceId: scope === 'workspace' && d.workspace ? d.workspace.id : null,
    from: { conversationId: d.conversationId, messageId },
  };
}

/** The line a saved card folds to. */
export function savedLine(d: ChatDirectiveCandidateData, scope: ChatDirectiveScope): string {
  return scope === 'workspace' && d.workspace
    ? `Saved. Applies only in ${d.workspace.name}.`
    : 'Saved. Applies in every chat.';
}

export const STANDING_RULES_HREF = '/app/settings/account#standing-rules';
