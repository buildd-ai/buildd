/**
 * The chat tool set: AI SDK tools built in-process from the same action
 * handlers `/api/mcp` serves (packages/core/mcp-tools.ts). A chat tool is named
 * after the MCP action it wraps, so a UI part is `tool-{action}`.
 *
 * P1 surface (docs/design/agent-chat.md → Tools and permissions): reads run
 * straight away; `manage_missions` create is the one write, and it only runs
 * after an approval card this request won (see approvals.ts). Every other
 * `manage_missions` sub-action is refused here, whatever the model asks for.
 */

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { buildParamsDescription, handleBuilddAction, type ActionContext, type ApiFn } from '@buildd/core/mcp-tools';
import type { BuilddObjectRef, ChatToolResult } from '@buildd/shared';
import type { ApiCall } from './in-process-api';
import { refsFromCalls } from './object-refs';

export const CHAT_TOOL_ACTIONS = [
  'list_tasks', 'get_task', 'manage_missions', 'list_schedules', 'trace_schedule', 'list_artifacts',
] as const;
export type ChatToolAction = (typeof CHAT_TOOL_ACTIONS)[number];

export const MISSION_READ_OPS = ['list', 'get', 'get_criteria_state'] as const;
export const MISSION_WRITE_OPS = ['create'] as const;

/** Tool text the model reads is capped; objects carry the rest. */
const MAX_TOOL_TEXT = 12_000;

const ws = z.string().optional().describe('Workspace id or name; defaults to the conversation workspace.');

const criterion = z.object({
  type: z.enum(['command', 'all_prs_merged', 'no_open_tasks', 'artifact_exists', 'description']),
  label: z.string().optional(),
  command: z.string().optional(),
  description: z.string().optional(),
  notMechanizableReason: z.string().optional(),
  key: z.string().optional(),
}).describe('A completion gate. Prefer command / all_prs_merged / no_open_tasks. "description" needs description + notMechanizableReason (10+ chars).');

function schemas(allowWrites: boolean) {
  const missionOps = allowWrites ? [...MISSION_READ_OPS, ...MISSION_WRITE_OPS] : [...MISSION_READ_OPS];
  return {
    list_tasks: z.object({
      status: z.enum(['active', 'completed', 'failed', 'cancelled']).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      offset: z.number().int().min(0).optional(),
      workspaceId: ws,
    }),
    get_task: z.object({ taskId: z.string().describe('Full task UUID') }),
    manage_missions: z.object({
      action: z.enum(missionOps as [string, ...string[]]),
      missionId: z.string().optional(),
      workspaceId: ws,
      status: z.string().optional(),
      title: z.string().max(200).optional().describe('create: a short mission title'),
      description: z.string().max(8000).optional().describe('create: the goal, in the words settled with the user'),
      goalCriteria: z.array(criterion).max(12).optional(),
      priority: z.number().int().min(0).max(10).optional(),
    }),
    list_schedules: z.object({
      workspaceId: ws,
      minutesAgo: z.number().int().positive().optional(),
      nameContains: z.string().optional(),
      type: z.enum(['heartbeat', 'workspace', 'all']).optional(),
    }),
    trace_schedule: z.object({
      taskId: z.string().optional(),
      minutesAgo: z.number().int().positive().optional(),
      taskTitleContains: z.string().optional(),
      workspaceId: ws,
    }),
    list_artifacts: z.object({
      workspaceId: ws,
      missionId: z.string().optional(),
      initiativeId: z.string().optional(),
      key: z.string().optional(),
      type: z.string().optional(),
      review: z.boolean().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
  } satisfies Record<ChatToolAction, z.ZodType>;
}

const DESCRIPTIONS: Record<ChatToolAction, string> = {
  list_tasks: 'List tasks in a workspace (active by default; pass a terminal status to audit finished work).',
  get_task: 'Read one task: status, workers, PRs and any waiting question.',
  manage_missions:
    'Read missions (action list | get | get_criteria_state). action=create files a new mission and shows the user an approval card first: include title, description (the goal) and goalCriteria. Nothing is filed until the user confirms.',
  list_schedules: 'List schedules in a workspace.',
  trace_schedule: 'Find the schedule that spawned a task or fired recently.',
  list_artifacts: 'List artifacts (reports, analyses) in a workspace, mission or initiative.',
};

export interface ChatToolDeps {
  ctx: ActionContext;
  /** Builds an ApiFn that reports each call (for object refs). */
  makeApi: (onCall: (call: ApiCall) => void) => ApiFn;
  /** Load the write tools at all (intent routing may say no). */
  allowWrites: boolean;
  /** Tool calls this request won an approval for; nothing else may write. */
  authorizedToolCallIds: ReadonlySet<string>;
  /** After a mission is filed: link it to the conversation, store the result. */
  onMissionFiled?: (args: { missionId: string; toolCallId: string; result: ChatToolResult }) => Promise<void>;
  handle?: typeof handleBuilddAction;
}

function errorResult(message: string): ChatToolResult<string> {
  return { data: `Error: ${message}`, objects: [], summary: message.slice(0, 120) };
}

export function buildChatTools(deps: ChatToolDeps): ToolSet {
  const handle = deps.handle ?? handleBuilddAction;
  const s = schemas(deps.allowWrites);
  const tools: ToolSet = {};

  for (const action of CHAT_TOOL_ACTIONS) {
    tools[action] = tool({
      description: `${DESCRIPTIONS[action]}\nParams: ${buildParamsDescription([action]).slice(0, 1500)}`,
      inputSchema: s[action] as z.ZodType<Record<string, unknown>>,
      execute: async (input: Record<string, unknown>, { toolCallId }): Promise<ChatToolResult<string>> => {
        const op = action === 'manage_missions' ? String(input.action ?? '') : null;
        const isWrite = op !== null && (MISSION_WRITE_OPS as readonly string[]).includes(op);
        if (op !== null && !isWrite && !(MISSION_READ_OPS as readonly string[]).includes(op)) {
          return errorResult(`manage_missions ${op} is not available from chat`);
        }
        if (isWrite && (!deps.allowWrites || !deps.authorizedToolCallIds.has(toolCallId))) {
          // Defense in depth: the SDK only executes an approved call, and only
          // this request's winning approval lands in the authorized set.
          return errorResult('this write was not approved');
        }

        const calls: ApiCall[] = [];
        const api = deps.makeApi(c => calls.push(c));
        let text: string;
        let failed = false;
        try {
          const out = await handle(api, action, input, deps.ctx);
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
          summary: failed ? text.split('\n')[0].slice(0, 120) : summarize(action, op, objects, text),
        };
        if (isWrite && !failed) {
          const mission = objects.find(o => o.kind === 'mission');
          if (mission && deps.onMissionFiled) await deps.onMissionFiled({ missionId: mission.id, toolCallId, result });
        }
        return result;
      },
    });
  }
  return tools;
}

function summarize(action: string, op: string | null, objects: BuilddObjectRef[], text: string): string {
  if (op === 'create') return objects[0]?.title ? `filed "${objects[0].title}"` : 'filed';
  if (objects.length > 0) return `${objects.length} ${objects[0].kind}${objects.length === 1 ? '' : 's'}`;
  return text.split('\n')[0].slice(0, 120);
}
