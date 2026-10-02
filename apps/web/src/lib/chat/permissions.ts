/**
 * Per-person tool permissions for chat (knowledge-base: buildd/design/agent-chat.md → Tools and
 * permissions → "Allow" for a tool group).
 *
 * Every write gets an approval card by default. A person may set a tool group
 * to "Allow", and then a write in that group runs without its card, for that
 * person only, when all of these hold:
 *
 *  - the call's effective class is `write`. Admin-class calls (deletes, budget
 *    changes, workspace config) always ask, and never-in-chat actions are not
 *    tools at all. A mission or task write carrying a field that shapes spend
 *    or run state (SKIPPABLE_FIELDS) asks too, and so does anything that
 *    starts recurring or unattended work (`startsUnattendedWork`: schedules,
 *    arming a mission, resuming paused schedules or a held task);
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
 *
 * The groups are a kit `defineToolGroups` declaration
 * (`@builddai/ai-kit/chat/server`) built from buildd's registry: one
 * declaration drives the menu rows, the stored preference and the skip rule
 * (the kit's `skipCardVerdict`, with its taint checks), so every app on the kit
 * enforces Allow exactly as buildd does. What stays buildd's are the per-tool
 * hooks it carries: the effective class (a budget field makes a mission write
 * admin), `startsUnattendedWork` and SKIPPABLE_FIELDS.
 */

import type { ChatToolPermissionRow } from '@buildd/shared';
import { defineToolGroups, type KitToolDecl, type ToolCallClass, type ToolGroupDecl } from '@builddai/ai-kit/chat/server';
import { effectiveClass, startsUnattendedWork } from './tools';
import { ALL_CHAT_TOOL_SPECS, isExposed, NOT_IN_CHAT, opSpec, opsOf, TOOL_GROUPS, type ChatToolSpec, type ToolGroup } from './registry';

export const TOOL_GROUP_LABELS: Record<ToolGroup, string> = {
  missions: 'Missions',
  tasks: 'Tasks',
  workers: 'Agents',
  prs: 'PRs',
  memory: 'Knowledge',
  schedules: 'Schedules',
  artifacts: 'Artifacts',
  notifications: 'Watches',
  admin: 'Admin',
};

/**
 * Fields a skipped card may carry, for tools whose schema passes extra fields
 * through (`catchall`). Anything else (concurrency, model, schedule, pacing,
 * start, status, orchestration…) changes what the team spends or what runs, so
 * it gets a card like a budget change does. An allowlist, so a field added to
 * the tool later asks until someone decides it is safe.
 */
const SKIPPABLE_FIELDS: Record<string, readonly string[]> = {
  manage_missions: [
    'action', 'missionId', 'workspaceId', 'title', 'description',
    'goalCriteria', 'addGoalCriteria', 'removeGoalCriteria', 'priority',
  ],
  create_task: [
    'title', 'description', 'missionId', 'dependsOn', 'baseBranch', 'pathManifest',
    'workspaceId', 'priority', 'roleSlug', 'kind', 'label', 'outputRequirement',
  ],
};

/**
 * The declared base class. Only the kit's startup validation reads it (a
 * toggleable group needs a write, a read-only group holds none); every call is
 * judged by its own op's class through `effectiveClass`.
 */
function baseClass(spec: ChatToolSpec): ToolCallClass {
  const classes = opsOf(spec).map(([, o]) => o.class);
  if (classes.includes('write')) return 'write';
  return classes.every(c => c === 'read') ? 'read' : 'admin';
}

/**
 * One tool, with buildd's per-call hooks. The class is the op's own (`self`
 * and `deferred` included, and neither ever skips); an unknown op resolves to
 * no class, which the kit treats as an unknown tool. A tool whose every op is
 * deferred is declared `deferred`: in its group's row, never registered with
 * the model.
 */
function toolDecl(name: string, spec: ChatToolSpec): KitToolDecl {
  return {
    name,
    class: baseClass(spec),
    ...(isExposed(spec) ? {} : { deferred: true }),
    effectiveClass: (input) => {
      const s = opSpec(name, input);
      return s ? effectiveClass(name, s.op, s.spec, input) : undefined;
    },
    startsUnattendedWork: (input) => {
      const s = opSpec(name, input);
      return !!s && startsUnattendedWork(name, s.spec, input);
    },
    ...(SKIPPABLE_FIELDS[name] ? { skippableFields: SKIPPABLE_FIELDS[name] } : {}),
  };
}

function groupDecl(group: ToolGroup): ToolGroupDecl {
  const tools = Object.entries(ALL_CHAT_TOOL_SPECS)
    .filter(([, spec]) => spec.group === group)
    .map(([name, spec]) => toolDecl(name, spec));
  const label = TOOL_GROUP_LABELS[group];
  // The group's mode comes from what chat registers: a deferred-only tool is
  // declared (the kit keeps it off the model) but is not a tool yet.
  const live = tools.filter(t => !t.deferred);
  // Admin-class calls (deletes, budgets, workspace config) always ask.
  if (group === 'admin') return { label, tools, fixed: 'ask' };
  if (live.some(t => t.class === 'write')) return { label, tools, modes: ['ask', 'allow'] };
  return { label, tools, fixed: live.every(t => t.class === 'read') ? 'read' : 'ask' };
}

/**
 * buildd's tool groups, in menu order. Secrets are a locked "Never" row: chat
 * never offers them as a tool at all (NOT_IN_CHAT).
 */
export const CHAT_TOOL_GROUPS = defineToolGroups({
  ...Object.fromEntries(TOOL_GROUPS.map(g => [g, groupDecl(g)])) as Record<ToolGroup, ToolGroupDecl>,
  ...(Object.values(NOT_IN_CHAT).some(n => n.reason === 'secret') ? { secrets: { label: 'Secrets', fixed: 'never' as const } } : {}),
});

/** Groups with at least one card-gated write chat offers. Admin never qualifies. */
export const ALLOWABLE_GROUPS = CHAT_TOOL_GROUPS.allowable as readonly ToolGroup[];

/** A stored or requested list → the groups that may be allowed. Drops anything else. */
export function parseAllowedGroups(raw: unknown): ReadonlySet<ToolGroup> {
  return CHAT_TOOL_GROUPS.parseAllowed(raw) as ReadonlySet<ToolGroup>;
}

export function isAllowableGroup(g: unknown): g is ToolGroup {
  return typeof g === 'string' && (ALLOWABLE_GROUPS as readonly string[]).includes(g);
}

/** The rows the composer's tools menu shows. */
export function toolPermissionRows(allowed: ReadonlySet<ToolGroup>): ChatToolPermissionRow[] {
  return CHAT_TOOL_GROUPS.rows(allowed);
}

/** Is anything a tool returned in the messages the model is reading? (the kit's taint check) */
export { contentInContext, toolOutputInHistory } from '@builddai/ai-kit/chat/server';

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
  return CHAT_TOOL_GROUPS.canSkipCard({
    ...args,
    // turn.ts allows one skipped write per turn and checks that itself
    // (allowedThisTurn) before calling here.
    skippedThisTurn: 0,
  });
}
