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

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import {
  buildParamsDescription, handleBuilddAction, handleLearnAction, handleRecallAction, recallToolDefinition, learnToolDefinition,
  type ActionContext, type ApiFn,
} from '@buildd/core/mcp-tools';
import type { BuilddObjectRef, ChatApprovalPreview, ChatToolResult } from '@buildd/shared';
import { previewMatches, type PreviewOutcome } from './previews';
import { routesFor, type ApiCall, type RouteEntry } from './in-process-api';
import { refsFromCalls } from './object-refs';
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
  if (s.spec.class === 'self' && SELF_SCOPED_ALLOWLIST.includes(keyOf(tool, s.op))) return false;
  return true;
}

const ws = z.string().optional().describe('Workspace id or name; defaults to the conversation workspace.');

const criterion = z.object({
  type: z.enum(['command', 'all_prs_merged', 'no_open_tasks', 'artifact_exists', 'description']),
  label: z.string().optional(),
  command: z.string().optional(),
  description: z.string().optional(),
  notMechanizableReason: z.string().optional(),
  key: z.string().optional(),
}).describe('A completion gate. Prefer command / all_prs_merged / no_open_tasks. "description" needs description + notMechanizableReason (10+ chars).');

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
      return z.object({ taskId: z.string().describe('Full task UUID') });
    case 'manage_missions':
      return z.object({
        action: z.enum(ops!),
        missionId: z.string().optional(),
        workspaceId: ws,
        status: z.string().optional(),
        title: z.string().max(200).optional().describe('create: a short mission title'),
        description: z.string().max(8000).optional().describe('create: the goal, in the words settled with the user'),
        goalCriteria: z.array(criterion).max(12).optional(),
        priority: z.number().int().min(0).max(10).optional(),
      }).catchall(z.unknown());
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
};

/** Steering tools whose taskId may be words; said in their description so the model doesn't hunt for ids. */
const TASK_REF_TOOLS = new Set(['update_task', 'send_agent_message', 'approve_plan', 'reject_plan', 'correct_task_result']);

function description(action: string, ops: string[] | null): string {
  if (NATIVE_DESCRIPTIONS[action]) return NATIVE_DESCRIPTIONS[action].slice(0, 1500);
  const opsLine = ops ? `\nAvailable from chat: action = ${ops.join(' | ')}.` : '';
  const refLine = TASK_REF_TOOLS.has(action) ? `\nFrom chat, ${TASK_REF}` : '';
  const writeLine = ENABLED_WRITE_OPS.has(action) || (ops ?? []).some(op => ENABLED_WRITE_OPS.has(`${action}.${op}`))
    ? '\nWrites show the user an approval card with exactly what changes; nothing happens until they confirm.'
    : '';
  return `${buildParamsDescription([action]).slice(0, 1500)}${opsLine}${refLine}${writeLine}`;
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
  /** The server-built card each authorized call was approved against (approvals.ts). */
  approvedPreviews?: ReadonlyMap<string, ChatApprovalPreview>;
  /** Builds the card for a write from current state (previews.ts), bound to this turn's reach and dock. */
  preview?: (tool: string, input: Record<string, unknown>) => Promise<PreviewOutcome>;
  /** After a mission is filed: link it to the conversation, store the result. */
  onMissionFiled?: (args: { missionId: string; toolCallId: string; result: ChatToolResult }) => Promise<void>;
  /** Team memory for recall/learn, for an in-reach workspace; null when unavailable. */
  memory?: (workspaceId: string | null) => Promise<{ store: Parameters<typeof handleRecallAction>[0]; ctx: Parameters<typeof handleRecallAction>[2] } | null>;
  handle?: typeof handleBuilddAction;
}

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
    const schema = explicitSchema(action, ops) ?? genericSchema(ops);

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
        let target: ChatApprovalPreview['target'] | null = null;
        if (isWrite && needsApproval(action, input)) {
          if (!deps.allowWrites || !deps.authorizedToolCallIds.has(toolCallId)) {
            // Never a write here. The SDK only executes an approved call, so an
            // unapproved one reaching execute means no card was shown: the
            // target was unclear (a question for the user) or it's refused.
            const p = deps.preview ? await deps.preview(action, input).catch(() => null) : null;
            if (p && !p.ok) return { data: `Needs clarification: ${p.question}`, objects: [], summary: 'needs clarification' };
            return errorResult('this write was not approved');
          }
          // You approve what you saw: rebuild the card from current state and
          // require the same target and before-state as the approved one.
          const approved = deps.approvedPreviews?.get(toolCallId);
          if (deps.preview && (approved || !(action === 'manage_missions' && op === 'create'))) {
            const now = await deps.preview(action, input).catch(e => ({ ok: false as const, question: String(e) }));
            if (!now.ok) return errorResult(`nothing changed: ${now.question}`);
            if (!approved || !previewMatches(approved, now.preview)) {
              return errorResult(`nothing changed: ${now.preview.target.label} changed since the card was shown. Show the user the current state and ask again.`);
            }
            callInput = now.input;
            target = now.preview.target;
          }
        }

        const calls: ApiCall[] = [];
        const api = deps.makeApi(c => calls.push(c), { routes: routesFor(o.routes) });
        let text: string;
        let failed = false;
        try {
          const out = await runAction(action, callInput, api, deps, handle);
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
    const ctx = { ...mem.ctx, api };
    return action === 'recall' ? handleRecallAction(mem.store, input, ctx) : handleLearnAction(mem.store, input, ctx);
  }
  if (action === 'hold_task') return holdTask(api, input);
  if (action === 'answer_question') return answerQuestion(api, input);
  return handle(api, action, input, deps.ctx);
}

const textOut = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });

/** hold_task: the hold itself, then a word to the running agent. */
async function holdTask(api: ApiFn, input: Record<string, unknown>) {
  const taskId = String(input.taskId);
  const hold = input.hold !== false;
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 280) : '';
  const task = await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify({ held: hold, ...(hold && reason ? { heldReason: reason } : {}) }) });
  const fresh = await api(`/api/tasks/${taskId}?include=workers`);
  const live = (Array.isArray(fresh?.workers) ? fresh.workers : []).find((w: { status: string }) => !['completed', 'failed', 'error'].includes(w.status));
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

/** Always offered: enough to orient and to find the thing the user means. */
export const CORE_GROUPS: readonly ToolGroup[] = ['missions', 'tasks'];
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
