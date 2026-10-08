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
import { BUILDD_MCP_TOOL_GROUPS } from '@buildd/shared';

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
  dispatch_health: 'workers',
  list_incidents: 'workers',
  get_budget_forecast: 'workers',
  get_usage_stats: 'workers',
  get_manifest_coverage: 'workers',
  get_path_claim_stats: 'workers',
  get_decision_stats: 'workers',
  list_connectors: 'workers',
  list_runners: 'workers',
  read_evidence: 'workers',
  // PRs, reviews, releases
  get_pr: 'prs',
  list_prs: 'prs',
  get_pr_review: 'prs',
  merge_pr: 'prs',
  close_pr: 'prs',
  update_pr: 'prs',
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
  manage_evidence_backends: 'admin',
  manage_secrets: 'admin',
  // a worker's own lifecycle: never a chat tool
  claim_task: 'work',
  update_progress: 'work',
  complete_task: 'work',
  create_pr: 'work',
  emit_event: 'work',
  upload_artifact: 'work',
  get_page_source: 'work',
  deploy: 'work',
  record_pr_supersession: 'work',
  post_note: 'work',
  suggest_schedule_update: 'work',
};

/** Declared in @buildd/shared so tool-name matching needs no action registry. */
export const MCP_TOOL_GROUPS = BUILDD_MCP_TOOL_GROUPS;
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
  explain: 'analytics',
  get_error_traces: 'analytics',
  get_failure_analytics: 'analytics',
  dispatch_health: 'analytics',
  list_incidents: 'analytics',
  read_evidence: 'analytics',
  get_budget_forecast: 'analytics',
  get_usage_stats: 'analytics',
  list_runners: 'analytics',
  get_manifest_coverage: 'analytics',
  get_path_claim_stats: 'analytics',
  get_decision_stats: 'analytics',
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
      { text: 'audit page source', actions: ['get_page_source'] },
      { text: 'deploy as the Platform Operator', actions: ['deploy'] },
      { text: 'open the PR', actions: ['create_pr', 'record_pr_supersession'] },
      { text: 'suggest a schedule change', actions: ['suggest_schedule_update'] },
      { text: 'complete', actions: ['complete_task'] },
    ],
  },
  prs: {
    parts: [
      { text: 'pull requests', actions: ['list_prs', 'get_pr', 'merge_pr', 'close_pr', 'update_pr'] },
      { text: 'reviews', actions: ['get_pr_review', 'request_pr_review'] },
      { text: 'releases', actions: ['list_releases', 'get_release', 'release_status'] },
    ],
  },
  analytics: {
    parts: [
      { text: 'coordination stats', actions: ['get_manifest_coverage', 'get_path_claim_stats', 'get_decision_stats'] },
      { text: 'stuck work', actions: ['explain'] },
      { text: 'errors, run logs, incidents', actions: ['get_error_traces', 'get_failure_analytics', 'read_evidence', 'list_incidents'] },
      { text: 'budget, usage', actions: ['get_budget_forecast', 'get_usage_stats'] },
      { text: 'runners', actions: ['list_runners'] },
      { text: 'dispatch', actions: ['dispatch_health'] },
    ],
  },
  runners: {
    parts: [
      { text: 'connector health', actions: ['list_connectors'] },
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
      { text: 'model tiers, evidence', actions: ['manage_model_tiers', 'manage_evidence_backends'] },
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
  manage_missions: 'list, create, edit, arm, delete missions; link tasks; criteria',
  manage_initiatives: 'initiatives: containers above missions',
  link_tracker: 'link a mission to a Linear project or issue',
  get_visual_review: "per-screen visual QA and shots; workspaceId alone: missions awaiting review",
  list_discrepancies: 'spec vs code discrepancy rows',
  get_discrepancy: 'one discrepancy with its evidence',
  adjudicate_discrepancy: 'accept a discrepancy or flip its direction',
  promote_discrepancy: 'turn a spec_ahead discrepancy into a mission',
  spec_compare: 'code vs docs evidence for one feature',
  list_tasks: 'list tasks; terminal status = history',
  get_task: 'task details',
  get_task_messages: "a task's instruction history",
  create_task: 'file a task',
  update_task: 'edit, reprioritise or cancel a task',
  correct_task_result: "amend a finished task's summary",
  approve_plan: 'approve a planning task',
  reject_plan: 'reject a plan with feedback',
  send_agent_message: 'steer the agent running a task',
  explain: 'task/mission/workspace/PR blockers and evidence',
  get_error_traces: 'errors caught from agent tool output',
  get_failure_analytics: 'failure patterns; error= finds a known one',
  dispatch_health: 'task delivery: verdict, outbox counts, latency',
  list_incidents: 'known incidents',
  get_budget_forecast: 'session pressure, budget burn',
  get_usage_stats: 'token, cost and turn stats',
  get_manifest_coverage: 'coverage by scope and kind',
  get_path_claim_stats: 'path-claim outcomes',
  get_decision_stats: 'decision-shadow counts',
  list_connectors: 'mounted connectors and their health',
  list_runners: 'slots, branch, build, heartbeat',
  read_evidence: 'stored run logs',
  get_pr: 'PR state, CI, reviews, body',
  list_prs: 'open PRs (conflicts/red CI first) or merged',
  get_pr_review: 'where a PR review stands',
  merge_pr: 'merge a PR',
  close_pr: 'close a PR',
  update_pr: 'replace a PR\'s body',
  request_pr_review: 'dispatch PR review',
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
  manage_evidence_backends: 'evidence buckets',
  manage_secrets: 'encrypted MCP credential secrets',
  consolidate_knowledge: 'find duplicate or stale knowledge; archive',
  memory_delete: 'permanently delete a memory',
  claim_task: 'claim your assignment, the next, or a named pending task',
  update_progress: 'report progress; returns messages for you',
  complete_task: 'finish your task (error marks it failed)',
  create_pr: 'open the PR for your branch',
  emit_event: 'record a milestone event',
  query_events: "a worker's events",
  create_artifact: 'save an artifact (report, analysis, link...)',
  upload_artifact: 'get an upload URL for a file artifact',
  get_page_source: 'sandbox or preview URL for visual audit',
  deploy: 'Operator deploy with a credential you never see',
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
  list_incidents: '{workspaceId?, status?, …}',
  get_decision_stats: '{workspaceId?, missionId?, window?, capability?, …}',
  create_task: '{title, description, kind, workspaceId?, missionId?, priority?, roleSlug?, dependsOn?, pathManifest?, baseBranch?, outputRequirement?, verificationCommand?, loopUntilMerged?, tier?, backend?, …}',
  register_skill: '{name, content, slug?, workspaceId?, description?, isRole?, model?, allowedTools?, connectorRefs?, defaultBackend?, …}',
  update_skill: '{slug, workspaceId?, name?, description?, content?, model?, enabled?, allowedTools?, connectorRefs?, defaultBackend?, …}',
  manage_missions: '{action, missionId?|title?, query?, workspaceId?, status?, autoSurfaceAudit?, goalCriteria?, description?, limit?, taskId?, …}',
  manage_evidence_backends: '{action, backendId?, …}',
  read_evidence: '{taskId?|prNumber?, grep?, …}',
  record_pr_supersession: '{prNumber?, supersedingPrNumber, supersedingRepo?, reason, …}',
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

/**
 * Typed params of each group tool: the fields common questions need, as JSON
 * schema properties with one short description each, so a model reaches them
 * without a `help` call. Not every param: the rest stay in the signatures and
 * `help`, and the params object stays open, so untyped fields pass through.
 *
 * A field's description is built from parts tagged with the actions they
 * describe, like the purpose line: a level that lists only part of a group
 * sees only the fields (and the parts of a description) it can act on. A test
 * holds that each tagged action's long docs name the field.
 */
type ParamPart = { text: string; actions: BuilddAction[] };
export interface GroupParam {
  name: string;
  /** JSON schema of the field, without its description. */
  schema: Record<string, unknown>;
  parts: ParamPart[];
  /** Every action a part is tagged with. */
  actions: BuilddAction[];
}

const param = (name: string, schema: Record<string, unknown>, parts: ParamPart[]): GroupParam =>
  ({ name, schema, parts, actions: [...new Set(parts.flatMap(p => p.actions))] });
const str = { type: 'string' };
const num = { type: 'number' };
const bool = { type: 'boolean' };

const WS = 'UUID, repo name or owner/repo';
const MISSION_WRITES: BuilddAction[] = ['manage_missions'];

export const MCP_GROUP_PARAMS: Record<McpToolGroup, GroupParam[]> = {
  missions: [
    param('action', str, [
      { text: 'manage_missions: list|get|update|create|arm|delete|link_task|unlink_task|evaluate|get_criteria_state', actions: ['manage_missions'] },
    ]),
    param('missionId', str, [
      { text: 'Mission UUID, or its title (looked up)', actions: ['manage_missions', 'get_visual_review'] },
    ]),
    param('missionTitle', str, [{ text: 'get_visual_review: title, team-wide unless workspaceId', actions: ['get_visual_review'] }]),
    param('title', str, [{ text: 'create: the title. get/update: finds it by title, no list first', actions: MISSION_WRITES }]),
    param('query', str, [{ text: 'list/get: title substring', actions: MISSION_WRITES }]),
    param('workspaceId', str, [
      { text: WS, actions: ['manage_missions', 'get_visual_review', 'list_discrepancies'] },
      { text: 'get_visual_review with only this: missions awaiting your review', actions: ['get_visual_review'] },
      { text: 'update by UUID: moves the mission there (omit to only scope a title)', actions: MISSION_WRITES },
    ]),
    param('status', str, [{ text: 'list: open (default) or all; update: set it', actions: MISSION_WRITES }]),
    param('priority', num, [{ text: 'create/update', actions: MISSION_WRITES }]),
    param('autoSurfaceAudit', bool, [{ text: 'Automatic visual audit when UI files change (default true)', actions: MISSION_WRITES }]),
    param('autoVerify', bool, [{ text: 'Auto-evaluate goalCriteria (default true)', actions: MISSION_WRITES }]),
    param('startMode', { type: 'string', enum: ['armed', 'held'] }, [{ text: 'held: no task is claimed until armed', actions: MISSION_WRITES }]),
    param('goalCriteria', {
      type: 'array',
      items: { type: 'object', properties: { type: { type: 'string', enum: ['command', 'all_prs_merged', 'no_open_tasks', 'artifact_exists', 'description'] } } },
    }, [{ text: 'Completion gates, null clears; prefer {type:"command",command}', actions: MISSION_WRITES }]),
    param('awaitingOnly', bool, [{ text: 'get_visual_review: only screens awaiting you', actions: ['get_visual_review'] }]),
  ],
  tasks: [
    param('taskId', str, [{ text: 'Task UUID', actions: ['get_task', 'update_task', 'get_task_messages', 'approve_plan', 'reject_plan', 'correct_task_result'] }]),
    param('workspaceId', str, [{ text: WS, actions: ['list_tasks', 'create_task'] }]),
    param('status', str, [
      { text: 'List: active (default)|completed|failed|cancelled', actions: ['list_tasks'] },
      { text: 'Update: pending|completed|failed|cancelled (stops worker)', actions: ['update_task'] },
    ]),
    param('limit', num, [{ text: 'Default 5, max 50', actions: ['list_tasks'] }]),
    param('include', { type: 'array', items: { type: 'string', enum: ['workers', 'artifacts', 'scheduling', 'dispatch'] } }, [{ text: 'Default workers+artifacts', actions: ['get_task'] }]),
    param('fullDescription', bool, [{ text: 'Full text', actions: ['get_task'] }]),
    param('title', str, [{ text: 'create/update', actions: ['create_task', 'update_task'] }]),
    param('priority', num, [{ text: 'create/update', actions: ['create_task', 'update_task'] }]),
  ],
  analytics: [
    param('workspaceId', str, [
      { text: WS, actions: ['list_runners', 'explain', 'get_error_traces', 'get_budget_forecast', 'get_usage_stats', 'get_failure_analytics', 'dispatch_health', 'get_manifest_coverage', 'get_path_claim_stats', 'get_decision_stats'] },
      { text: 'list_runners: says if a browser runner is online', actions: ['list_runners'] },
    ]),
    param('taskId', str, [{ text: 'Task UUID', actions: ['explain', 'get_error_traces'] }]),
    param('missionId', str, [{ text: 'Mission UUID', actions: ['explain', 'get_manifest_coverage', 'get_path_claim_stats', 'get_decision_stats'] }]),
    param('window', { type: 'string', enum: ['24h', '7d', '30d'] }, [{ text: 'Window (default 7d)', actions: ['get_usage_stats', 'get_failure_analytics', 'get_manifest_coverage', 'get_path_claim_stats', 'get_decision_stats'] }]),
    param('family', { type: 'string', enum: ['gate'] }, [{ text: 'Gate ledger, including changeIntent warnings', actions: ['get_failure_analytics'] }]),
    param('errorPrefix', str, [{ text: 'Literal reason/signature prefix', actions: ['get_failure_analytics'] }]),
    param('capability', str, [{ text: 'Ledger rows, e.g. question_gate', actions: ['get_decision_stats'] }]),
  ],
  runners: [
    param('workspaceId', str, [{ text: WS, actions: ['list_connectors'] }]),
    param('taskId', str, [{ text: 'Task UUID', actions: ['send_agent_message'] }]),
  ],
  prs: [
    param('prNumber', num, [{ text: 'PR number', actions: ['get_pr', 'merge_pr', 'close_pr', 'update_pr', 'get_pr_review', 'request_pr_review'] }]),
  ],
  artifacts: [
    param('artifactId', str, [{ text: 'Artifact UUID', actions: ['get_artifact', 'update_artifact'] }]),
    param('missionId', str, [{ text: 'list_artifacts: mission UUID (not a title)', actions: ['list_artifacts'] }]),
  ],
  schedules: [
    param('scheduleId', str, [{ text: 'Schedule UUID', actions: ['update_schedule', 'delete_schedule'] }]),
    param('delegation', { type: 'object' }, [{ text: 'Cross-workspace grant', actions: ['update_schedule'] }]),
  ],
  work: [],
  admin: [],
};

/**
 * The `params` schema of a group tool listing `actions`. `help` takes {action}, which the description's help line already says.
 * No schema-level description: the tool description's signatures already say what params takes, and
 * repeating "per the signature above" on every group cost ~100 tokens of the 6k budget.
 */
export function mcpGroupParamsSchema(group: McpToolGroup, actions: readonly string[]): { type: 'object'; properties: Record<string, Record<string, unknown>> } {
  const listed = new Set(actions);
  const properties: Record<string, Record<string, unknown>> = {};
  for (const f of MCP_GROUP_PARAMS[group]) {
    const texts = f.parts.filter(p => p.actions.some(a => listed.has(a))).map(p => p.text);
    if (texts.length === 0) continue;
    properties[f.name] = { ...f.schema, description: texts.join('. ') };
  }
  return { type: 'object', properties };
}
