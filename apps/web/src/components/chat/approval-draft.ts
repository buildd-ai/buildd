/**
 * What an approval card shows for a proposed write. Pure: reads the tool input
 * the model proposed and never invents a field the input doesn't carry.
 */
import type { GoalCriterion } from '@buildd/shared';
import { criterionLabel } from '@/lib/goal-criterion-label';
import { toolNameOf, type ChatToolPart } from './chat-contract';
import { toolAction } from './feed-model';

export interface DraftCriterion {
  label: string;
  /** The mechanical detail under the label: the command, the artifact key. */
  hint: string | null;
}

export interface MissionDraft {
  kind: 'mission';
  title: string;
  goal: string | null;
  criteria: DraftCriterion[];
  /** Plain lines under CONSTRAINTS, when the draft lists any. */
  constraints: string | null;
  /** "Plan first · starts now", "held until you arm it" … */
  plan: string | null;
  workspaceId: string | null;
}

export interface GenericDraft {
  kind: 'generic';
  fields: Array<{ key: string; value: string }>;
  workspaceId: string | null;
}

export type ApprovalDraft = MissionDraft | GenericDraft;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function criterionHint(c: GoalCriterion): string | null {
  switch (c.type) {
    case 'command':
      return c.label ? c.command : null;
    case 'artifact_exists':
      return c.key ? `artifact · ${c.key}` : c.artifactType ? `artifact · ${c.artifactType}` : null;
    default:
      return null;
  }
}

function isCriterion(v: unknown): v is GoalCriterion {
  return !!v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string';
}

function missionPlan(input: Record<string, unknown>): string | null {
  const bits: string[] = [];
  if (input.orchestrationMode === 'manual') bits.push('Manual: you add the tasks');
  else bits.push('Plan first');
  if (input.startMode === 'held') bits.push('held until you arm it');
  else if (str(input.startIn)) bits.push(`starts in ${str(input.startIn)}`);
  else if (str(input.startAt)) bits.push('starts later');
  else bits.push('starts now');
  bits.push(str(input.cronExpression) ? `schedule ${str(input.cronExpression)}` : 'no schedule');
  return bits.join(' · ');
}

/** First paragraph of a markdown description as plain text. */
export function firstParagraph(md: string | null): string | null {
  if (!md) return null;
  const p = md.split(/\n\s*\n/)[0].replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim();
  return p || null;
}

/** Lines under a "Constraints" heading in the description, if the model wrote one. */
function constraintsFrom(md: string | null): string | null {
  if (!md) return null;
  const m = /(?:^|\n)\s*(?:#+\s*)?constraints\s*:?\s*\n?([\s\S]*?)(?:\n\s*\n|$)/i.exec(md);
  if (!m) return null;
  const text = m[1].replace(/^\s*[-*]\s+/gm, '').replace(/\s+/g, ' ').trim();
  return text || null;
}

export function approvalDraft(part: ChatToolPart): ApprovalDraft {
  const input = (part.input && typeof part.input === 'object' ? part.input : {}) as Record<string, unknown>;
  const workspaceId = str(input.workspaceId);
  if (toolNameOf(part) === 'manage_missions' && toolAction(part) === 'create') {
    const description = str(input.description);
    const criteria = Array.isArray(input.goalCriteria)
      ? input.goalCriteria.filter(isCriterion).map(c => ({ label: criterionLabel(c), hint: criterionHint(c) }))
      : [];
    return {
      kind: 'mission',
      title: str(input.title) ?? 'Untitled mission',
      goal: firstParagraph(description),
      criteria,
      constraints: constraintsFrom(description),
      plan: missionPlan(input),
      workspaceId,
    };
  }
  const fields = Object.entries(input)
    .filter(([k]) => k !== 'action' && k !== 'workspaceId')
    .map(([key, v]) => ({ key, value: typeof v === 'string' ? v : JSON.stringify(v) }))
    .filter(f => f.value && f.value !== 'null');
  return { kind: 'generic', fields, workspaceId };
}

/** `manage_missions · create` — the tool as the card's verb. */
export function approvalVerb(part: ChatToolPart): string {
  const a = toolAction(part);
  return a ? `${toolNameOf(part)} · ${a}` : toolNameOf(part);
}
