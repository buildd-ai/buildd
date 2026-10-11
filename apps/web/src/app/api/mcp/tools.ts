import { hasTokenScope, requiredScopeForAction, type TokenScope } from '@buildd/core/token-scopes';
/**
 * Tool descriptors advertised by the remote MCP server (ListTools).
 *
 * Pure data. `listMcpTools` is a function of its gating inputs only — the
 * caller's token level and whether the workspace is data-class `sensitive` —
 * so the visibility rules below can be asserted directly, without standing up
 * a server or issuing a request.
 *
 * Invariants encoded here:
 * - `groups` surface (the standard one): one tool per action group
 *   (`buildd_<group>`, @buildd/core/mcp-tool-groups), each narrowed to the
 *   actions the caller's level may call plus `help`. A level with no action in
 *   a group does not see that group. The one-tool `buildd` is not listed but
 *   stays callable (route.ts), so prompts that say "buildd action=..." work.
 * - `legacy` surface: the one `buildd` tool. Served only to a runner worker
 *   session (`?worker=`) whose runner did not advertise
 *   CAPABILITY_MCP_GROUP_TOOLS: such a runner matches buildd actions by the
 *   exact `mcp__buildd__buildd` tool name (pr-detection, hooks, nudges).
 *   LEGACY: remove this surface once no runner predating group tools is left.
 * - A worker-level session also sees list_skills / get_skill /
 *   register_skill / update_skill / delete_skill, for personal roles
 *   (`personal: true`); their team path stays admin-only
 *   (handleBuilddAction refuses it).
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
  PERSONAL_ROLE_ACTIONS,
  ORCHESTRATION_TASK_TOKEN_ADMIN_ACTIONS,
  adminActions,
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
  mcpGroupOfToolName,
  mcpGroupToolName,
  mcpGroupParamsSchema,
  requiredParamsOf,
  splitListed,
  type McpToolGroup,
} from "@buildd/core/mcp-tool-groups";
import type { BuilddAction } from "@buildd/core/mcp-tools";

export type McpAccountLevel = 'trigger' | 'worker' | 'admin';

/** `groups`: one tool per action group. `legacy`: the one `buildd` tool. */
export type McpToolSurface = 'groups' | 'legacy';

/**
 * Who is behind the session, beyond its level: decides which actions it is
 * shown that its level alone would admit but its handler always refuses.
 * - `principal` 'key' / 'task_token': no person, so the personal-role path of
 *   the skill actions (the only reason a worker level sees them) is refused.
 * - `orchestrationTaskToken`: an admin-level per-task token reaches only the
 *   admin actions its own mission needs (ORCHESTRATION_TASK_TOKEN_ADMIN_ACTIONS).
 * Absent fields hide nothing (an unknown caller keeps the level's list).
 */
export interface McpSessionReach {
  principal?: 'person' | 'key' | 'task_token';
  orchestrationTaskToken?: boolean;
}

export interface ListMcpToolsOptions extends McpSessionReach {
  accountLevel: McpAccountLevel;
  scopes?: readonly string[] | null;
  /** Workspace data class is `sensitive` (fail-closed when unknown). */
  isSensitive: boolean;
  /** Default `groups`. */
  surface?: McpToolSurface;
}

/**
 * Which surface a session gets: the group tools, except for a runner worker
 * session (`?worker=`) whose runner has not advertised
 * CAPABILITY_MCP_GROUP_TOOLS (`runnerSupportsGroupTools` false or unknown).
 * That runner predates group tools and recognises buildd actions only under
 * the legacy `mcp__buildd__buildd` name, so it keeps the legacy listing.
 * LEGACY: drop the fallback with the legacy surface.
 */
export function mcpToolSurfaceFor(opts: { workerParam?: string | null; runnerSupportsGroupTools?: boolean | null }): McpToolSurface {
  if (!opts.workerParam) return 'groups';
  return opts.runnerSupportsGroupTools === true ? 'groups' : 'legacy';
}

const ADMIN_ONLY = new Set<string>(adminActions);
const PERSONAL = new Set<string>(PERSONAL_ROLE_ACTIONS);

/** Actions exposed in the `buildd` tool schema for a given token level (and session reach). */
export function actionsForLevel(accountLevel: McpAccountLevel, scopes?: readonly string[] | null, reach: McpSessionReach = {}): string[] {
  const actions = levelActions(accountLevel, scopes);
  const personless = reach.principal === 'key' || reach.principal === 'task_token';
  return actions.filter(a => {
    if (!ADMIN_ONLY.has(a)) return true;
    // An orchestration task token: only its own mission's admin actions.
    if (reach.orchestrationTaskToken) return Object.hasOwn(ORCHESTRATION_TASK_TOKEN_ADMIN_ACTIONS, a);
    // Below admin, an admin action is listed only for its personal-role path,
    // which needs a person behind the session.
    if (accountLevel !== 'admin' && scopes == null) return PERSONAL.has(a) && !personless;
    return true;
  });
}

function levelActions(accountLevel: McpAccountLevel, scopes?: readonly string[] | null): string[] {
  if (scopes != null) return allActionsList.filter(action => {
    const required = requiredScopeForAction(action);
    return (required != null && hasTokenScope(scopes, required)) ||
      (action === 'manage_experiments' && hasTokenScope(scopes, 'analytics:read')) ||
      (['manage_missions', 'manage_initiatives', 'manage_workspaces'].includes(action) && hasTokenScope(scopes, 'tasks:read'));
  });
  return accountLevel === 'admin'
    ? [...allActionsList]
    : accountLevel === 'trigger'
    ? [...triggerActions]
    // Personal roles: list/get/register/update/delete_skill with
    // personal: true (the team-role path is refused below admin).
    : [...workerActions, ...PERSONAL_ROLE_ACTIONS];
}

export const HELP_ACTION = 'help';

/** The actions of `group` the level may call, in allActions order. */
export function groupActionsForLevel(group: McpToolGroup, accountLevel: McpAccountLevel, scopes?: readonly string[] | null, reach: McpSessionReach = {}): string[] {
  const allowed = new Set(actionsForLevel(accountLevel, scopes, reach));
  return actionsOfGroup(group).filter(a => allowed.has(a));
}


/** The group actions whose own sub-action selector (params.action) takes `value`. */
function actionsWithSubAction(group: McpToolGroup, value: string, accountLevel: McpAccountLevel, scopes?: readonly string[] | null, reach: McpSessionReach = {}): string[] {
  return groupActionsForLevel(group, accountLevel, scopes, reach).filter(a => {
    const m = (derivedSignature(a) ?? '').match(/\baction: ([a-z_|]+)/);
    return !!m && m[1].split('|').includes(value);
  });
}

/**
 * A `buildd_<group>` tool for the given actions: short purpose, one line per
 * listed action, `help`, and one `More:` line naming the rarely used ones
 * (ACTION_LISTING). Every action stays in the enum and is called the same way.
 */
export function groupToolDefinition(group: McpToolGroup, actions: readonly string[]): object {
  const { listed, more } = splitListed(actions);
  const lines = listed.map(a => `- ${a} ${actionSignature(a)}: ${ACTION_SUMMARY[a as BuilddAction]}`);
  lines.push(`- ${HELP_ACTION} {action}: docs for one action`);
  if (more.length > 0) lines.push(`More: ${more.join(', ')} — call help {action} for docs.`);
  const withSub = listed.find(a => /\baction: [a-z_|]*\bupdate\b/.test(derivedSignature(a) ?? ''));
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
        params: mcpGroupParamsSchema(group, listed),
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
export function routeGroupToolCall(group: McpToolGroup, args: Record<string, unknown> | undefined, accountLevel: McpAccountLevel, scopes?: readonly string[] | null, reach: McpSessionReach = {}): GroupToolCall {
  const tool = mcpGroupToolName(group);
  const action = typeof args?.action === 'string' ? args.action : '';
  // A model sometimes flattens a call ({action, title, ...}); with no params
  // object, the fields beside action are the params.
  const rest = args ? Object.fromEntries(Object.entries(args).filter(([k]) => k !== 'action' && k !== 'params')) : {};
  const params = (args?.params && typeof args.params === 'object' ? args.params : rest) as Record<string, unknown>;

  if (action === HELP_ACTION) {
    const target = typeof params.action === 'string' ? params.action : '';
    const inGroup = groupActionsForLevel(group, accountLevel, scopes, reach);
    if (!target) {
      return { kind: 'reply', isError: false, text: `${tool} actions: ${inGroup.join(', ')}. Call ${tool} with action "help" and params {"action": "<name>"} for one action's full docs.` };
    }
    const help = actionHelp(target);
    if (!help) return { kind: 'reply', isError: true, text: `Unknown action "${target}".` };
    if (!actionsForLevel(accountLevel, scopes, reach).includes(target)) {
      return { kind: 'reply', isError: true, text: `"${target}" is not available at your token level (${accountLevel}).` };
    }
    const home = mcpGroupOf(target)!;
    return { kind: 'reply', isError: false, text: home === group ? help : `${help}\n\n(Call it on ${mcpGroupToolName(home)}.)` };
  }

  const home = mcpGroupOf(action);
  if (!home) {
    const owners = actionsWithSubAction(group, action, accountLevel, scopes, reach);
    if (owners.length > 0) {
      return { kind: 'reply', isError: true, text: `"${action}" is a sub-action: call ${tool} with action "${owners[0]}" and params.action "${action}".` };
    }
    return { kind: 'reply', isError: true, text: `Unknown action "${action}" for ${tool}. Its actions: ${groupActionsForLevel(group, accountLevel, scopes, reach).join(', ')}, ${HELP_ACTION}.` };
  }
  if (home !== group) {
    if (!actionsForLevel(accountLevel, scopes, reach).includes(action)) {
      return { kind: 'reply', isError: true, text: `"${action}" is not available at your token level (${accountLevel}).` };
    }
    return { kind: 'reply', isError: true, text: `"${action}" is a ${mcpGroupToolName(home)} action: call ${mcpGroupToolName(home)} with action "${action}".` };
  }
  // A schema-constrained model fills only declared properties; when it sends
  // nothing, say so instead of letting the action fail on each field in turn.
  const required = requiredParamsOf(action);
  // Only for an action the level may call: above-level calls still reach the
  // handler, which refuses them exactly as the `buildd` tool does.
  if (required.length > 0 && Object.keys(params).length === 0 && actionsForLevel(accountLevel, scopes, reach).includes(action)) {
    return { kind: 'reply', isError: true, text: `${action}: params arrived empty. It needs ${required.join(', ')}: call ${tool} with {"action":"${action}","params":{${required.map(r => `"${r}": ...`).join(', ')}}}.` };
  }
  return { kind: 'dispatch', action, params };
}

/** The server `instructions` block sent on initialize. */
export function mcpServerInstructions(accountLevel: McpAccountLevel, surface: McpToolSurface = 'groups', scopes?: readonly string[] | null, reach: McpSessionReach = {}): string {
  const tools = surface === 'groups'
    ? `Tools: one per area, \`buildd_<group>\` (${MCP_TOOL_GROUPS.filter(g => groupActionsForLevel(g, accountLevel, scopes, reach).length > 0).join(', ')}); \`recall\` (read knowledge), \`learn\` (write knowledge). A group tool takes {action, params}; its description lists its common actions with their params (\`?\` = optional), and a \`More:\` line names the rest, called the same way. Action \`help\` with params {action} returns one action's full docs. workspaceId accepts a UUID, a repo name or owner/repo. Prompts that say \`buildd action=X\` mean: call X on the group tool that lists it. \`buildd_memory\` is deprecated.`
    : `Tools: \`buildd\` (task actions), \`recall\` (read knowledge), \`learn\` (write knowledge). \`buildd_memory\` is deprecated.`;
  const gated = surface === 'groups' ? 'which actions you can call' : 'which `buildd` actions you can call';
  return `Buildd is a task coordination system for AI coding agents. ${tools}

${scopes != null ? `**Token scopes:** ${scopes.join(', ') || 'none'} — explicit capabilities replace legacy level permissions.` : `**Token level:** ${accountLevel} — gates ${gated} (trigger ⊂ worker ⊂ admin).`} A call outside your level returns \`{"error":"forbidden",...}\`, not an expired-token error.

**Before your first task action**, load the buildd-mcp-consumer skill for the full workflow (claim → progress → PR → artifact → learn → complete), the blocked-vs-question rule, friction reporting, and branch strategy. No skill installed? Read the \`buildd://workspace/skills\` resource for the same content, or ask a human to install it.`;
}

/** The legacy one-tool `buildd`: every action the level may call, with the long docs inline. LEGACY: old-runner fallback only. */
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

export function listMcpTools({ accountLevel, isSensitive, surface = 'groups', scopes, principal, orchestrationTaskToken }: ListMcpToolsOptions): object[] {
  const reach: McpSessionReach = { principal, orchestrationTaskToken };
  const tools: object[] = surface === 'legacy'
    ? [legacyBuilddTool(actionsForLevel(accountLevel, scopes))]
    : MCP_TOOL_GROUPS
      .map(g => [g, groupActionsForLevel(g, accountLevel, scopes, reach)] as const)
      .filter(([, actions]) => actions.length > 0)
      .map(([g, actions]) => groupToolDefinition(g, actions));

  // check_path_claim is available to worker and admin tokens (not trigger-only tokens).
  // Trigger tokens don't run agent work so they never need mid-task path expansion.
  if (scopes != null ? hasTokenScope(scopes, 'workers:write') : accountLevel === 'worker' || accountLevel === 'admin') {
    tools.push({
      name: "check_path_claim",
      description: surface === 'groups'
        ? 'Claim paths mid-task. Conflict returns blockingTaskId; report blocked. deadlock=true adds cycle+recovery. release=true gives paths back.'
        : `Mid-task path-claim check. Call this when you discover you need to touch a file outside your declared pathManifest.

If the path is unclaimed by any active sibling task, your task's pathManifest is atomically extended and you can proceed.
If the path is already claimed by a sibling task, you receive blockingTaskId and must report blocked so a dependsOn edge can be added.
If a deadlock cycle is detected (the blocking task is transitively waiting on you), deadlock=true is returned with a cycle array and actionable guidance on how to break it: cancel and retry, escalate to the blocking task's owner, or use mission-level maxConcurrentTasks=1.
With release=true, gives the paths back instead: frees your leases on them (and under them), drops them from your manifest, and wakes only tasks waiting on them.

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
            description: "Paths/dirs to claim, or release if release=true.",
          },
          release: {
            type: "boolean" as const,
            description: "If true, release instead of claim.",
          },
          reason: {
            type: "string" as const,
            description: "Release note.",
          },
          expectedRevision: {
            type: "number" as const,
            description: "CAS token.",
          },
        },
        required: ["paths"],
      },
    });
  }

  // send_worker_message is available to worker and admin tokens (not trigger-only tokens).
  if (scopes != null ? hasTokenScope(scopes, 'workers:write') : accountLevel === 'worker' || accountLevel === 'admin') {
    tools.push({
      name: "send_worker_message",
      description: surface === 'groups'
        ? 'Message an active sibling task in your workspace (sender: you). Delivered at its next turn. Terminal recipient: delivered=false. Limits: body 2 KB, 5/min/recipient, hopCount <5.'
        : `Send a structured message to another active task worker in the same workspace.

Use when you discover a path conflict (path_blocked_on_you), need to ask a clarifying question about a sibling's changes (question), or are answering another worker's question (answer).

Messages reach the recipient at its next turn boundary: its runner injects them into the session, or (interactive session) its next receive_messages / update_progress returns them.
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
            description: surface === 'groups'
              ? 'Message type; body defines its payload.'
              : "Message type. path_blocked_on_you: {paths, blockedTaskId} — blocked worker → holder. path_released: {paths, releasedAt, reason} — system → waiter. question: {text} — any → any. answer: {replyToMsgId, text} — any → any.",
          },
          body: {
            type: "object" as const,
            description: "Type-specific payload (max 2 KB). path_blocked_on_you: {paths: string[], blockedTaskId: string}. path_released: {paths: string[], releasedAt: string, reason: 'merged'|'pending_merge'|'abandoned'|'narrowed'}. question: {text: string}. answer: {replyToMsgId: string, text: string}.",
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

  if (scopes == null) return tools;
  return tools.flatMap(tool => {
    const descriptor = tool as { name: string; inputSchema?: { properties: Record<string, any> }; description?: string };
    if (descriptor.name === 'recall' && !hasTokenScope(scopes, 'tasks:read')) return [];
    if (descriptor.name === 'learn' && !hasTokenScope(scopes, 'knowledge:write')) return [];
    if (descriptor.name === 'buildd_memory') {
      const actions = memoryActions.filter(action => hasTokenScope(scopes, action === 'save' || action === 'update' ? 'knowledge:write' : 'tasks:read'));
      if (!actions.length) return [];
      return [{ ...descriptor, description: `Legacy knowledge tool. Actions: ${actions.join(', ')}`, inputSchema: {
        ...descriptor.inputSchema, properties: { ...descriptor.inputSchema!.properties,
          action: { type: 'string', enum: actions }, params: { type: 'object', description: buildMemoryDescription(actions) },
        },
      } }];
    }
    return [tool];
  });
}


/** Capability of the actual tool; unrelated arguments cannot change standalone permissions. */
export function requiredScopeForMcpTool(name: string, args?: Record<string, unknown>): TokenScope | null {
  if (name === 'recall') return 'tasks:read';
  if (name === 'learn') return 'knowledge:write';
  if (name === 'check_path_claim' || name === 'send_worker_message') return 'workers:write';
  const action = typeof args?.action === 'string' ? args.action : '';
  if (name === 'buildd_memory') return ['context', 'search', 'get', 'query_knowledge'].includes(action) ? 'tasks:read' : 'knowledge:write';
  if (name !== 'buildd' && !mcpGroupOfToolName(name)) return null;
  const params = args?.params && typeof args.params === 'object'
    ? args.params as Record<string, unknown>
    : Object.fromEntries(Object.entries(args ?? {}).filter(([key]) => key !== 'action' && key !== 'params'));
  return requiredScopeForAction(action, params);
}
