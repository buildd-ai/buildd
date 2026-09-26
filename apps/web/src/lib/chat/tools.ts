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
import type { BuilddObjectRef, ChatToolResult } from '@buildd/shared';
import { routesFor, type ApiCall, type RouteEntry } from './in-process-api';
import { refsFromCalls } from './object-refs';
import {
  ALL_CHAT_TOOL_SPECS, CHAT_TOOL_SPECS, isExposed, opSpec, opsOf, SELF_SCOPED_ALLOWLIST,
  type ChatOpSpec, type ToolGroup,
} from './registry';

/** Tool text the model reads is capped; objects carry the rest. */
const MAX_TOOL_TEXT = 12_000;

/**
 * Write ops chat offers, as `tool.op` ('' op for single-op tools → `tool`).
 * Everything else classified write/admin stays refused until listed here.
 */
export const ENABLED_WRITE_OPS: ReadonlySet<string> = new Set(['manage_missions.create']);

const keyOf = (tool: string, op: string) => (op ? `${tool}.${op}` : tool);

/** Is this (tool, op) a write chat will offer this turn? */
export function writeEnabled(tool: string, op: string, spec: ChatOpSpec, canAdmin: boolean): boolean {
  if (spec.class === 'admin' && !canAdmin) return false;
  if (spec.class !== 'write' && spec.class !== 'admin' && spec.class !== 'self') return false;
  return ENABLED_WRITE_OPS.has(keyOf(tool, op));
}

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

const NATIVE_DESCRIPTIONS: Record<string, string> = {
  recall: recallToolDefinition.description,
  learn: learnToolDefinition.description,
  answer_question: 'Answer a worker\'s waiting question (workerId + answer). Shows the user an approval card first.',
};

function description(action: string, ops: string[] | null): string {
  if (NATIVE_DESCRIPTIONS[action]) return NATIVE_DESCRIPTIONS[action].slice(0, 1500);
  const opsLine = ops ? `\nAvailable from chat: action = ${ops.join(' | ')}.` : '';
  return `${buildParamsDescription([action]).slice(0, 1500)}${opsLine}`;
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
        if (isWrite && !writeEnabled(action, op, o, deps.canAdmin === true)) {
          return errorResult(`${multi ? `${action} ${op}` : action} is not available from chat`);
        }
        if (isWrite && needsApproval(action, input) && (!deps.allowWrites || !deps.authorizedToolCallIds.has(toolCallId))) {
          // Defense in depth: the SDK only executes an approved call, and only
          // this request's winning approval lands in the authorized set.
          return errorResult('this write was not approved');
        }

        const calls: ApiCall[] = [];
        const api = deps.makeApi(c => calls.push(c), { routes: routesFor(o.routes) });
        let text: string;
        let failed = false;
        try {
          const out = await runAction(action, input, api, deps, handle);
          text = out.content.map(c => c.text).join('\n');
          failed = out.isError === true;
        } catch (e) {
          text = `Error: ${e instanceof Error ? e.message : String(e)}`;
          failed = true;
        }
        const objects: BuilddObjectRef[] = refsFromCalls(calls);
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
  return handle(api, action, input, deps.ctx);
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
