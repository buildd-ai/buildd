/**
 * Tool descriptors advertised by the remote MCP server (ListTools).
 *
 * Pure data. `listMcpTools` is a function of its gating inputs only — the
 * caller's token level and whether the workspace is data-class `sensitive` —
 * so the visibility rules below can be asserted directly, without standing up
 * a server or issuing a request.
 *
 * Invariants encoded here:
 * - Every token level sees the `buildd` tool; the action list inside its schema
 *   is narrowed to the actions that level may call.
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

export type McpAccountLevel = 'trigger' | 'worker' | 'admin';

export interface ListMcpToolsOptions {
  accountLevel: McpAccountLevel;
  /** Workspace data class is `sensitive` (fail-closed when unknown). */
  isSensitive: boolean;
}

/** Actions exposed in the `buildd` tool schema for a given token level. */
export function actionsForLevel(accountLevel: McpAccountLevel): string[] {
  return accountLevel === 'admin'
    ? [...allActionsList]
    : accountLevel === 'trigger'
    ? [...triggerActions]
    : [...workerActions];
}

export function listMcpTools({ accountLevel, isSensitive }: ListMcpToolsOptions): object[] {
  const filteredActions = actionsForLevel(accountLevel);

  const tools: object[] = [
    {
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
    },
  ];

  // check_path_claim is available to worker and admin tokens (not trigger-only tokens).
  // Trigger tokens don't run agent work so they never need mid-task path expansion.
  if (accountLevel === 'worker' || accountLevel === 'admin') {
    tools.push({
      name: "check_path_claim",
      description: `Mid-task path-claim check. Call this when you discover you need to touch a file outside your declared pathManifest.

If the path is unclaimed by any active sibling task, your task's pathManifest is atomically extended and you can proceed.
If the path is already claimed by a sibling task, you receive blockingTaskId and must report blocked so a dependsOn edge can be added.

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
            description: "File paths (or directory prefixes) you need to claim. Non-empty array of strings.",
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
      description: `Send a structured message to another active task worker in the same workspace.

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
            description: "Hop count for forwarded messages (0-based). Omit for new messages. Messages with hopCount >= 5 are dropped to prevent loops.",
          },
        },
        required: ["recipientTaskId", "type", "body"],
      },
    });
  }

  if (!isSensitive) {
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
