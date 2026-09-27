/**
 * Per-person tool permissions for chat (docs/design/agent-chat.md → Tools and
 * permissions → "Allow" for a tool group).
 *
 * Every write gets an approval card by default. A person may set a tool group
 * to "Allow", and then a write in that group runs without its card, for that
 * person only, when all of these hold:
 *
 *  - the call's effective class is `write`. Admin-class calls (deletes, budget
 *    changes, workspace config) always ask, and never-in-chat actions are not
 *    tools at all. A mission or task write carrying a field that shapes spend
 *    or run state (SKIPPABLE_FIELDS) asks too;
 *  - nothing a tool returned is in the model's context: no tool result
 *    anywhere in the stored conversation (not only the window the model gets)
 *    or earlier in this turn, and no docked object (its task titles are
 *    in the instructions). Tool output is where injected instructions come from,
 *    so a write the model proposes after reading anything still gets a card;
 *  - the same server-side preview (target resolution, reach) a card would have
 *    built succeeds. The skip removes the tap, not the checks.
 *
 * Pure. The stored preference lives in `team_members.chat_allowed_tool_groups`
 * (permissions-store.ts).
 */

import type { ModelMessage } from 'ai';
import type { ChatToolPermissionRow } from '@buildd/shared';
import { effectiveClass } from './tools';
import { ALL_CHAT_TOOL_SPECS, NOT_IN_CHAT, opSpec, opsOf, TOOL_GROUPS, type ToolGroup } from './registry';

export const TOOL_GROUP_LABELS: Record<ToolGroup, string> = {
  missions: 'Missions',
  tasks: 'Tasks',
  workers: 'Agents',
  prs: 'PRs',
  memory: 'Knowledge',
  schedules: 'Schedules',
  artifacts: 'Artifacts',
  admin: 'Admin',
};

/** Groups with at least one card-gated write chat offers. Admin never qualifies. */
export const ALLOWABLE_GROUPS: readonly ToolGroup[] = TOOL_GROUPS.filter(g => g !== 'admin' && Object.values(ALL_CHAT_TOOL_SPECS)
  .some(spec => spec.group === g && opsOf(spec).some(([, o]) => o.class === 'write')));

const allowable = new Set<string>(ALLOWABLE_GROUPS);

/** A stored or requested list → the groups that may be allowed. Drops anything else. */
export function parseAllowedGroups(raw: unknown): ReadonlySet<ToolGroup> {
  const out = new Set<ToolGroup>();
  if (!Array.isArray(raw)) return out;
  for (const g of raw) if (typeof g === 'string' && allowable.has(g)) out.add(g as ToolGroup);
  return out;
}

export function isAllowableGroup(g: unknown): g is ToolGroup {
  return typeof g === 'string' && allowable.has(g);
}

/** The rows the composer's tools menu shows. */
export function toolPermissionRows(allowed: ReadonlySet<ToolGroup>): ChatToolPermissionRow[] {
  const rows: ChatToolPermissionRow[] = TOOL_GROUPS.map(g => {
    if (g === 'admin') return { key: g, label: TOOL_GROUP_LABELS[g], mode: 'ask', locked: true };
    if (!allowable.has(g)) return { key: g, label: TOOL_GROUP_LABELS[g], mode: 'read', locked: true };
    return { key: g, label: TOOL_GROUP_LABELS[g], mode: allowed.has(g) ? 'allow' : 'ask', locked: false };
  });
  if (Object.values(NOT_IN_CHAT).some(n => n.reason === 'secret')) {
    rows.push({ key: 'secrets', label: 'Secrets', mode: 'never', locked: true });
  }
  return rows;
}

/** Is anything a tool returned in the messages the model is reading? */
export function contentInContext(messages: readonly ModelMessage[]): boolean {
  return messages.some(m => m.role === 'tool'
    || (Array.isArray(m.content) && (m.content as Array<{ type?: string }>).some(p => p?.type === 'tool-result')));
}

/**
 * Fields a skipped card may carry, for tools whose schema passes extra fields
 * through (`catchall`). Anything else (concurrency, model, schedule, pacing,
 * start, status, orchestration…) changes what the team spends or what runs, so
 * it gets a card like a budget change does. An allowlist, so a field added to
 * the tool later asks until someone decides it is safe.
 */
const SKIPPABLE_FIELDS: Record<string, ReadonlySet<string>> = {
  manage_missions: new Set([
    'action', 'missionId', 'workspaceId', 'title', 'description',
    'goalCriteria', 'addGoalCriteria', 'removeGoalCriteria', 'priority',
  ]),
  create_task: new Set([
    'title', 'description', 'missionId', 'dependsOn', 'baseBranch', 'pathManifest',
    'workspaceId', 'priority', 'roleSlug', 'kind', 'label', 'outputRequirement',
  ]),
};

function onlySkippableFields(tool: string, input: unknown): boolean {
  const fields = SKIPPABLE_FIELDS[tool];
  if (!fields) return true;
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  return Object.keys(i).every(k => i[k] === undefined || fields.has(k));
}

/**
 * Did a tool ever return anything in this conversation? Sticky: once tool
 * output was read, later assistant text may repeat it after the tool part
 * itself has left the model's window. `truncated` (the load hit its limit, so
 * older rows are unseen) counts as yes.
 */
export function toolOutputInHistory(rows: ReadonlyArray<{ parts: ReadonlyArray<{ type?: string }> }>, truncated: boolean): boolean {
  if (truncated) return true;
  return rows.some(m => m.parts.some(p => typeof p?.type === 'string' && (p.type.startsWith('tool-') || p.type === 'dynamic-tool')));
}

/** May this call run without its card for this person? */
export function canSkipCard(args: {
  tool: string;
  input: unknown;
  allowedGroups: ReadonlySet<ToolGroup>;
  /** Tool output in the model's context (contentInContext). */
  tainted: boolean;
  /** An object is docked: its data is in the instructions. */
  docked: boolean;
}): boolean {
  if (args.tainted || args.docked || args.allowedGroups.size === 0) return false;
  const spec = ALL_CHAT_TOOL_SPECS[args.tool];
  const s = opSpec(args.tool, args.input);
  if (!spec || !s) return false;
  if (effectiveClass(args.tool, s.op, s.spec, args.input) !== 'write') return false;
  if (!onlySkippableFields(args.tool, args.input)) return false;
  return allowable.has(spec.group) && args.allowedGroups.has(spec.group);
}
