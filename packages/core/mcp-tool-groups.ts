/**
 * Where every `buildd` action lives: the one action → group registry that
 * both chat (apps/web/src/lib/chat/registry.ts) and the remote MCP server
 * (apps/web/src/app/api/mcp/tools.ts) read.
 *
 * - `ACTION_AREA` is the chat area of an action (chat's tool groups), or
 *   `work` for the worker-lifecycle actions chat never offers. Chat takes its
 *   groups from here.
 * - `mcpGroupOf` places each action in exactly one MCP group tool
 *   (`buildd_<group>`). It follows the area, except where MCP wants a
 *   different home (MCP_GROUP_OVERRIDES): artifacts a worker writes and its
 *   own events go with the rest of the worker lifecycle, and the knowledge
 *   maintenance actions (chat's `memory` area, which MCP serves through
 *   `recall` / `learn`) go to missions (spec drift) and admin.
 *
 * The MCP group tools carry short text: one line per action (a purpose and a
 * compact parameter signature). The long per-action documentation stays in
 * `buildParamsDescription` and is served on demand by the `help` action.
 */
import { allActions, buildParamsDescription, type BuilddAction } from './mcp-tools';

/** Chat's tool groups. `notifications` has chat-native tools only. */
export const CHAT_AREAS = ['missions', 'tasks', 'workers', 'prs', 'memory', 'schedules', 'artifacts', 'notifications', 'admin'] as const;
export type ChatArea = (typeof CHAT_AREAS)[number];
export type ActionArea = ChatArea | 'work';

/** The area of every MCP action. A Record over BuilddAction, so a new action fails to compile until it is placed. */
export const ACTION_AREA: Record<BuilddAction, ActionArea> = {
  // missions, initiatives, discrepancies
  manage_missions: 'missions',
  manage_initiatives: 'missions',
  link_tracker: 'missions',
  get_visual_review: 'missions',
  list_discrepancies: 'missions',
  get_discrepancy: 'missions',
  adjudicate_discrepancy: 'missions',
  promote_discrepancy: 'missions',
  // tasks
  list_tasks: 'tasks',
  get_task: 'tasks',
  get_task_messages: 'tasks',
  create_task: 'tasks',
  update_task: 'tasks',
  correct_task_result: 'tasks',
  approve_plan: 'tasks',
  reject_plan: 'tasks',
  // workers: steering and fleet health
  send_agent_message: 'workers',
  query_events: 'workers',
  explain: 'workers',
  get_error_traces: 'workers',
  get_failure_analytics: 'workers',
  get_budget_forecast: 'workers',
  get_usage_stats: 'workers',
  list_connectors: 'workers',
  list_runners: 'workers',
  // PRs, reviews, releases
  get_pr: 'prs',
  get_pr_review: 'prs',
  merge_pr: 'prs',
  close_pr: 'prs',
  request_pr_review: 'prs',
  list_releases: 'prs',
  get_release: 'prs',
  release_status: 'prs',
  // memory and knowledge
  spec_compare: 'memory',
  consolidate_knowledge: 'memory',
  memory_delete: 'memory',
  // schedules
  list_schedules: 'schedules',
  trace_schedule: 'schedules',
  create_schedule: 'schedules',
  update_schedule: 'schedules',
  pause_schedules: 'schedules',
  delete_schedule: 'schedules',
  // artifacts
  list_artifacts: 'artifacts',
  get_artifact: 'artifacts',
  list_artifact_templates: 'artifacts',
  create_artifact: 'artifacts',
  update_artifact: 'artifacts',
  // admin
  trigger_release: 'admin',
  manage_workspaces: 'admin',
  manage_watched_projects: 'admin',
  list_skills: 'admin',
  get_skill: 'admin',
  register_skill: 'admin',
  update_skill: 'admin',
  delete_skill: 'admin',
  manage_experiments: 'admin',
  manage_model_tiers: 'admin',
  manage_secrets: 'admin',
  // a worker's own lifecycle: never a chat tool
  claim_task: 'work',
  update_progress: 'work',
  complete_task: 'work',
  create_pr: 'work',
  emit_event: 'work',
  upload_artifact: 'work',
  record_pr_supersession: 'work',
  post_note: 'work',
  suggest_schedule_update: 'work',
};

export const MCP_TOOL_GROUPS = ['missions', 'tasks', 'work', 'prs', 'runners', 'artifacts', 'schedules', 'admin'] as const;
export type McpToolGroup = (typeof MCP_TOOL_GROUPS)[number];

const AREA_TO_MCP_GROUP: Record<ActionArea, McpToolGroup | null> = {
  missions: 'missions',
  tasks: 'tasks',
  workers: 'runners',
  prs: 'prs',
  schedules: 'schedules',
  artifacts: 'artifacts',
  admin: 'admin',
  work: 'work',
  memory: null,
  notifications: null,
};

/** MCP homes that differ from the chat area. */
const MCP_GROUP_OVERRIDES: Partial<Record<BuilddAction, McpToolGroup>> = {
  create_artifact: 'work',
  query_events: 'work',
  spec_compare: 'missions',
  consolidate_knowledge: 'admin',
  memory_delete: 'admin',
};

/** The MCP group an action is served by, or null for an unknown action. */
export function mcpGroupOf(action: string): McpToolGroup | null {
  if (!(action in ACTION_AREA)) return null;
  const a = action as BuilddAction;
  return MCP_GROUP_OVERRIDES[a] ?? AREA_TO_MCP_GROUP[ACTION_AREA[a]];
}

export const mcpGroupToolName = (group: McpToolGroup): string => `buildd_${group}`;

/** The group behind a `buildd_<group>` tool name, or null. */
export function mcpGroupOfToolName(name: string): McpToolGroup | null {
  const g = name.startsWith('buildd_') ? name.slice('buildd_'.length) : '';
  return (MCP_TOOL_GROUPS as readonly string[]).includes(g) ? (g as McpToolGroup) : null;
}

/** Every action of a group, in `allActions` order. */
export function actionsOfGroup(group: McpToolGroup): BuilddAction[] {
  return allActions.filter(a => mcpGroupOf(a) === group);
}

/**
 * What each group tool is for: the first line of its description, built from
 * fragments tagged with the actions they describe. A level that reaches only
 * part of a group sees only the fragments it can act on, so the purpose never
 * advertises an action the caller cannot call.
 */
export const MCP_GROUP_PURPOSE_PARTS: Record<McpToolGroup, { lead?: string; parts: { text: string; actions: BuilddAction[] }[] }> = {
  missions: {
    parts: [
      { text: 'missions (goals with completion criteria that group tasks)', actions: ['manage_missions', 'link_tracker'] },
      { text: 'initiatives', actions: ['manage_initiatives'] },
      { text: 'visual review', actions: ['get_visual_review'] },
      { text: 'the spec discrepancy ledger', actions: ['list_discrepancies', 'get_discrepancy', 'adjudicate_discrepancy', 'promote_discrepancy', 'spec_compare'] },
    ],
  },
  tasks: {
    parts: [
      { text: 'find and read tasks', actions: ['list_tasks', 'get_task', 'get_task_messages'] },
      { text: 'file tasks', actions: ['create_task'] },
      { text: 'edit, steer or cancel them', actions: ['update_task', 'correct_task_result'] },
      { text: 'approve or reject plans', actions: ['approve_plan', 'reject_plan'] },
    ],
  },
  work: {
    lead: 'Your own task as a worker: ',
    parts: [
      { text: 'claim', actions: ['claim_task'] },
      { text: 'report progress', actions: ['update_progress'] },
      { text: 'post notes', actions: ['post_note'] },
      { text: 'record events', actions: ['emit_event', 'query_events'] },
      { text: 'write artifacts', actions: ['create_artifact', 'upload_artifact'] },
      { text: 'open the PR', actions: ['create_pr', 'record_pr_supersession'] },
      { text: 'suggest a schedule change', actions: ['suggest_schedule_update'] },
      { text: 'complete', actions: ['complete_task'] },
    ],
  },
  prs: {
    parts: [
      { text: 'pull requests', actions: ['get_pr', 'merge_pr', 'close_pr'] },
      { text: 'reviews', actions: ['get_pr_review', 'request_pr_review'] },
      { text: 'releases', actions: ['list_releases', 'get_release', 'release_status'] },
    ],
  },
  runners: {
    parts: [
      { text: 'why something is stuck', actions: ['explain'] },
      { text: 'errors and failure patterns', actions: ['get_error_traces', 'get_failure_analytics'] },
      { text: 'budget and usage', actions: ['get_budget_forecast', 'get_usage_stats'] },
      { text: 'runners and connectors', actions: ['list_runners', 'list_connectors'] },
      { text: 'message a running agent', actions: ['send_agent_message'] },
    ],
  },
  artifacts: {
    parts: [
      { text: 'reports, analyses and other artifacts', actions: ['list_artifacts', 'get_artifact', 'list_artifact_templates', 'update_artifact'] },
    ],
  },
  schedules: {
    parts: [
      { text: 'recurring schedules and what they fired', actions: ['list_schedules', 'trace_schedule'] },
      { text: 'create, edit, pause or delete them', actions: ['create_schedule', 'update_schedule', 'pause_schedules', 'delete_schedule'] },
    ],
  },
  admin: {
    parts: [
      { text: 'workspace config', actions: ['manage_workspaces'] },
      { text: 'skills and roles', actions: ['list_skills', 'get_skill', 'register_skill', 'update_skill', 'delete_skill'] },
      { text: 'secrets', actions: ['manage_secrets'] },
      { text: 'experiments', actions: ['manage_experiments'] },
      { text: 'model tiers', actions: ['manage_model_tiers'] },
      { text: 'watched projects', actions: ['manage_watched_projects'] },
      { text: 'releases', actions: ['trigger_release'] },
      { text: 'knowledge maintenance', actions: ['consolidate_knowledge', 'memory_delete'] },
    ],
  },
};

/** The purpose line of `group` for the actions actually listed. */
export function mcpGroupPurpose(group: McpToolGroup, actions: readonly string[]): string {
  const listed = new Set(actions);
  const { lead, parts } = MCP_GROUP_PURPOSE_PARTS[group];
  const text = parts.filter(p => p.actions.some(a => listed.has(a))).map(p => p.text).join(', ');
  const line = lead ? `${lead}${text}` : text;
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}.`;
}

/** One short line per action. The long form is `help`. */
export const ACTION_SUMMARY: Record<BuilddAction, string> = {
  manage_missions: 'list, read, create, edit, arm or delete missions; link tasks; evaluate criteria',
  manage_initiatives: 'initiatives: containers above missions',
  link_tracker: 'link a mission to a Linear project or issue',
  get_visual_review: "a mission's visual QA: per screen verdict, decision, fix",
  list_discrepancies: 'spec vs code discrepancy rows',
  get_discrepancy: 'one discrepancy with its evidence',
  adjudicate_discrepancy: 'accept a discrepancy or flip its direction',
  promote_discrepancy: 'turn a spec_ahead discrepancy into a mission',
  spec_compare: 'code vs docs evidence for one feature',
  list_tasks: 'list tasks: active by default, a terminal status lists history',
  get_task: 'one task: fields, loop state, workers, artifacts',
  get_task_messages: "a task's instruction history",
  create_task: 'file a task',
  update_task: 'edit, reprioritise or cancel a task',
  correct_task_result: "amend a finished task's summary",
  approve_plan: 'approve a planning task',
  reject_plan: 'reject a plan with feedback',
  send_agent_message: 'steer the agent running a task',
  explain: 'what a task, mission, workspace or PR is waiting on, with evidence',
  get_error_traces: 'errors caught from agent tool output',
  get_failure_analytics: 'worker failure patterns; error= finds a known one',
  get_budget_forecast: 'session pressure and budget burn',
  get_usage_stats: 'token, cost and turn stats',
  list_connectors: 'mounted connectors and their health',
  list_runners: 'runners: slots, branch, build, heartbeat',
  get_pr: 'PR state, CI, reviews, body',
  get_pr_review: 'where a PR review stands',
  merge_pr: 'merge a PR',
  close_pr: 'close a PR',
  request_pr_review: 'hand a PR to a reviewer agent',
  list_releases: 'releases, newest first',
  get_release: 'one release with its tasks',
  release_status: 'what a release would ship and whether CI is green',
  list_schedules: 'schedules with last run and errors',
  trace_schedule: 'find the schedule behind a task or notification',
  create_schedule: 'create a schedule',
  update_schedule: 'edit a schedule',
  pause_schedules: 'pause or resume schedules in bulk',
  delete_schedule: 'delete a schedule',
  list_artifacts: 'list artifacts',
  get_artifact: "one artifact's content",
  list_artifact_templates: 'artifact templates and their schemas',
  update_artifact: 'edit an artifact',
  trigger_release: 'start a release',
  manage_workspaces: 'workspace config and new projects',
  manage_watched_projects: 'deploy-watched projects',
  list_skills: 'skills and roles',
  get_skill: 'one skill, in the shape update_skill takes',
  register_skill: 'add a skill or role',
  update_skill: 'edit a skill or role',
  delete_skill: 'delete a skill',
  manage_experiments: 'experiments and their readouts',
  manage_model_tiers: 'model per tier',
  manage_secrets: 'encrypted MCP credential secrets',
  consolidate_knowledge: 'find duplicate or decayed knowledge; archive',
  memory_delete: 'permanently delete a memory',
  claim_task: 'claim your assignment, or the next or a named pending task',
  update_progress: 'report progress; returns messages for you',
  complete_task: 'finish your task (error marks it failed)',
  create_pr: 'open the PR for your branch',
  emit_event: 'record a milestone event',
  query_events: "a worker's events",
  create_artifact: 'save an artifact (report, analysis, link...)',
  upload_artifact: 'get an upload URL for a file artifact',
  record_pr_supersession: 'record that a closed PR was superseded',
  post_note: 'post a note or question to the task feed',
  suggest_schedule_update: 'propose a change to your schedule',
};

/**
 * Hand-written signatures where the one derived from the long docs is too long
 * or picks up prose. Only params the long docs name (a test holds this);
 * `…` means more exist, see help.
 */
const SIGNATURE_OVERRIDES: Partial<Record<BuilddAction, string>> = {
  create_task: '{title, description, kind, workspaceId?, missionId?, priority?, roleSlug?, dependsOn?, pathManifest?, baseBranch?, outputRequirement?, label?, category?, startAt?, startIn?, verificationCommand?, loopUntilMerged?, tier?, backend?, …}',
  manage_missions: '{action: list|create|get|update|arm|delete|link_task|unlink_task|evaluate|get_criteria_state, missionId?, title?, query?, description?, workspaceId?, initiativeId?, status?, limit?, taskId?, priority?, goalCriteria?, startMode?, executor?, maxConcurrentTasks?, costBudgetUsd?, branchStrategy?, …}',
};

/** The long parameter docs of one action (what the params description used to carry for it). */
export function actionHelp(action: string): string | null {
  if (!(action in ACTION_AREA)) return null;
  const all = buildParamsDescription([action]);
  const m = all.match(/^Action-specific parameters\. By action:\n- [a-z_]+: ([\s\S]*?)(\n\nNote: ([\s\S]*))?$/);
  if (!m) return null;
  return m[3] ? `${action} params: ${m[1]}\n\n${m[3]}` : `${action} params: ${m[1]}`;
}

function longDocs(action: string): string {
  return buildParamsDescription([action])
    .replace(/^Action-specific parameters\. By action:\n- [a-z_]+: /, '')
    .replace(/\n\nNote: workspaceId accepts[\s\S]*$/, '');
}

/** The top-level `{ ... }` of a doc string, braces excluded. */
function topBraces(d: string): string | null {
  if (!d.startsWith('{')) return null;
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < d.length; i++) {
    const c = d[i];
    if (c === '"') quoted = !quoted;
    if (quoted) continue;
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') {
      depth--;
      if (depth === 0) return d.slice(1, i);
    }
  }
  return null;
}

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = '';
  for (const c of s) {
    if (c === '"') quoted = !quoted;
    if (!quoted) {
      if ('{(['.includes(c)) depth++;
      else if ('})]'.includes(c)) depth--;
    }
    if (c === ',' && depth === 0 && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map(x => x.trim()).filter(Boolean);
}

/** `name?`, `a?|b?`, or `action: x|y` for a sub-action selector. */
function paramItem(s: string): string | null {
  const m = s.match(/^[A-Za-z_]\w*\??(?:\s*(?:\||OR|\+)\s*[A-Za-z_]\w*\??)*/);
  if (!m) return null;
  const name = m[0].replace(/\s*(\||OR|\+)\s*/g, (_, op: string) => (op === 'OR' ? '|' : op));
  if (/^(action|op)\??$/.test(name)) {
    const quoted = [...s.matchAll(/"([a-z_]+)"/g)].map(x => x[1]);
    const values = quoted.length ? quoted : (s.match(/\(required:\s*([a-z_|]+)\)/)?.[1]?.split('|') ?? []);
    if (values.length) return `${name}: ${values.join('|')}`;
  }
  return name;
}

/** Param names derived from the long docs: `?` = optional, `a|b` = one of. */
export function derivedSignature(action: string): string | null {
  const inner = topBraces(longDocs(action));
  if (inner === null) return null;
  return `{${splitTopLevel(inner).map(paramItem).filter(Boolean).join(', ')}}`;
}

/** The compact signature shown in a group tool's description. */
export function actionSignature(action: string): string {
  return SIGNATURE_OVERRIDES[action as BuilddAction] ?? derivedSignature(action) ?? '{}';
}

/** Actions whose signature is hand-written (for the test that keeps them honest). */
export const SIGNATURE_OVERRIDE_ACTIONS = Object.keys(SIGNATURE_OVERRIDES) as BuilddAction[];
