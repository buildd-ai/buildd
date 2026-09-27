/**
 * The chat tool registry: every MCP `buildd` action (plus `recall` / `learn`)
 * classified for chat (docs/design/agent-chat.md → Tools and permissions).
 *
 * Each action is either a chat tool (CHAT_TOOL_SPECS) or listed in
 * NOT_IN_CHAT with the reason. A test checks the two cover `allActions`
 * exactly, so a new MCP action can't reach chat, or silently miss it,
 * without being classified here.
 *
 * Per operation a spec says:
 *   - `class`: read (runs at once), write (approval card), admin (owner/admin
 *     only, checked server-side, and a card that needs the target's name
 *     typed), self (reversible, caller-only; may run without a card — see
 *     SELF_SCOPED_ALLOWLIST), or deferred (classified, not exposed yet, with
 *     the reason);
 *   - `routes`: the only (method, CHAT_ROUTES pattern) pairs the op may call.
 *     The in-process API for a call is built from exactly these, so a read op
 *     cannot reach a write route even if its handler tried;
 *   - `target`: for writes, how the input names the object that changes, so
 *     reach is checked before the approval card is shown and again after the
 *     write lands.
 */

import { adminActions, allActions } from '@buildd/core/mcp-tools';
import type { OwnedKind } from './reach-rules';

export type ToolClass = 'read' | 'write' | 'admin' | 'self' | 'deferred';

export const TOOL_GROUPS = ['missions', 'tasks', 'workers', 'prs', 'memory', 'schedules', 'artifacts', 'admin'] as const;
export type ToolGroup = (typeof TOOL_GROUPS)[number];

/** `GET /api/tasks/:id` — a method and a CHAT_ROUTES pattern. */
export type RouteRef = `${'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'} /api/${string}`;

/** How a write's input names what it changes. `conversation` = the conversation team/workspace. */
export type TargetDecl =
  | { param: string; is: OwnedKind | 'workspace' }
  | { conversation: true };

export interface ChatOpSpec {
  class: ToolClass;
  routes: readonly RouteRef[];
  target?: TargetDecl;
  /** For class 'deferred': why it isn't exposed yet. */
  deferredReason?: string;
  /**
   * Always gets an approval card, whatever the person's "Allow": the op starts
   * recurring or unattended work (a schedule, an armed mission). Unlike
   * `admin`, a member may still propose it.
   */
  alwaysAsk?: true;
}

export interface ChatToolSpec {
  group: ToolGroup;
  /** Sub-operations (`input.action`), or a single op under the key `''`. */
  ops: Record<string, ChatOpSpec>;
}

/** Any op may resolve a workspace name through the reach-filtered workspace list. */
const WS = 'GET /api/workspaces' as const;

const read = (...routes: RouteRef[]): ChatOpSpec => ({ class: 'read', routes: [WS, ...routes] });
const write = (target: TargetDecl, ...routes: RouteRef[]): ChatOpSpec => ({ class: 'write', target, routes: [WS, ...routes] });
const admin = (target: TargetDecl, ...routes: RouteRef[]): ChatOpSpec => ({ class: 'admin', target, routes: [WS, ...routes] });
const deferred = (reason: string): ChatOpSpec => ({ class: 'deferred', routes: [], deferredReason: reason });
/** A write that starts recurring or unattended work: never skips its card. */
const startsWork = (op: ChatOpSpec): ChatOpSpec => ({ ...op, alwaysAsk: true });
const single = (group: ToolGroup, op: ChatOpSpec): ChatToolSpec => ({ group, ops: { '': op } });

const CAPS = 'GET /api/missions/capabilities' as const;
const KEY_ONLY = 'its route accepts only a runner API key, not the dashboard session';

export const CHAT_TOOL_SPECS = {
  // ── tasks ──
  list_tasks: single('tasks', read('GET /api/tasks')),
  get_task: single('tasks', read('GET /api/tasks/:id')),
  get_task_messages: single('tasks', read('GET /api/tasks/:id/messages')),
  create_task: single('tasks', write({ param: 'missionId', is: 'mission' }, 'POST /api/tasks', 'GET /api/tasks', 'GET /api/missions/:id')),
  update_task: single('tasks', write({ param: 'taskId', is: 'task' },
    'PATCH /api/tasks/:id', 'GET /api/tasks/:id', 'POST /api/workers/:id/instruct', 'POST /api/tasks/:id/notes', 'POST /api/missions/:id/notes')),
  correct_task_result: single('tasks', write({ param: 'taskId', is: 'task' }, 'PATCH /api/tasks/:id')),
  approve_plan: single('tasks', write({ param: 'taskId', is: 'task' }, 'POST /api/tasks/:id/approve-plan', 'GET /api/tasks/:id')),
  reject_plan: single('tasks', write({ param: 'taskId', is: 'task' }, 'POST /api/tasks/:id/reject-plan')),

  // ── missions ──
  manage_missions: {
    group: 'missions',
    ops: {
      list: read('GET /api/missions'),
      get: read('GET /api/missions/:id'),
      get_criteria_state: read('GET /api/missions/:id/evaluate'),
      create: write({ conversation: true }, 'POST /api/missions', CAPS),
      update: write({ param: 'missionId', is: 'mission' }, 'PATCH /api/missions/:id', 'GET /api/missions/:id', CAPS),
      arm: startsWork(write({ param: 'missionId', is: 'mission' }, 'PATCH /api/missions/:id', CAPS)),
      link_task: write({ param: 'taskId', is: 'task' }, 'PATCH /api/tasks/:id'),
      unlink_task: write({ param: 'taskId', is: 'task' }, 'PATCH /api/tasks/:id'),
      evaluate: write({ param: 'missionId', is: 'mission' }, 'POST /api/missions/:id/evaluate'),
      delete: admin({ param: 'missionId', is: 'mission' }, 'DELETE /api/missions/:id'),
    },
  },
  manage_initiatives: {
    group: 'missions',
    ops: {
      list: read('GET /api/initiatives'),
      get: read('GET /api/initiatives/:id'),
      create: write({ conversation: true }, 'POST /api/initiatives'),
      update: write({ param: 'initiativeId', is: 'initiative' }, 'PATCH /api/initiatives/:id'),
      link_mission: write({ param: 'missionId', is: 'mission' }, 'PATCH /api/missions/:id'),
      unlink_mission: write({ param: 'missionId', is: 'mission' }, 'PATCH /api/missions/:id'),
      delete: admin({ param: 'initiativeId', is: 'initiative' }, 'DELETE /api/initiatives/:id'),
    },
  },
  link_tracker: single('missions', write({ param: 'entityId', is: 'mission' }, 'POST /api/missions/:id/link')),
  list_discrepancies: single('missions', read('GET /api/discrepancies')),
  get_discrepancy: single('missions', read('GET /api/discrepancies/:id')),
  adjudicate_discrepancy: single('missions', write({ param: 'discrepancyId', is: 'discrepancy' }, 'POST /api/discrepancies/:id/adjudicate')),
  promote_discrepancy: single('missions', write({ param: 'discrepancyId', is: 'discrepancy' },
    'GET /api/discrepancies/:id', 'POST /api/missions', 'POST /api/discrepancies/:id/promote')),

  // ── workers: steering and fleet health ──
  send_agent_message: single('workers', write({ param: 'taskId', is: 'task' }, 'GET /api/tasks/:id', 'POST /api/workers/:id/instruct')),
  query_events: single('workers', read('GET /api/workers/:id')),
  explain: single('workers', read('GET /api/explain')),
  get_error_traces: single('workers', read('GET /api/workspaces/:id/error-traces', 'GET /api/workers/:id')),
  get_failure_analytics: single('workers', read('GET /api/health/failures')),
  get_budget_forecast: single('workers', read('GET /api/health/budget')),
  list_connectors: single('workers', read('GET /api/connectors/mounted')),
  get_usage_stats: single('workers', deferred('its route scopes by the caller\'s teams and takes a workspace slug, so it can\'t be pinned to the conversation team yet')),

  // ── PRs, reviews, releases ──
  get_pr: single('prs', read('GET /api/github/pr')),
  get_pr_review: single('prs', read('GET /api/github/pr/review')),
  merge_pr: single('prs', deferred(`${KEY_ONLY} (and needs the green-CI + merge-safety gate from the design)`)),
  close_pr: single('prs', deferred(KEY_ONLY)),
  request_pr_review: single('prs', deferred(KEY_ONLY)),
  list_releases: single('prs', read('GET /api/releases')),
  get_release: single('prs', read('GET /api/releases/:id')),
  release_status: single('prs', read('GET /api/releases/status')),
  trigger_release: single('admin', admin({ param: 'workspaceId', is: 'workspace' }, 'POST /api/releases/trigger')),

  // ── memory and knowledge ──
  spec_compare: single('memory', read()),
  consolidate_knowledge: single('memory', admin({ conversation: true })),
  memory_delete: single('memory', admin({ conversation: true })),

  // ── schedules ──
  list_schedules: single('schedules', read('GET /api/workspaces/:id/schedules')),
  trace_schedule: single('schedules', read('GET /api/tasks/:id', 'GET /api/workspaces/:id/schedules', 'GET /api/workspaces/:id/schedules/:scheduleId')),
  create_schedule: single('schedules', startsWork(write({ param: 'workspaceId', is: 'workspace' }, 'POST /api/workspaces/:id/schedules'))),
  update_schedule: single('schedules', startsWork(write({ param: 'scheduleId', is: 'schedule' },
    'GET /api/workspaces/:id/schedules/:scheduleId', 'PATCH /api/workspaces/:id/schedules/:scheduleId'))),
  pause_schedules: single('schedules', write({ param: 'workspaceId', is: 'workspace' },
    'GET /api/workspaces/:id/schedules', 'PATCH /api/workspaces/:id/schedules/:scheduleId')),
  delete_schedule: single('schedules', admin({ param: 'scheduleId', is: 'schedule' }, 'DELETE /api/workspaces/:id/schedules/:scheduleId')),

  // ── artifacts ──
  list_artifacts: single('artifacts', read('GET /api/workspaces/:id/artifacts', 'GET /api/initiatives/:id/artifacts')),
  get_artifact: single('artifacts', read('GET /api/artifacts/:artifactId')),
  list_artifact_templates: single('artifacts', read()),
  create_artifact: single('artifacts', write({ param: 'missionId', is: 'mission' }, 'POST /api/missions/:id/artifacts', 'POST /api/initiatives/:id/artifacts')),
  update_artifact: single('artifacts', deferred(KEY_ONLY)),

  // ── admin: workspace config, roles, experiments, models ──
  manage_workspaces: {
    group: 'admin',
    ops: {
      list: read(),
      get: read('GET /api/workspaces/:id/config'),
      create: admin({ conversation: true }, 'POST /api/workspaces'),
      update: admin({ param: 'workspaceId', is: 'workspace' }, 'POST /api/workspaces/:id/config', 'PATCH /api/workspaces/:id'),
      create_repo: admin({ param: 'workspaceId', is: 'workspace' }, 'POST /api/workspaces/:id/create-repo', 'PATCH /api/missions/:id'),
      init: admin({ param: 'workspaceId', is: 'workspace' }, 'POST /api/workspaces/:id/policy-init'),
    },
  },
  manage_watched_projects: {
    group: 'admin',
    ops: {
      list: read('GET /api/workspaces/:id/watched-projects'),
      create: write({ param: 'workspaceId', is: 'workspace' }, 'POST /api/workspaces/:id/watched-projects'),
      update: write({ param: 'projectId', is: 'watched_project' }, 'PATCH /api/watched-projects/:id'),
      run: write({ param: 'projectId', is: 'watched_project' }, 'POST /api/watched-projects/:id/run'),
      delete: admin({ param: 'projectId', is: 'watched_project' }, 'DELETE /api/watched-projects/:id'),
    },
  },
  list_skills: single('admin', read('GET /api/workspaces/:id/skills')),
  get_skill: single('admin', read('GET /api/workspaces/:id/skills', 'GET /api/workspaces/:id/skills/:skillId')),
  register_skill: single('admin', admin({ param: 'workspaceId', is: 'workspace' }, 'POST /api/workspaces/:id/skills')),
  update_skill: single('admin', admin({ param: 'workspaceId', is: 'workspace' }, 'GET /api/workspaces/:id/skills', 'PATCH /api/workspaces/:id/skills/:skillId')),
  delete_skill: single('admin', admin({ param: 'workspaceId', is: 'workspace' }, 'GET /api/workspaces/:id/skills', 'DELETE /api/workspaces/:id/skills/:skillId')),
  manage_experiments: {
    group: 'admin',
    ops: {
      list: read('GET /api/experiments'),
      get: read('GET /api/experiments/:id'),
      readout: read('GET /api/experiments/:id/readout'),
      create: admin({ conversation: true }, 'POST /api/experiments'),
      update: admin({ param: 'experimentId', is: 'experiment' }, 'PATCH /api/experiments/:id'),
      start: admin({ param: 'experimentId', is: 'experiment' }, 'PATCH /api/experiments/:id'),
      pause: admin({ param: 'experimentId', is: 'experiment' }, 'PATCH /api/experiments/:id'),
      conclude: admin({ param: 'experimentId', is: 'experiment' }, 'PATCH /api/experiments/:id'),
    },
  },
  manage_model_tiers: single('admin', deferred('model-tier routing and budgets change what every agent in the team spends; kept to the Models settings screen until the admin card ships a spend preview')),
} satisfies Record<string, ChatToolSpec>;

/** Chat-only tools: no MCP action, same registry rules. */
export const CHAT_NATIVE_TOOL_SPECS = {
  /** Answer (or re-answer) a worker's waiting question. MCP has no action for this; the dashboard posts /respond. */
  answer_question: single('workers', write({ param: 'taskId', is: 'task' }, 'GET /api/tasks/:id', 'POST /api/workers/:id/respond')),
  /**
   * Hold or resume one task: no new claims while held, and a running agent is
   * told to stop at a safe point (or to carry on, on resume).
   */
  hold_task: single('tasks', write({ param: 'taskId', is: 'task' }, 'GET /api/tasks/:id', 'PATCH /api/tasks/:id', 'POST /api/workers/:id/instruct')),
  /** Knowledge search (the MCP `recall` tool). */
  recall: single('memory', read()),
  /** Save team knowledge (the MCP `learn` tool). Team-visible, so a card. */
  learn: single('memory', write({ conversation: true })),
} satisfies Record<string, ChatToolSpec>;

export type ChatToolName = keyof typeof CHAT_TOOL_SPECS | keyof typeof CHAT_NATIVE_TOOL_SPECS;

export const ALL_CHAT_TOOL_SPECS: Record<string, ChatToolSpec> = { ...CHAT_TOOL_SPECS, ...CHAT_NATIVE_TOOL_SPECS };

export type NotInChatReason = 'secret' | 'worker-only' | 'deprecated';

/** MCP actions chat never offers, and why. */
export const NOT_IN_CHAT: Record<string, { reason: NotInChatReason; note: string; deepLink?: string }> = {
  manage_secrets: {
    reason: 'secret',
    note: 'Secret values would pass through the model and its provider. Manage keys and tokens on the settings screen.',
    deepLink: '/app/settings?section=agent-backends',
  },
  claim_task: { reason: 'worker-only', note: 'Claims work for a runner; a person in chat is not a worker.' },
  update_progress: { reason: 'worker-only', note: 'A running worker reports its own progress.' },
  complete_task: { reason: 'worker-only', note: 'A worker completes its own task.' },
  create_pr: { reason: 'worker-only', note: 'PRs are opened by the worker that wrote the branch.' },
  emit_event: { reason: 'worker-only', note: 'Worker milestone events.' },
  upload_artifact: { reason: 'worker-only', note: 'Uploads a worker-produced file.' },
  record_pr_supersession: { reason: 'worker-only', note: 'Recorded by the worker that superseded a PR.' },
  post_note: { reason: 'worker-only', note: 'Posts to the calling worker\'s task feed.' },
  suggest_schedule_update: { reason: 'worker-only', note: 'A scheduled worker suggests changes to its own schedule.' },
};

/** Self-scoped writes that may run without a card (see the design doc). Empty until directives ship. */
export const SELF_SCOPED_ALLOWLIST: readonly string[] = [];

/** Ops of a spec, as `[op, spec]`; op is '' for single-op tools. */
export function opsOf(spec: ChatToolSpec): Array<[string, ChatOpSpec]> {
  return Object.entries(spec.ops);
}

export function opSpec(tool: string, input: unknown): { op: string; spec: ChatOpSpec } | null {
  const t = ALL_CHAT_TOOL_SPECS[tool];
  if (!t) return null;
  if ('' in t.ops) return { op: '', spec: t.ops[''] };
  const op = input && typeof input === 'object' ? (input as { action?: unknown }).action : undefined;
  if (typeof op !== 'string' || !(op in t.ops)) return null;
  return { op, spec: t.ops[op] };
}

/** A spec is exposed to the model when at least one op isn't deferred. */
export function isExposed(spec: ChatToolSpec): boolean {
  return opsOf(spec).some(([, o]) => o.class !== 'deferred');
}

/** Everything the MCP `buildd` tool offers (for the coverage test). */
export const MCP_ACTIONS: readonly string[] = allActions;
export const MCP_ADMIN_ACTIONS: readonly string[] = adminActions;
