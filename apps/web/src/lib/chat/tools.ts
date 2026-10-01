/**
 * The chat tool set: AI SDK tools built in-process from the same action
 * handlers `/api/mcp` serves (packages/core/mcp-tools.ts), one per entry in
 * the registry (registry.ts). A chat tool is named after the MCP action it
 * wraps, so a UI part is `tool-{action}`.
 *
 * Reads run straight away. A write only runs after an approval card this
 * request won (approvals.ts): the SDK only executes an approved call, and the
 * execute below re-checks that the call id is in this request's authorized
 * set, so nothing a tool result says can make a write run on its own.
 *
 * Each call gets an in-process API built from exactly the routes its op
 * declares, so a read op can't reach a write route even if its handler tried.
 */

import { CHANGED_SINCE_SHOWN } from '@builddai/ai-kit/chat/contract';
import { isLiveWorkerStatus } from '@buildd/shared';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import {
  buildParamsDescription, handleBuilddAction, handleLearnAction, handleRecallAction, recallToolDefinition, learnToolDefinition,
  CORPORA, MEMORY_TYPES,
  type ActionContext, type ApiFn,
} from '@buildd/core/mcp-tools';
import { afterResponseMemoryLedger } from '@/lib/memory-ledger';
import { memoryDeciderFor } from '@/lib/memory-decisions';
import type { BuilddObjectRef, ChatApprovalPreview, ChatToolResult } from '@buildd/shared';
import { asBool, previewMatches, type PreviewOutcome } from './previews';
import { isUuid, type Resolution } from './targets';
import { renderStandingRulesForTask, withStandingRules, type StandingRule } from '@buildd/core/chat-directives';
import { routesFor, type ApiCall, type RouteEntry } from './in-process-api';
import { refsFromCalls } from './object-refs';
import { runListWatches, runUnwatch, runWatch } from './watch-tools';
import { runGetVisualReview } from './visual-review-tool';
import { ACTIVE_WINDOW_DAYS, splitByActivity, type WorkspaceActivity } from './workspace-activity';
import {
  ALL_CHAT_TOOL_SPECS, CHAT_TOOL_SPECS, isExposed, opSpec, opsOf, SELF_SCOPED_ALLOWLIST,
  type ChatOpSpec, type ToolGroup,
} from './registry';

/** Tool text the model reads is capped; objects carry the rest. */
const MAX_TOOL_TEXT = 12_000;

const keyOf = (tool: string, op: string) => (op ? `${tool}.${op}` : tool);

/**
 * Write ops chat offers, as `tool.op` ('' op for single-op tools → `tool`):
 * every write, admin or self op the registry doesn't defer.
 */
export const ENABLED_WRITE_OPS: ReadonlySet<string> = new Set(
  Object.entries(ALL_CHAT_TOOL_SPECS).flatMap(([tool, spec]) => opsOf(spec)
    .filter(([, o]) => o.class === 'write' || o.class === 'admin' || o.class === 'self')
    .map(([op]) => keyOf(tool, op))),
);

/**
 * The class a call actually has: a budget change on a mission is an admin
 * write whatever the op, because it changes what the team spends.
 */
export function effectiveClass(tool: string, op: string, spec: ChatOpSpec, input: unknown): ChatOpSpec['class'] {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (tool === 'manage_missions' && (op === 'update' || op === 'create') && i.costBudgetUsd !== undefined) return 'admin';
  return spec.class;
}

/**
 * Does this call start recurring or unattended work? Such a call always gets
 * its approval card, whatever the person's "Allow" (permissions.ts): the
 * `alwaysAsk` ops (new or edited schedules, arming a mission), plus the input
 * forms that resume work — `pause_schedules` with `enabled: true`, and
 * `hold_task` with `hold: false`. Pausing or holding stops work and may skip.
 */
export function startsUnattendedWork(tool: string, spec: ChatOpSpec, input: unknown): boolean {
  if (spec.alwaysAsk) return true;
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (tool === 'pause_schedules') return i.enabled === true;
  if (tool === 'hold_task') return i.hold === false;
  // A standing watch keeps acting after the person leaves (P1 offers none).
  if (tool === 'watch') return i.lifetime !== undefined && i.lifetime !== 'one_shot';
  return false;
}

/** Is this (tool, op) a write chat will offer this turn? */
export function writeEnabled(tool: string, op: string, spec: ChatOpSpec, canAdmin: boolean, input?: unknown): boolean {
  const cls = input === undefined ? spec.class : effectiveClass(tool, op, spec, input);
  if (cls === 'admin' && !canAdmin) return false;
  if (cls !== 'write' && cls !== 'admin' && cls !== 'self') return false;
  return ENABLED_WRITE_OPS.has(keyOf(tool, op));
}

/** create_task fields chat never sets: a person asking in chat isn't a worker, and callbacks leak outside buildd. */
export const CREATE_TASK_REFUSED_FIELDS = ['parentTaskId', 'callbackUrl', 'callbackToken', 'context', 'createdByWorkerId'] as const;

/** Needs an approval card? Reads never; self-scoped allowlisted ops only when untainted (see turn.ts). */
export function needsApproval(tool: string, input: unknown): boolean {
  const s = opSpec(tool, input);
  if (!s) return false;
  if (s.spec.class === 'read' || s.spec.class === 'deferred') return false;
  if (isAllowlistedSelfOp(tool, input)) return false;
  return true;
}

/**
 * A self-scoped op on SELF_SCOPED_ALLOWLIST: it skips its card, but only while
 * nothing a tool returned is in the model's context. turn.ts shows the card
 * when something is, the same taint rule "Allow" follows.
 */
export function isAllowlistedSelfOp(tool: string, input: unknown): boolean {
  const s = opSpec(tool, input);
  return !!s && s.spec.class === 'self' && SELF_SCOPED_ALLOWLIST.includes(keyOf(tool, s.op));
}

const ws = z.string().optional().describe('Workspace id or name; defaults to the conversation workspace.');

const criterion = z.object({
  type: z.enum(['command', 'all_prs_merged', 'no_open_tasks', 'artifact_exists', 'description']),
  label: z.string().optional(),
  command: z.string().optional(),
  description: z.string().optional(),
  notMechanizableReason: z.string().optional(),
  key: z.string().optional(),
}).describe('A completion gate. Prefer a proof of the outcome: a command that exits 0 only when it holds, or artifact_exists for a named deliverable; all_prs_merged / no_open_tasks only close out the work. "description" needs description + notMechanizableReason (10+ chars).');

/** Hand-written schemas where the generic one would read worse to the model. */
function explicitSchema(action: string, ops: [string, ...string[]] | null): z.ZodType | null {
  switch (action) {
    case 'list_tasks':
      return z.object({
        status: z.enum(['active', 'completed', 'failed', 'cancelled']).optional(),
        limit: z.number().int().min(1).max(50).optional(),
        offset: z.number().int().min(0).optional(),
        workspaceId: ws,
      });
    case 'get_task':
      return z.object({ taskId: z.string().describe('The task: its id, 8-character short id, or the words the user used.') });
    case 'manage_missions':
      return z.object({
        action: z.enum(ops!),
        missionId: z.string().optional().describe('The mission: its id, or its title for get / update.'),
        query: z.string().optional().describe('list / get: title substring.'),
        taskId: z.string().optional().describe('link_task / unlink_task: the task.'),
        workspaceId: ws,
        status: z.string().optional().describe('list: default "open" (not completed or archived); "all" for history'),
        limit: z.number().int().min(1).max(100).optional().describe('list: default 20'),
        title: z.string().max(200).optional().describe('create: a short mission title'),
        description: z.string().max(8000).optional().describe('create: the goal, in the words settled with the user'),
        goalCriteria: z.array(criterion).max(12).optional().describe('create: the criteria. update: REPLACES the list; prefer addGoalCriteria / removeGoalCriteria.'),
        addGoalCriteria: z.array(criterion).max(12).optional().describe('update: criteria to add to the current list.'),
        removeGoalCriteria: z.array(z.string()).max(12).optional().describe('update: labels of criteria to remove from the current list.'),
        startMode: z.enum(['armed', 'held']).optional().describe('update: "held" pauses it — no task is claimed by anyone until armed. Not for work someone runs locally; use executor.'),
        executor: z.enum(['runner', 'local']).optional().describe('create / update: "local" when a person runs its tasks from their own session (runners leave them alone; the session claims each one). "runner" (default) for background runners.'),
        autoSurfaceAudit: z.boolean().optional().describe('update: false turns off the automatic visual audit (screenshot QA of UI changes) for this mission; true turns it back on.'),
        priority: z.number().int().min(0).max(10).optional(),
      }).catchall(z.unknown());
    case 'create_task':
      return z.object({
        title: z.string().max(200),
        description: z.string().max(8000),
        missionId: z.string().nullable().optional().describe('The mission it belongs to. Omit it to join the docked mission (or the one this conversation filed). Pass null to file a standalone task in no mission, whenever the user says "not part of a mission" or the work is unrelated to that mission.'),
        dependsOn: z.array(z.string()).optional().describe('Tasks it must wait for: ids, short ids or the words the user used.'),
        baseBranch: z.string().optional().describe('Branch to build on, e.g. the branch of the PR being fixed.'),
        pathManifest: z.array(z.string()).optional().describe('Files it will change. Mission tasks that open a PR need at least one.'),
        workspaceId: ws,
        priority: z.number().int().min(0).max(10).optional(),
        roleSlug: z.string().optional(),
        kind: z.string().optional(),
        label: z.string().optional(),
        outputRequirement: z.string().optional(),
      }).catchall(z.unknown());
    case 'hold_task':
      return z.object({
        taskId: z.string(),
        hold: z.boolean().optional().describe('true to hold (default), false to resume'),
        reason: z.string().max(280).optional(),
      });
    case 'send_agent_message':
      return z.object({
        taskId: z.string(),
        message: z.string().max(4000),
        priority: z.enum(['normal', 'urgent']).optional(),
      });
    case 'answer_question':
      return z.object({ taskId: z.string(), answer: z.string().max(4000) });
    case 'watch':
      return z.object({
        taskId: z.string().optional().describe('The task to watch: its id, short id, or the words the user used.'),
        prNumber: z.union([z.number().int().positive(), z.string()]).optional().describe('Or the PR to watch: its number (42, "#42") or its GitHub URL.'),
        workspaceId: ws,
        on: z.array(z.enum(['done', 'failed', 'needs_input', 'merged', 'ci_failed'])).max(3).optional()
          .describe('What to tell the user about. Default: a task when it is done or fails; a PR when it merges.'),
      });
    case 'unwatch':
      return z.object({
        watchId: z.string().optional().describe('The watch id (or its 8-character short id) from list_watches.'),
        taskId: z.string().optional().describe('Or the watched task\'s id.'),
        prNumber: z.union([z.number().int().positive(), z.string()]).optional().describe('Or the watched PR\'s number.'),
        workspaceId: ws,
      });
    case 'list_watches':
      return z.object({});
    case 'list_prs':
      return z.object({
        state: z.enum(['open', 'attention', 'conflict', 'ci_failed', 'merged']).optional()
          .describe('Default open. attention: conflicts, failing CI, waiting on the user. merged: the last sinceDays.'),
        workspaceId: ws,
        sinceDays: z.number().int().min(1).max(90).optional().describe('merged: default 7.'),
        limit: z.number().int().min(1).max(50).optional(),
      });
    case 'get_pr':
      return z.object({
        prNumber: z.union([z.number().int().positive(), z.string()]),
        workspaceId: ws,
        includeComments: z.boolean().optional().describe('buildd\'s decision trail on the PR.'),
        includeCiFailures: z.boolean().optional().describe('When CI is red: per failing check, the job, failing step and the last lines of its log. Use it to answer "why is CI red?" instead of sending the user to GitHub.'),
        fullBody: z.boolean().optional(),
      });
    case 'recall': {
      const corpus = z.enum(CORPORA);
      return z.object({
        query: z.string().optional().describe('The task title, error text or concept to look up. Required unless id is given.'),
        scope: z.union([corpus, z.array(corpus).min(1)]).optional().describe('Corpus, or a list for fused results. Default memory.'),
        type: z.enum(MEMORY_TYPES).optional().describe('memory corpus only: filter by memory type.'),
        files: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(50).optional(),
        id: z.string().optional().describe('Fetch one memory by id; other fields ignored.'),
        workspaceId: ws,
      });
    }
    case 'learn':
      return z.object({
        type: z.enum(MEMORY_TYPES),
        title: z.string().max(200),
        content: z.string().max(8000),
        files: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        supersedes: z.array(z.string()).optional().describe('Memory ids this replaces.'),
        workspaceId: ws,
      });
    case 'get_visual_review':
      return z.object({ missionId: z.string().describe('The mission\'s full id: the docked mission, or one a tool returned.') });
    case 'list_schedules':
      return z.object({
        workspaceId: ws,
        minutesAgo: z.number().int().positive().optional(),
        nameContains: z.string().optional(),
        type: z.enum(['heartbeat', 'workspace', 'all']).optional(),
      });
    case 'trace_schedule':
      return z.object({
        taskId: z.string().optional(),
        minutesAgo: z.number().int().positive().optional(),
        taskTitleContains: z.string().optional(),
        workspaceId: ws,
      });
    case 'list_runners':
      return z.object({ workspaceId: z.string().optional().describe('Workspace id or name: only its runners, led by whether a browser-capable runner is online for it. Omit for every runner in reach.') });
    case 'list_artifacts':
      return z.object({
        workspaceId: ws,
        missionId: z.string().optional(),
        initiativeId: z.string().optional(),
        key: z.string().optional(),
        type: z.string().optional(),
        review: z.boolean().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      });
    default:
      return null;
  }
}

/**
 * A typed schema refuses keys it doesn't declare. A zod object strips them by
 * default, so list_tasks { missionId } ran as the unfiltered list and the model
 * read the answer as filtered. Refused, the model gets a tool error naming the
 * key and the fields it can use, and can correct the call. The two write
 * schemas with an open catchall keep it: their handlers validate the rest.
 */
function closed(schema: z.ZodType | null): z.ZodType | null {
  if (!(schema instanceof z.ZodObject) || schema._zod.def.catchall !== undefined) return schema;
  const fields = Object.keys(schema.shape);
  return z.strictObject(schema.shape, {
    error: iss => iss.code === 'unrecognized_keys'
      ? `Unknown parameter(s): ${iss.keys.join(', ')}. This tool takes only: ${fields.join(', ') || 'no parameters'}.`
      : undefined,
  });
}

function genericSchema(ops: [string, ...string[]] | null): z.ZodType {
  const base = ops ? z.object({ action: z.enum(ops) }) : z.object({});
  return base.catchall(z.unknown());
}

const TASK_REF = 'taskId: the task — its full id, its 8-character short id, or the words the user used ("checkout"); resolved against the docked mission. If it matches several tasks you get a question back: ask the user, don\'t guess.';

const NATIVE_DESCRIPTIONS: Record<string, string> = {
  recall: recallToolDefinition.description,
  learn: learnToolDefinition.description,
  answer_question: `Answer (or re-answer) a waiting agent's question. Params: ${TASK_REF} answer: the reply. Shows the user an approval card first.`,
  hold_task: `Hold one task (no agent claims it; a running agent is told to stop at a safe point) or resume it. Params: ${TASK_REF} hold: true to hold, false to resume; reason: optional, e.g. "until the rounding decision is in". Shows the user an approval card first.`,
  watch: 'Tell the user once, in this conversation, when a task or PR does something ("let me know when #42 merges", "tell me when checkout is done"). Name exactly one: taskId (id, short id or words) or prNumber (in workspaceId, default the conversation workspace). on: done | failed | needs_input for a task, merged | ci_failed for a PR. It ends by itself after telling them, or after 7 days. May show the user a card first.',
  unwatch: 'Stop one of the user\'s watches. Name it by watchId (from list_watches), taskId or prNumber.',
  list_watches: 'The user\'s running watches: what each is for and when it ends.',
  get_visual_review: 'The mission\'s visual audit as text: its phase, then per route and viewport (phone, desktop) the round, the agent\'s verdict (ok, issue, unsure) and finding, the user\'s decision and the fix task; plus other visual evidence (manual screenshots, validation reports with their verdict line). Each screen and screenshot carries its page link (/app/artifacts/<id>): give those when the user asks for the screenshots or links. Read-only, and it carries no images: you never see the screenshots. The user reviews them on the mission card.',
};

/**
 * Tools whose chat schema is hand-typed (explicitSchema): the schema carries
 * the params, so the description says only what the tool is for. The MCP
 * params dump would repeat the schema and list worker-only fields chat never
 * sets, and the model reads it on every step of every turn.
 */
const CHAT_DESCRIPTIONS: Record<string, string> = {
  list_tasks: 'List tasks. status "active" (default) is claimable or in-progress work; a terminal status (completed, failed, cancelled) lists them all, with PR and artifact attribution.',
  get_task: 'One task: its fields, loop state, latest workers and artifacts.',
  manage_missions: 'Missions: goals with completion criteria that group tasks. list (open by default) / get / get_criteria_state (last verdict per criterion) read. create files one (title, description, goalCriteria). update edits goal, criteria or priority, holds it (startMode "held", a pause), sets who runs it (executor "local" = someone runs it from their own session, "runner" = background runners), or turns its automatic visual audit off or on (autoSurfaceAudit). arm releases a held mission. link_task / unlink_task move a task in or out. evaluate re-checks the criteria now (rate-limited). delete removes it.',
  create_task: 'File one task: a title, a description of what should change and where, and, for a mission task that opens a PR, the files it will touch (pathManifest). dependsOn and baseBranch when it must follow another task or land on its branch. Mission: omitted joins the docked or conversation-filed mission, shown on the card; missionId null files it standalone. Join a mission only when the request is about it; for an unrelated task pass null, and if unsure ask the user.',
  send_agent_message: 'Tell the agent running a task something mid-flight. The agent confirms delivery; get_task_messages shows anything still undelivered. Use this, not update_task, to redirect work in progress.',
  list_schedules: 'Recurring schedules, with last run, last error and where their output goes.',
  trace_schedule: 'Find the schedule behind a task or a recent notification: taskId is the strongest signal; minutesAgo lists schedules that fired in that window; taskTitleContains matches the template title.',
  list_prs: 'PRs buildd opened or adopted, one line each, flagged when one needs the user, is red, or an agent is already on it. Default: open ones, what needs the user first. state attention: only conflicts, failing CI and PRs waiting on the user. merged: recent merges. Closed PRs are never listed.',
  get_pr: 'One PR: state, mergeability, CI, reviews, diff size and the agent\'s summary. Pass workspaceId (a list_prs row names it): one number can exist in several repos. When CI is red and the user asks why, pass includeCiFailures:true and answer from the failing job\'s log.',
  list_runners: 'The runners serving your workspaces: busy of total slots, whether each has a browser (needed for the visual audit) and is online now, branch and build, last heartbeat. With workspaceId it starts with the answer to "can a visual audit run there now?".',
  list_artifacts: 'Reports, analyses and other artifacts. review: true keeps the ones made for a person to read and drops captures (screenshots, diffs, uploads). initiativeId includes every child mission\'s artifacts.',
};

/** Steering tools whose taskId may be words; said in their description so the model doesn't hunt for ids. */
const TASK_REF_TOOLS = new Set(['update_task', 'send_agent_message', 'approve_plan', 'reject_plan', 'correct_task_result']);

function description(action: string, ops: string[] | null): string {
  if (NATIVE_DESCRIPTIONS[action]) return NATIVE_DESCRIPTIONS[action].slice(0, 1500);
  const opsLine = ops ? `\nAvailable from chat: action = ${ops.join(' | ')}.` : '';
  const refLine = TASK_REF_TOOLS.has(action) ? `\nFrom chat, ${TASK_REF}` : '';
  // Approval cards and workspace names are said once, in CHAT_INSTRUCTIONS.
  return `${CHAT_DESCRIPTIONS[action] ?? paramsText(action)}${opsLine}${refLine}`;
}

/** The MCP params text for one action, without the preamble and the per-tool workspace note. */
function paramsText(action: string): string {
  return buildParamsDescription([action])
    .replace(/^Action-specific parameters\. By action:\n- /, '')
    .replace(/\n\nNote: workspaceId accepts[\s\S]*$/, '')
    .slice(0, 1500);
}

export interface ChatToolDeps {
  ctx: ActionContext;
  /** Builds an ApiFn that reports each call (for object refs), limited to `routes`. */
  makeApi: (onCall: (call: ApiCall) => void, opts?: { routes?: readonly RouteEntry[] }) => ApiFn;
  /** Load the write tools at all (intent routing may say no). */
  allowWrites: boolean;
  /** Owner/admin of the conversation team: admin-class ops are offered at all. */
  canAdmin?: boolean;
  /** Tool calls this request won an approval for; nothing else may write. */
  authorizedToolCallIds: ReadonlySet<string>;
  /**
   * Writes this turn let run without a card under the person's "Allow" for the
   * group (permissions.ts canSkipCard, decided in turn.ts). They still go
   * through the same server-built preview: target resolution and reach.
   */
  allowedToolCallIds?: ReadonlySet<string>;
  /** The server-built card each authorized call was approved against (approvals.ts). */
  approvedPreviews?: ReadonlyMap<string, ChatApprovalPreview>;
  /** Builds the card for a write from current state (previews.ts), bound to this turn's reach and dock. */
  preview?: (tool: string, input: Record<string, unknown>) => Promise<PreviewOutcome>;
  /** Resolve a task named by short id or words (targets.ts), bound to this turn's dock. */
  resolveTask?: (ref: string) => Promise<Resolution>;
  /** The conversation this turn is in: where a watch set here is delivered. */
  conversationId?: string | null;
  /** After a mission is filed: link it to the conversation, store the result. */
  onMissionFiled?: (args: { missionId: string; toolCallId: string; result: ChatToolResult }) => Promise<void>;
  /** Team memory for recall/learn, for an in-reach workspace; null when unavailable. */
  memory?: (workspaceId: string | null) => Promise<{ store: Parameters<typeof handleRecallAction>[0]; ctx: Parameters<typeof handleRecallAction>[2] } | null>;
  /**
   * The in-reach workspaces when the turn has no default. A read that needs
   * one (WORKSPACE_SCOPED_READS) and names none runs once per recently
   * active workspace (workspace-activity.ts).
   */
  workspaces?: ReadonlyArray<WorkspaceActivity>;
  now?: () => number;
  handle?: typeof handleBuilddAction;
  /**
   * The chatting person's own standing rules (chat-directives.ts). A task or
   * mission chat files carries the ones that apply to its workspace in its
   * description, so the agent follows them and a reader can see why.
   */
  standingRules?: readonly StandingRule[];
}

/** create_task, or manage_missions create: the writes that file work for an agent. */
function filesWork(action: string, op: string): boolean {
  return action === 'create_task' || (action === 'manage_missions' && op === 'create');
}

/**
 * The call input with any model-written rules block stripped from its
 * description and the person's applicable rules appended, server-rendered.
 * Runs even with no rules, so a forged block never reaches the agent. The
 * workspace is the one the approval preview resolved (`targetWorkspaceId`),
 * else a UUID in the input, else the turn's default.
 */
export function withRulesForFiledWork(
  input: Record<string, unknown>,
  rules: readonly StandingRule[] | undefined,
  defaultWorkspaceId: string | null,
  targetWorkspaceId?: string | null,
): Record<string, unknown> {
  const ws = targetWorkspaceId
    ?? (typeof input.workspaceId === 'string' && isUuid(input.workspaceId) ? input.workspaceId : defaultWorkspaceId);
  const block = rules && rules.length > 0 ? renderStandingRulesForTask(rules, { workspaceId: ws }) : '';
  const description = withStandingRules(input.description, block);
  return description === input.description ? input : { ...input, description };
}

/**
 * Reads whose handler needs a single workspace and errors without one. With no
 * turn scope they span every workspace in reach, as the context block promises,
 * instead of sending the model hunting workspace by workspace.
 */
export const WORKSPACE_SCOPED_READS: ReadonlySet<string> = new Set([
  'list_tasks', 'list_releases', 'list_schedules', 'list_discrepancies',
]);

function errorResult(message: string): ChatToolResult<string> {
  return { data: `Error: ${message}`, objects: [], summary: message.slice(0, 120) };
}

/** The ops of a tool the model may pick this turn. */
function offeredOps(tool: string, deps: ChatToolDeps): string[] {
  const spec = ALL_CHAT_TOOL_SPECS[tool];
  return opsOf(spec)
    .filter(([op, o]) => o.class === 'read' || (deps.allowWrites && writeEnabled(tool, op, o, deps.canAdmin === true)))
    .map(([op]) => op);
}

export function buildChatTools(deps: ChatToolDeps): ToolSet {
  const handle = deps.handle ?? handleBuilddAction;
  const tools: ToolSet = {};

  for (const [action, spec] of Object.entries(ALL_CHAT_TOOL_SPECS)) {
    if (!isExposed(spec)) continue;
    const offered = offeredOps(action, deps);
    if (offered.length === 0) continue;
    const multi = !('' in spec.ops);
    const ops = multi ? (offered as [string, ...string[]]) : null;
    const schema = closed(explicitSchema(action, ops)) ?? genericSchema(ops);

    tools[action] = tool({
      description: description(action, ops),
      inputSchema: schema as z.ZodType<Record<string, unknown>>,
      execute: async (input: Record<string, unknown>, { toolCallId }): Promise<ChatToolResult<string>> => {
        const resolved = opSpec(action, input);
        if (!resolved || resolved.spec.class === 'deferred') {
          const op = multi ? String(input.action ?? '') : '';
          return errorResult(`${multi ? `${action} ${op}` : action} is not available from chat`);
        }
        const { op, spec: o } = resolved;
        const isWrite = o.class !== 'read';
        const name = multi ? `${action} ${op}` : action;
        if (isWrite && !writeEnabled(action, op, o, deps.canAdmin === true, input)) {
          return effectiveClass(action, op, o, input) === 'admin' && deps.canAdmin !== true
            ? errorResult(`${name} needs a team owner or admin`)
            : errorResult(`${name} is not available from chat`);
        }
        if (action === 'create_task') {
          const refused = CREATE_TASK_REFUSED_FIELDS.filter(f => input[f] !== undefined);
          if (refused.length) return errorResult(`create_task from chat can't set ${refused.join(', ')}`);
        }

        let callInput = input;
        // The context block promises tool calls use the conversation's
        // workspace; get_pr's handler only reads one it is given.
        if ((action === 'get_pr' || action === 'get_pr_review') && !input.workspaceId && deps.ctx.workspaceId) {
          callInput = { ...input, workspaceId: deps.ctx.workspaceId };
        }
        // A read that names a task by short id or words (as the docked list
        // shows them) is resolved the same way a steering write is.
        if (!isWrite && typeof input.taskId === 'string' && !isUuid(input.taskId) && deps.resolveTask) {
          const r = await deps.resolveTask(input.taskId);
          if (!r.ok) return { data: `Needs clarification: ${r.question}`, objects: [], summary: 'needs clarification' };
          callInput = { ...input, taskId: r.id };
        }
        let target: ChatApprovalPreview['target'] | null = null;
        const allowed = deps.allowedToolCallIds?.has(toolCallId) === true;
        // A card that was shown and approved binds the call to it, even for an
        // op that may otherwise run cardless (unwatch after tool output): run
        // exactly the input the card was built from, never the raw one.
        const carded = deps.approvedPreviews?.has(toolCallId) === true;
        if (isWrite && (needsApproval(action, input) || carded)) {
          if (!deps.allowWrites || (!deps.authorizedToolCallIds.has(toolCallId) && !allowed)) {
            // Never a write here. The SDK only executes an approved call, so an
            // unapproved one reaching execute means no card was shown: the
            // target was unclear (a question for the user) or it's refused.
            const p = deps.preview ? await deps.preview(action, input).catch(() => null) : null;
            if (p && !p.ok) return { data: `Needs clarification: ${p.question}`, objects: [], summary: 'needs clarification' };
            return errorResult('this write was not approved');
          }
          const approved = deps.approvedPreviews?.get(toolCallId);
          if (allowed && !deps.authorizedToolCallIds.has(toolCallId)) {
            // No card, same checks: the preview resolves the target inside reach.
            if (!deps.preview) return errorResult('this write was not approved');
            const now = await deps.preview(action, input).catch(e => ({ ok: false as const, question: String(e) }));
            if (!now.ok) return { data: `Needs clarification: ${now.question}`, objects: [], summary: 'needs clarification' };
            callInput = now.input;
            target = now.preview.target;
          } else if (deps.preview && (approved || !(action === 'manage_missions' && op === 'create'))) {
            // You approve what you saw: rebuild the card from current state and
            // require the same target and before-state as the approved one.
            const now = await deps.preview(action, input).catch(e => ({ ok: false as const, question: String(e) }));
            if (!now.ok) return errorResult(`nothing changed: ${now.question}`);
            if (!approved || !previewMatches(approved, now.preview)) {
              return errorResult(`nothing changed: ${now.preview.target.label} ${CHANGED_SINCE_SHOWN}. Show the user the current state and ask again.`);
            }
            callInput = now.input;
            target = now.preview.target;
          }
        }

        // After the card check, so the approval still binds to what was shown.
        if (isWrite && filesWork(action, op)) callInput = withRulesForFiledWork(callInput, deps.standingRules, deps.ctx.workspaceId ?? null, target?.workspaceId ?? null);

        const calls: ApiCall[] = [];
        const api = deps.makeApi(c => calls.push(c), { routes: routesFor(o.routes) });
        let text: string;
        let failed = false;
        try {
          const out = spansWorkspaces(action, callInput, deps)
            ? await runAcrossWorkspaces(action, callInput, api, deps, handle)
            : await runAction(action, callInput, api, deps, handle);
          text = out.content.map(c => c.text).join('\n');
          failed = out.isError === true;
        } catch (e) {
          text = `Error: ${e instanceof Error ? e.message : String(e)}`;
          failed = true;
        }
        const objects: BuilddObjectRef[] = withTarget(refsFromCalls(calls), failed ? null : target);
        const result: ChatToolResult<string> = {
          data: text.length > MAX_TOOL_TEXT ? `${text.slice(0, MAX_TOOL_TEXT)}\n…[truncated]` : text,
          objects,
          summary: failed ? text.split('\n')[0].slice(0, 120) : summarize(op, objects, text),
          ...(allowed && isWrite ? { allowed: true } : {}),
        };
        if (action === 'manage_missions' && op === 'create' && !failed) {
          const mission = objects.find(o2 => o2.kind === 'mission');
          if (mission && deps.onMissionFiled) await deps.onMissionFiled({ missionId: mission.id, toolCallId, result });
        }
        return result;
      },
    });
  }
  return tools;
}

async function runAction(
  action: string,
  input: Record<string, unknown>,
  api: ApiFn,
  deps: ChatToolDeps,
  handle: typeof handleBuilddAction,
) {
  if (action === 'recall' || action === 'learn') {
    const wsId = typeof input.workspaceId === 'string' ? input.workspaceId : deps.ctx.workspaceId ?? null;
    const mem = deps.memory ? await deps.memory(wsId) : null;
    if (!mem) return { content: [{ type: 'text' as const, text: 'Error: team knowledge is not available here (no workspace in reach, or the memory store is unavailable).' }], isError: true };
    // A chat write is recorded as a chat episode (used only when the workspace writes candidates).
    const ctx = { memoryLedger: afterResponseMemoryLedger, memoryDecider: memoryDeciderFor(null), memoryProvenance: { kind: 'chat' as const }, ...mem.ctx, api };
    return action === 'recall' ? handleRecallAction(mem.store, input, ctx) : handleLearnAction(mem.store, input, ctx);
  }
  if (action === 'hold_task') return holdTask(api, input);
  if (action === 'answer_question') return answerQuestion(api, input);
  if (action === 'watch') return runWatch(api, input, deps.conversationId ?? null);
  if (action === 'unwatch') return runUnwatch(api, input);
  if (action === 'list_watches') return runListWatches(api);
  if (action === 'get_visual_review') return runGetVisualReview(api, input);
  return handle(api, action, input, deps.ctx);
}

function spansWorkspaces(action: string, input: Record<string, unknown>, deps: ChatToolDeps): boolean {
  return WORKSPACE_SCOPED_READS.has(action) && !input.workspaceId && !deps.ctx.workspaceId
    && (deps.workspaces?.length ?? 0) > 0;
}

/** A handler's "nothing here" answer: one line starting "No …" (No releases found., No completed tasks found.). */
const isEmptyAnswer = (text: string) => /^No [^\n]*\.$/.test(text.trim());

/**
 * One call per recently active workspace, in parallel. Answers are headed by
 * the workspace name; empty ones fold into a single "Nothing in" line and the
 * idle workspaces are named, not checked, so the reply isn't a list of blanks.
 * A failure is named; the rest still answer.
 */
async function runAcrossWorkspaces(
  action: string,
  input: Record<string, unknown>,
  api: ApiFn,
  deps: ChatToolDeps,
  handle: typeof handleBuilddAction,
) {
  const { active, idle } = splitByActivity(deps.workspaces!, (deps.now ?? Date.now)());
  const answers = await Promise.all(active.map(async ws => {
    try {
      const out = await runAction(action, { ...input, workspaceId: ws.id }, api, deps, handle);
      return { ws, text: out.content.map(c => c.text).join('\n') };
    } catch (e) {
      return { ws, text: `Error: ${e instanceof Error ? e.message : String(e)}` };
    }
  }));
  if (active.length === 1) return textOut(answers[0].text);
  const found = answers.filter(a => !isEmptyAnswer(a.text));
  const empty = answers.filter(a => isEmptyAnswer(a.text));
  const lines = found.map(a => `## ${a.ws.name}\n${a.text}`);
  if (empty.length) {
    lines.push(found.length ? `Nothing in: ${empty.map(a => a.ws.name).join(', ')}.` : `${empty[0].text} (${empty.map(a => a.ws.name).join(', ')})`);
  }
  if (idle.length) lines.push(`Not checked (no activity in ${ACTIVE_WINDOW_DAYS} days): ${idle.map(w => w.name).join(', ')}.`);
  return textOut(lines.join('\n\n'));
}

const textOut = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });

/** hold_task: the hold itself, then a word to the running agent. */
async function holdTask(api: ApiFn, input: Record<string, unknown>) {
  const taskId = String(input.taskId);
  const hold = asBool(input.hold, true);
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 280) : '';
  const task = await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify({ held: hold, ...(hold && reason ? { heldReason: reason } : {}) }) });
  const fresh = await api(`/api/tasks/${taskId}?include=workers`);
  const live = (Array.isArray(fresh?.workers) ? fresh.workers : []).find((w: { status: string }) => isLiveWorkerStatus(w.status));
  let told = '';
  if (live) {
    const message = hold
      ? `HOLD: a person put this task on hold${reason ? ` (${reason})` : ''}. Stop at the next safe point: commit and push any work in progress, report progress, and wait. Don't start new changes until you're told to resume.`
      : 'RESUME: the hold on this task is lifted. Carry on from where you stopped.';
    try {
      await api(`/api/workers/${live.id}/instruct`, { method: 'POST', body: JSON.stringify({ message, priority: 'urgent' }) });
      told = `\nThe running agent was sent an urgent ${hold ? 'stop-and-wait' : 'resume'} message.`;
    } catch {
      told = '\nThe hold is set, but the message to the running agent failed; it keeps working until its next check-in.';
    }
  }
  return textOut(`Task ${hold ? 'held' : 'resumed'}: "${task?.title ?? taskId}" (ID: ${taskId}).${hold ? ' No agent will claim it until it is resumed.' : ''}${told}`);
}

/** answer_question: the respond route the question card posts to. */
async function answerQuestion(api: ApiFn, input: Record<string, unknown>) {
  const workerId = String(input.workerId);
  await api(`/api/workers/${workerId}/respond`, { method: 'POST', body: JSON.stringify({ message: String(input.answer) }) });
  // Re-read the task so the card (and the question ref) shows the new state.
  await api(`/api/tasks/${String(input.taskId)}?include=workers`).catch(() => null);
  return textOut(`Answer sent to the agent on task ${String(input.taskId)}. It resumes with it.`);
}

/** The write's target renders live under the card, even when the route's response didn't name it. */
function withTarget(objects: BuilddObjectRef[], target: ChatApprovalPreview['target'] | null): BuilddObjectRef[] {
  if (!target || (target.kind !== 'task' && target.kind !== 'mission')) return objects;
  if (objects.some(o => o.kind === target.kind && o.id === target.id)) return objects;
  const kind = target.kind as 'task' | 'mission';
  const ref = {
    kind, id: target.id, workspaceId: target.workspaceId ?? null, title: target.label,
    fallbackText: `${kind === 'task' ? 'Task' : 'Mission'}: ${target.label}`,
  } as BuilddObjectRef;
  return [ref, ...objects];
}

function summarize(op: string, objects: BuilddObjectRef[], text: string): string {
  if (op === 'create') return objects[0]?.title ? `filed "${objects[0].title}"` : 'filed';
  if (objects.length > 0) return `${objects.length} ${objects[0].kind}${objects.length === 1 ? '' : 's'}`;
  return text.split('\n')[0].slice(0, 120);
}

// ── Groups ──────────────────────────────────────────────────────────────────

/** Always offered: enough to orient and to find the thing the user means, and "tell me when" on whatever that is. */
export const CORE_GROUPS: readonly ToolGroup[] = ['missions', 'tasks', 'notifications'];
/** When routing can't say which area a turn is about. */
export const FALLBACK_GROUPS: readonly ToolGroup[] = ['missions', 'tasks', 'workers'];

/** Tool names in the given groups, among the tools built this turn. */
export function toolNamesForGroups(tools: ToolSet, groups: Iterable<ToolGroup>): string[] {
  const g = new Set(groups);
  return Object.keys(tools).filter(name => {
    const spec = ALL_CHAT_TOOL_SPECS[name];
    return spec && g.has(spec.group);
  });
}

export function groupOf(tool: string): ToolGroup | null {
  return ALL_CHAT_TOOL_SPECS[tool]?.group ?? null;
}

/** The P1 read set, for the shared contract and tests. */
export const CHAT_TOOL_ACTIONS = Object.keys(CHAT_TOOL_SPECS) as Array<keyof typeof CHAT_TOOL_SPECS>;
