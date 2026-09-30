/**
 * Tool descriptors advertised by the remote MCP server (ListTools).
 *
 * Pure data. `listMcpTools` is a function of its gating inputs only — the
 * caller's token level and whether the workspace is data-class `sensitive` —
 * so the visibility rules below can be asserted directly, without standing up
 * a server or issuing a request.
 *
 * Invariants encoded here:
 * - `groups` surface (opt-in, `?tools=groups`): one tool per action group
 *   (`buildd_<group>`, @buildd/core/mcp-tool-groups), each narrowed to the
 *   actions the caller's level may call plus `help`. A level with no action in
 *   a group does not see that group. The one-tool `buildd` is not listed but
 *   stays callable (route.ts), so prompts that say "buildd action=..." work.
 * - `legacy` surface (the default): the one `buildd` tool, as before. Every
 *   session gets it unless it opts in, so existing `mcp__buildd__buildd`
 *   allow-rules and `select:mcp__buildd__buildd` keep resolving. Runner
 *   workers (`?worker=`) stay legacy even under the server default flag:
 *   pr-detection, the tool histogram and role allowedTools match the name.
 * - `check_path_claim` / `send_worker_message` are worker/admin only. Trigger
 *   tokens never run agent work, so they never need either.
 * - Sensitive workspaces do not expose the knowledge/memory tools at all.
 *   Callers must supply `isSensitive` fail-closed (see resolveWorkspaceDataClass
 *   in ../route.ts): when the data class cannot be determined, the workspace is
 *   treated as sensitive.
 */
import {
  recallToolDefinition,
  learnToolDefinition,
  triggerActions,
  workerActions,
  allActions as allActionsList,
  memoryActions,
  buildToolDescription,
  buildParamsDescription,
  buildMemoryDescription,
} from "@buildd/core/mcp-tools";
import {
  mcpGroupPurpose,
  MCP_TOOL_GROUPS,
  ACTION_SUMMARY,
  actionHelp,
  actionSignature,
  actionsOfGroup,
  derivedSignature,
  mcpGroupOf,
  mcpGroupToolName,
  mcpGroupParamsSchema,
  type McpToolGroup,
} from "@buildd/core/mcp-tool-groups";
import type { BuilddAction } from "@buildd/core/mcp-tools";

export type McpAccountLevel = 'trigger' | 'worker' | 'admin';

/** `groups`: one tool per action group. `legacy`: the one `buildd` tool. */
export type McpToolSurface = 'groups' | 'legacy';

export interface ListMcpToolsOptions {
  accountLevel: McpAccountLevel;
  /** Workspace data class is `sensitive` (fail-closed when unknown). */
  isSensitive: boolean;
  /** Default `legacy`. */
  surface?: McpToolSurface;
}

/**
 * Which surface a session gets. `?tools=groups|legacy` wins. Otherwise
 * `legacy`, unless the server default (`BUILDD_MCP_TOOL_SURFACE=groups`) says
 * groups, which never applies to a runner-launched worker session
 * (`?worker=`): the runner matches the `mcp__buildd__buildd` tool name.
 */
export function mcpToolSurfaceFor(opts: { toolsParam?: string | null; workerParam?: string | null; serverDefault?: string | null }): McpToolSurface {
  if (opts.toolsParam === 'groups' || opts.toolsParam === 'legacy') return opts.toolsParam;
  return opts.serverDefault === 'groups' && !opts.workerParam ? 'groups' : 'legacy';
}

/** Actions exposed in the `buildd` tool schema for a given token level. */
export function actionsForLevel(accountLevel: McpAccountLevel): string[] {
  return accountLevel === 'admin'
    ? [...allActionsList]
    : accountLevel === 'trigger'
    ? [...triggerActions]
    : [...workerActions];
}

export const HELP_ACTION = 'help';

/** The actions of `group` the level may call, in allActions order. */
export function groupActionsForLevel(group: McpToolGroup, accountLevel: McpAccountLevel): string[] {
  const allowed = new Set(actionsForLevel(accountLevel));
  return actionsOfGroup(group).filter(a => allowed.has(a));
}


/** The group actions whose own sub-action selector (params.action) takes `value`. */
function actionsWithSubAction(group: McpToolGroup, value: string, accountLevel: McpAccountLevel): string[] {
  return groupActionsForLevel(group, accountLevel).filter(a => {
    const m = (derivedSignature(a) ?? '').match(/\baction: ([a-z_|]+)/);
    return !!m && m[1].split('|').includes(value);
  });
}

/** A `buildd_<group>` tool for the given actions: short purpose, one line per action, and `help`. */
export function groupToolDefinition(group: McpToolGroup, actions: readonly string[]): object {
  const lines = actions.map(a => `- ${a} ${actionSignature(a)}: ${ACTION_SUMMARY[a as BuilddAction]}`);
  lines.push(`- ${HELP_ACTION} {action}: full docs for one action`);
  const withSub = actions.find(a => /\baction: [a-z_|]*\bupdate\b/.test(derivedSignature(a) ?? ''));
  return {
    name: mcpGroupToolName(group),
    description: `${mcpGroupPurpose(group, actions)}\n${lines.join('\n')}`,
    annotations: {
      readOnlyHint: group === 'analytics',
      destructiveHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string" as const,
          enum: [...actions, HELP_ACTION],
          // Only where some action has a sub-action selector of its own.
          ...(withSub ? { description: `A sub-action goes in params: {"action":"${withSub}","params":{"action":"update",...}}.` } : {}),
        },
        params: mcpGroupParamsSchema(group, actions),
      },
      required: ["action"],
    },
  };
}

export type GroupToolCall =
  | { kind: 'dispatch'; action: string; params: Record<string, unknown> }
  | { kind: 'reply'; text: string; isError: boolean };

/**
 * What a call to `buildd_<group>` does: `help`, a one-line error for an action
 * that is unknown or lives in another group, or the same dispatch the `buildd`
 * tool does. Level gating of the dispatched action stays where it is for
 * `buildd` (handleBuilddAction), so both tools refuse exactly alike.
 */
export function routeGroupToolCall(group: McpToolGroup, args: Record<string, unknown> | undefined, accountLevel: McpAccountLevel): GroupToolCall {
  const tool = mcpGroupToolName(group);
  const action = typeof args?.action === 'string' ? args.action : '';
  // A model sometimes flattens a call ({action, title, ...}); with no params
  // object, the fields beside action are the params.
  const rest = args ? Object.fromEntries(Object.entries(args).filter(([k]) => k !== 'action' && k !== 'params')) : {};
  const params = (args?.params && typeof args.params === 'object' ? args.params : rest) as Record<string, unknown>;

  if (action === HELP_ACTION) {
    const target = typeof params.action === 'string' ? params.action : '';
    const inGroup = groupActionsForLevel(group, accountLevel);
    if (!target) {
      return { kind: 'reply', isError: false, text: `${tool} actions: ${inGroup.join(', ')}. Call ${tool} with action "help" and params {"action": "<name>"} for one action's full docs.` };
    }
    const help = actionHelp(target);
    if (!help) return { kind: 'reply', isError: true, text: `Unknown action "${target}".` };
    if (!actionsForLevel(accountLevel).includes(target)) {
      return { kind: 'reply', isError: true, text: `"${target}" is not available at your token level (${accountLevel}).` };
    }
    const home = mcpGroupOf(target)!;
    return { kind: 'reply', isError: false, text: home === group ? help : `${help}\n\n(Call it on ${mcpGroupToolName(home)}.)` };
  }

  const home = mcpGroupOf(action);
  if (!home) {
    const owners = actionsWithSubAction(group, action, accountLevel);
    if (owners.length > 0) {
      return { kind: 'reply', isError: true, text: `"${action}" is a sub-action: call ${tool} with action "${owners[0]}" and params.action "${action}".` };
    }
    return { kind: 'reply', isError: true, text: `Unknown action "${action}" for ${tool}. Its actions: ${groupActionsForLevel(group, accountLevel).join(', ')}, ${HELP_ACTION}.` };
  }
  if (home !== group) {
    if (!actionsForLevel(accountLevel).includes(action)) {
      return { kind: 'reply', isError: true, text: `"${action}" is not available at your token level (${accountLevel}).` };
    }
    return { kind: 'reply', isError: true, text: `"${action}" is a ${mcpGroupToolName(home)} action: call ${mcpGroupToolName(home)} with action "${action}".` };
  }
  return { kind: 'dispatch', action, params };
}

/** The server `instructions` block sent on initialize. */
export function mcpServerInstructions(accountLevel: McpAccountLevel, surface: McpToolSurface = 'legacy'): string {
  const tools = surface === 'groups'
    ? `Tools: one per area, \`buildd_<group>\` (${MCP_TOOL_GROUPS.filter(g => groupActionsForLevel(g, accountLevel).length > 0).join(', ')}); \`recall\` (read knowledge), \`learn\` (write knowledge). A group tool takes {action, params}; its description lists each action with its params (\`?\` = optional). Action \`help\` with params {action} returns one action's full docs. workspaceId accepts a UUID, a repo name or owner/repo. Prompts that say \`buildd action=X\` mean: call X on the group tool that lists it. \`buildd_memory\` is deprecated.`
    : `Tools: \`buildd\` (task actions), \`recall\` (read knowledge), \`learn\` (write knowledge). \`buildd_memory\` is deprecated.`;
  const gated = surface === 'groups' ? 'which actions you can call' : 'which `buildd` actions you can call';
  return `Buildd is a task coordination system for AI coding agents. ${tools}

**Token level:** ${accountLevel} — gates ${gated} (trigger ⊂ worker ⊂ admin). A call outside your level returns \`{"error":"forbidden",...}\`, not an expired-token error.

**Before your first task action**, load the buildd-mcp-consumer skill for the full workflow (claim → progress → PR → artifact → learn → complete), the blocked-vs-question rule, friction reporting, and branch strategy. No skill installed? Read the \`buildd://workspace/skills\` resource for the same content, or ask a human to install it.`;
}

/** The legacy one-tool `buildd`: every action the level may call, with the long docs inline. */
function legacyBuilddTool(filteredActions: string[]): object {
  return {
      name: "buildd",
      description: buildToolDescription(filteredActions),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object" as const,
        properties: {
          action: {
            type: "string" as const,
            description: `Action to perform: ${filteredActions.join(", ")}`,
            enum: filteredActions,
          },
          params: {
            type: "object" as const,
            description: buildParamsDescription(filteredActions),
          },
        },
        required: ["action"],
      },
  };
}

export function listMcpTools({ accountLevel, isSensitive, surface = 'legacy' }: ListMcpToolsOptions): object[] {
  const tools: object[] = surface === 'legacy'
    ? [legacyBuilddTool(actionsForLevel(accountLevel))]
    : MCP_TOOL_GROUPS
      .map(g => [g, groupActionsForLevel(g, accountLevel)] as const)
      .filter(([, actions]) => actions.length > 0)
      .map(([g, actions]) => groupToolDefinition(g, actions));

  // check_path_claim is available to worker and admin tokens (not trigger-only tokens).
  // Trigger tokens don't run agent work so they never need mid-task path expansion.
  if (accountLevel === 'worker' || accountLevel === 'admin') {
    tools.push({
      name: "check_path_claim",
      description: surface === 'groups'
        ? 'Claim paths discovered mid-task (worker context required). Unclaimed paths extend pathManifest atomically. A conflict returns blockingTaskId: report blocked to add a dependency. deadlock=true includes the cycle and recovery guidance: cancel/retry, escalate to the blocking owner, or serialize the mission. Do not edit blocked paths.'
        : `Mid-task path-claim check. Call this when you discover you need to touch a file outside your declared pathManifest.

If the path is unclaimed by any active sibling task, your task's pathManifest is atomically extended and you can proceed.
If the path is already claimed by a sibling task, you receive blockingTaskId and must report blocked so a dependsOn edge can be added.
If a deadlock cycle is detected (the blocking task is transitively waiting on you), deadlock=true is returned with a cycle array and actionable guidance on how to break it: cancel and retry, escalate to the blocking task's owner, or use mission-level maxConcurrentTasks=1.

Requires a worker context (?worker=<workerId> in the MCP URL).`,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        type: "object" as const,
        properties: {
          paths: {
            type: "array" as const,
            items: { type: "string" as const },
            description: "Non-empty paths or directory prefixes to claim.",
          },
        },
        required: ["paths"],
      },
    });
  }

  // send_worker_message is available to worker and admin tokens (not trigger-only tokens).
  if (accountLevel === 'worker' || accountLevel === 'admin') {
    tools.push({
      name: "send_worker_message",
      description: surface === 'groups'
        ? 'Message an active sibling task in your workspace; sender comes from worker context. Delivered on its next update_progress. Use path_blocked_on_you, question or answer. Terminal recipient returns delivered=false. Limits: body 2 KB, 5/min/recipient, hopCount <5.'
        : `Send a structured message to another active task worker in the same workspace.

Use when you discover a path conflict (path_blocked_on_you), need to ask a clarifying question about a sibling's changes (question), or are answering another worker's question (answer).

Messages are delivered on the recipient's next update_progress check-in as pendingMessages[].
Sender is resolved automatically from your ?worker= context — do not pass it as a parameter.
Cross-workspace targeting is rejected (data isolation rule, not a nicety).
Recipient terminal → returns { delivered: false, reason: "recipient_terminal" }.
Rate limit: 5 messages per sender per minute per recipient task (retryAfter in error).
Body size limit: 2 KB. Hop cap: 5 (prevents ping-pong loops — messages with hopCount >= 5 are dropped).

Requires a worker context (?worker=<workerId> in the MCP URL).`,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        type: "object" as const,
        properties: {
          recipientTaskId: {
            type: "string" as const,
            description: "Task ID of the recipient. Must share a workspaceId with your task.",
          },
          type: {
            type: "string" as const,
            enum: ["path_blocked_on_you", "path_released", "question", "answer"],
            description: "Message type. path_blocked_on_you: {paths, blockedTaskId} — blocked worker → holder. path_released: {paths, releasedAt, reason} — system → waiter. question: {text} — any → any. answer: {replyToMsgId, text} — any → any.",
          },
          body: {
            type: "object" as const,
            description: "Type-specific payload (max 2 KB). path_blocked_on_you: {paths: string[], blockedTaskId: string}. path_released: {paths: string[], releasedAt: string, reason: 'merged'|'pending_merge'|'abandoned'}. question: {text: string}. answer: {replyToMsgId: string, text: string}.",
          },
          hopCount: {
            type: "number" as const,
            description: "Forwarded hop count (default 0); >=5 dropped.",
          },
        },
        required: ["recipientTaskId", "type", "body"],
      },
    });
  }

  // buildd_memory (deprecated) stays listed on the legacy surface only; it is
  // callable on both (route.ts).
  if (!isSensitive && surface === 'groups') {
    tools.push(recallToolDefinition, learnToolDefinition);
  } else if (!isSensitive) {
    tools.push(
      {
        name: "buildd_memory",
        description: `Legacy knowledge tool; recall (query) and learn (write) are the current interface — use those in new sessions. Kept callable for compatibility. Actions: ${[...memoryActions].join(', ')}`,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: true,
        },
        inputSchema: {
          type: "object" as const,
          properties: {
            action: {
              type: "string" as const,
              description: `Action: ${[...memoryActions].join(', ')}`,
              enum: [...memoryActions],
            },
            params: {
              type: "object" as const,
              description: buildMemoryDescription(memoryActions),
            },
          },
          required: ["action"],
        },
      },
      recallToolDefinition,
      learnToolDefinition,
    );
  }

  return tools;
}
