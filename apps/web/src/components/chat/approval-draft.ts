/**
 * What an approval card shows for a proposed write. Pure: reads the tool input
 * the model proposed and never invents a field the input doesn't carry.
 *
 * The preview and field drafts, and the label lookup, are the kit's
 * (`approvalDraft` / `approvalLabel` from @builddai/ai-kit/chat/react). buildd
 * adds one richer draft through the kit's `custom` hook, a new mission with
 * its goal, done-when criteria, constraints and plan, and its own words for
 * each write (LABELS).
 */
import type { GoalCriterion } from '@buildd/shared';
import {
  approvalDraft as kitApprovalDraft,
  approvalLabel as kitApprovalLabel,
  firstParagraph,
  toolAction,
  toolInput,
  type ApprovalDraft as KitApprovalDraft,
} from '@builddai/ai-kit/chat/react';
import { criterionLabel } from '@/lib/goal-criterion-label';
import { toolNameOf, type ChatToolPart } from './chat-contract';

export { firstParagraph };
export type { GenericDraft, PreviewDraft } from '@builddai/ai-kit/chat/react';

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

export type ApprovalDraft = KitApprovalDraft<MissionDraft>;

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

/** Lines under a "Constraints" heading in the description, if the model wrote one. */
function constraintsFrom(md: string | null): string | null {
  if (!md) return null;
  const m = /(?:^|\n)\s*(?:#+\s*)?constraints\s*:?\s*\n?([\s\S]*?)(?:\n\s*\n|$)/i.exec(md);
  if (!m) return null;
  const text = m[1].replace(/^\s*[-*]\s+/gm, '').replace(/\s+/g, ' ').trim();
  return text || null;
}

/** A new mission's draft, or null for every other write. */
function missionDraft(part: ChatToolPart): MissionDraft | null {
  if (toolNameOf(part) !== 'manage_missions' || toolAction(part) !== 'create') return null;
  const input = toolInput(part);
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
    workspaceId: str(input.workspaceId),
  };
}

/** A new mission's draft, else the server's preview, else the input's fields. */
export function approvalDraft(part: ChatToolPart): ApprovalDraft {
  return kitApprovalDraft(part, { custom: missionDraft });
}

/** Each write, in words. Keyed `tool` or `tool:action`. */
const LABELS: Record<string, string> = {
  'manage_missions:create': 'New mission',
  'manage_missions:update': 'Change mission',
  'manage_missions:arm': 'Start mission',
  'manage_missions:link_task': 'Add task to mission',
  'manage_missions:unlink_task': 'Remove task from mission',
  'manage_missions:evaluate': 'Check mission',
  'manage_missions:delete': 'Delete mission',
  'manage_initiatives:create': 'New initiative',
  'manage_initiatives:update': 'Change initiative',
  'manage_initiatives:link_mission': 'Add mission to initiative',
  'manage_initiatives:unlink_mission': 'Remove mission from initiative',
  'manage_initiatives:delete': 'Delete initiative',
  'manage_workspaces:create': 'New workspace',
  'manage_workspaces:update': 'Change workspace',
  'manage_workspaces:create_repo': 'New repository',
  'manage_workspaces:init': 'Set up workspace',
  create_task: 'New task',
  update_task: 'Change task',
  hold_task: 'Hold task',
  correct_task_result: 'Correct task result',
  approve_plan: 'Approve plan',
  reject_plan: 'Reject plan',
  send_agent_message: 'Message agent',
  answer_question: 'Answer agent',
  create_schedule: 'New schedule',
  update_schedule: 'Change schedule',
  pause_schedules: 'Pause schedules',
  delete_schedule: 'Delete schedule',
  create_artifact: 'New artifact',
  trigger_release: 'Start release',
  memory_delete: 'Delete memory',
  watch: 'Tell me when',
  unwatch: 'Stop watching',
};

/** "New mission": what the card is, never the tool it runs through. */
export function approvalLabel(part: ChatToolPart): string {
  return kitApprovalLabel(part, LABELS);
}
