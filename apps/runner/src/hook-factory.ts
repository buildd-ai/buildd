import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { LocalWorker, Milestone, PermissionSuggestion } from './types';
import { DANGEROUS_PATTERNS, SENSITIVE_PATHS } from '@buildd/shared';
import { readFileSync } from 'fs';
import { saveWorker as storeSaveWorker } from './worker-store';
import type { BuilddClient } from './buildd';

/**
 * Dependencies that the hook factory needs from WorkerManager.
 * Passed as a context object to avoid coupling to the full class.
 */
export interface HookFactoryContext {
  config: {
    inputAsRetry?: boolean;
  };
  buildd: BuilddClient;
  addMilestone: (worker: LocalWorker, milestone: Milestone) => void;
  emit: (event: any) => void;
  pendingPermissionRequests: Map<string, {
    resolve: (result: any) => void;
    toolInput: Record<string, unknown>;
    suggestions: unknown[];
  }>;
}

/**
 * Factory that creates SDK hook callbacks for worker sessions.
 *
 * Extracted from WorkerManager to reduce file size and isolate hook logic.
 * Each method returns a HookCallback function that captures the worker
 * and context in its closure.
 */
export class HookFactory {
  constructor(private ctx: HookFactoryContext) {}

  createPermissionHook(worker: LocalWorker, opts?: { inputPolicy?: string }): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'PreToolUse') return {};

      const toolName = (input as any).tool_name;
      const toolInput = (input as any).tool_input as Record<string, unknown>;

      // Block AskUserQuestion when inputPolicy is 'autonomous' (default).
      // Prompt-level instruction alone is unreliable — enforce at hook level.
      if (toolName === 'AskUserQuestion'
          && (opts?.inputPolicy || 'autonomous') === 'autonomous'
          && this.ctx.config.inputAsRetry === false) {
        console.log(`[Worker ${worker.id}] Blocked AskUserQuestion (inputPolicy=autonomous)`);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            permissionDecisionReason: 'AskUserQuestion is not allowed in autonomous mode. Complete the task independently without asking the user questions. Make reasonable decisions and proceed.',
          },
        };
      }

      // Block dangerous bash commands
      if (toolName === 'Bash') {
        const command = (toolInput.command as string) || '';
        for (const pattern of DANGEROUS_PATTERNS) {
          if (pattern.test(command)) {
            console.log(`[Worker ${worker.id}] Blocked dangerous command: ${command.slice(0, 80)}`);
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse' as const,
                permissionDecision: 'deny' as const,
                permissionDecisionReason: 'Dangerous command blocked by safety policy',
              },
            };
          }
        }

        // Explicitly allow safe bash commands (prevents acceptEdits stall)
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'allow' as const,
            permissionDecisionReason: 'Allowed by buildd permission hook',
          },
        };
      }

      // Block writes to sensitive paths
      if (['Write', 'Edit', 'MultiEdit'].includes(toolName)) {
        const filePath = (toolInput.file_path as string) || (toolInput.filePath as string) || '';
        for (const pattern of SENSITIVE_PATHS) {
          if (pattern.test(filePath)) {
            console.log(`[Worker ${worker.id}] Blocked sensitive path write: ${filePath}`);
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse' as const,
                permissionDecision: 'deny' as const,
                permissionDecisionReason: `Cannot write to sensitive path: ${filePath}`,
              },
            };
          }
        }
      }

      // Allow all other tools by default (prevents acceptEdits stall —
      // no terminal exists for interactive approval)
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'allow' as const,
          permissionDecisionReason: 'Allowed by buildd permission hook',
        },
      };
    };
  }

  // Create a PostToolUse hook that captures team events (TeamCreate, SendMessage, Task).
  // Purely observational — returns {} and never blocks or modifies tool execution.
  createTeamTrackingHook(worker: LocalWorker): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'PostToolUse') return {};

      const toolName = (input as any).tool_name;
      const toolInput = (input as any).tool_input as Record<string, unknown>;

      if (toolName === 'TeamCreate') {
        const teamName = (toolInput.team_name as string) || 'unnamed';
        worker.teamState = {
          teamName,
          members: [],
          messages: [],
          createdAt: Date.now(),
        };
        this.ctx.addMilestone(worker, { type: 'status', label: `Team created: ${teamName}`, ts: Date.now() });
        console.log(`[Worker ${worker.id}] Team created: ${teamName}`);
      }

      if (toolName === 'SendMessage' && worker.teamState) {
        const msg = {
          from: (toolInput.sender as string) || 'leader',
          to: (toolInput.recipient as string) || (toolInput.type === 'broadcast' ? 'broadcast' : 'unknown'),
          content: (toolInput.content as string) || '',
          summary: (toolInput.summary as string) || undefined,
          timestamp: Date.now(),
        };
        worker.teamState.messages.push(msg);
        // Cap at 200 messages
        if (worker.teamState.messages.length > 200) {
          worker.teamState.messages.shift();
        }
        // Only emit milestone for broadcasts (avoid noise from DMs)
        if (toolInput.type === 'broadcast') {
          this.ctx.addMilestone(worker, { type: 'status', label: `Broadcast: ${msg.summary || msg.content.slice(0, 40)}`, ts: Date.now() });
        }
      }

      if (toolName === 'Task' && worker.teamState) {
        const agentName = (toolInput.name as string) || (toolInput.description as string) || 'subagent';
        const agentType = (toolInput.subagent_type as string) || undefined;
        worker.teamState.members.push({
          name: agentName,
          role: agentType,
          status: 'active',
          spawnedAt: Date.now(),
        });
        this.ctx.addMilestone(worker, { type: 'status', label: `Subagent: ${agentName}`, ts: Date.now() });
        console.log(`[Worker ${worker.id}] Subagent spawned: ${agentName}`);
      }

      return {};
    };
  }

  // Create a PostToolUseFailure hook that marks MCP calls as failed.
  // Purely observational — returns {} and never blocks or modifies tool execution.
  createMcpFailureHook(worker: LocalWorker): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'PostToolUseFailure') return {};

      const toolName = (input as any).tool_name as string;

      // Only care about MCP tool failures
      if (toolName?.startsWith('mcp__') && worker.pendingMcpCalls?.length) {
        // Find the last matching pending call and mark it as failed
        for (let i = worker.pendingMcpCalls.length - 1; i >= 0; i--) {
          const call = worker.pendingMcpCalls[i];
          const expectedPrefix = `mcp__${call.server}__`;
          if (toolName.startsWith(expectedPrefix) && call.ok) {
            call.ok = false;
            break;
          }
        }
      }

      return {};
    };
  }

  // Create a TeammateIdle hook that updates team member status when a teammate goes idle.
  // Purely observational — emits events for dashboard/Pusher visibility.
  createTeammateIdleHook(worker: LocalWorker): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'TeammateIdle') return {};

      const teammateName = (input as any).teammate_name as string;
      const teamName = (input as any).team_name as string;

      // Update team member status if we're tracking team state
      if (worker.teamState) {
        const member = worker.teamState.members.find(m => m.name === teammateName);
        if (member) {
          member.status = 'idle';
        }
      }

      this.ctx.addMilestone(worker, { type: 'status', label: `Teammate idle: ${teammateName}`, ts: Date.now() });
      console.log(`[Worker ${worker.id}] Teammate idle: ${teammateName} (team: ${teamName})`);

      return { async: true };
    };
  }

  // Create a PermissionRequest hook that blocks until the user approves or denies.
  // Displays tool_name, tool_input, and permission_suggestions in the worker detail UI.
  // Returns a decision (allow/deny) based on user input via resolvePermission().
  createPermissionRequestHook(worker: LocalWorker): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'PermissionRequest') return {};

      const toolName = (input as any).tool_name as string;
      const toolInput = (input as any).tool_input as Record<string, unknown>;
      const permissionSuggestions = (input as any).permission_suggestions as unknown[] | undefined;

      console.log(`[Worker ${worker.id}] Permission requested: ${toolName}, suggestions=${permissionSuggestions?.length || 0}`);

      // Build human-readable labels for each suggestion
      const suggestions: PermissionSuggestion[] = (permissionSuggestions || []).map((s: any) => {
        let label = '';
        if (s.type === 'addRules' || s.type === 'replaceRules') {
          const rules = (s.rules as Array<{ toolName: string; ruleContent?: string }>)?.map(
            r => r.ruleContent ? `${r.toolName}: ${r.ruleContent}` : r.toolName
          ) || [];
          label = `Allow ${rules.join(', ')}`;
        } else if (s.type === 'setMode') {
          label = `Switch to ${s.mode} mode`;
        } else if (s.type === 'addDirectories') {
          label = `Allow access to ${(s.directories as string[])?.join(', ') || 'directories'}`;
        } else {
          label = `${s.type}`;
        }
        return { type: s.type, label, raw: s };
      });

      // Build a descriptive prompt
      const cmdPreview = toolName === 'Bash'
        ? (toolInput.command as string)?.slice(0, 120) || ''
        : '';
      const prompt = cmdPreview
        ? `Permission required for ${toolName}: ${cmdPreview}`
        : `Permission required for ${toolName}`;

      // Set worker to waiting state
      worker.status = 'waiting';
      worker.waitingFor = {
        type: 'permission',
        prompt,
        toolName,
        toolInput,
        permissionSuggestions: suggestions,
        options: [
          { label: 'Allow once', description: 'Allow this single tool call' },
          ...(suggestions.length > 0 ? [{ label: 'Always allow', description: 'Apply suggested permission rules for the session' }] : []),
          { label: 'Deny', description: 'Block this tool call' },
        ],
      };
      worker.currentAction = `Permission: ${toolName}`;
      worker.hasNewActivity = true;
      worker.lastActivity = Date.now();
      this.ctx.addMilestone(worker, { type: 'status', label: `Permission: ${toolName}`, ts: Date.now() });

      // Sync to server and persist
      this.ctx.buildd.updateWorker(worker.id, {
        status: 'waiting_input',
        currentAction: worker.currentAction,
        waitingFor: {
          type: 'permission',
          prompt,
          options: worker.waitingFor.options?.map(o => typeof o === 'string' ? o : o.label),
        },
      }).catch(() => {});
      storeSaveWorker(worker);
      this.ctx.emit({ type: 'worker_update', worker });

      // Block the hook until the user resolves the permission decision
      return new Promise<any>((resolve) => {
        this.ctx.pendingPermissionRequests.set(worker.id, {
          resolve,
          toolInput,
          suggestions: permissionSuggestions || [],
        });
      });
    };
  }

  // Create a TaskCompleted hook that logs task completions within agent teams.
  // Emits milestones and updates team state for dashboard visibility.
  createTaskCompletedHook(worker: LocalWorker): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'TaskCompleted') return {};

      const taskId = (input as any).task_id as string;
      const taskSubject = (input as any).task_subject as string;
      const teammateName = (input as any).teammate_name as string | undefined;
      const teamName = (input as any).team_name as string | undefined;

      // Update team member status if completed by a known teammate
      if (worker.teamState && teammateName) {
        const member = worker.teamState.members.find(m => m.name === teammateName);
        if (member) {
          member.status = 'done';
        }
      }

      const label = teammateName
        ? `Task done (${teammateName}): ${taskSubject.slice(0, 50)}`
        : `Task done: ${taskSubject.slice(0, 50)}`;
      this.ctx.addMilestone(worker, { type: 'status', label, ts: Date.now() });
      console.log(`[Worker ${worker.id}] Task completed: ${taskSubject} (teammate: ${teammateName || 'leader'}, team: ${teamName || 'none'})`);

      return { async: true };
    };
  }

  // Create a SubagentStart hook that tracks subagent spawning.
  // Updates team state and emits milestones for dashboard visibility.
  createSubagentStartHook(worker: LocalWorker): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'SubagentStart') return {};

      const agentId = (input as any).agent_id as string;
      const agentType = (input as any).agent_type as string;

      // Update team member status if we're tracking team state
      if (worker.teamState) {
        const member = worker.teamState.members.find(m => m.name === agentId);
        if (member) {
          member.status = 'active';
        }
      }

      this.ctx.addMilestone(worker, { type: 'status', label: `Subagent started: ${agentType}`, ts: Date.now() });
      console.log(`[Worker ${worker.id}] Subagent started: ${agentType} (id: ${agentId})`);

      return { async: true };
    };
  }

  // Create a SubagentStop hook that tracks subagent completion.
  // Updates team state and emits milestones for dashboard visibility.
  createSubagentStopHook(worker: LocalWorker): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'SubagentStop') return {};

      const stopHookActive = (input as any).stop_hook_active as boolean;
      const lastAssistantMessage = (input as any).last_assistant_message as string | undefined;

      const label = lastAssistantMessage
        ? `Subagent: ${lastAssistantMessage.slice(0, 80)}${lastAssistantMessage.length > 80 ? '...' : ''}`
        : 'Subagent stopped';
      this.ctx.addMilestone(worker, { type: 'status', label, ts: Date.now() });
      console.log(`[Worker ${worker.id}] Subagent stopped (stop_hook_active: ${stopHookActive}, has_message: ${!!lastAssistantMessage})`);

      return { async: true };
    };
  }

  // Create a Stop hook that captures the last assistant message (v0.2.47+).
  // Used to generate prompt suggestions for follow-up actions after task completion.
  createStopHook(worker: LocalWorker): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'Stop') return {};

      const lastMessage = (input as any).last_assistant_message as string | undefined;
      if (lastMessage) {
        worker.lastAssistantMessage = lastMessage;
        // Generate prompt suggestions from the last message and task context
        worker.promptSuggestions = extractPromptSuggestions(worker, lastMessage);
        if (worker.promptSuggestions.length > 0) {
          console.log(`[Worker ${worker.id}] Generated ${worker.promptSuggestions.length} prompt suggestion(s)`);
        }
      }

      return { async: true };
    };
  }

  // Create a ConfigChange hook that logs config file changes (SDK v0.2.49+).
  // Emits milestones for audit trail and optionally blocks changes per workspace config.
  createConfigChangeHook(worker: LocalWorker, blockChanges: boolean): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'ConfigChange') return {};

      const filePath = (input as any).file_path as string;
      const changeType = (input as any).change_type as string;

      const label = blockChanges
        ? `Config change blocked: ${filePath}`
        : `Config changed: ${filePath} (${changeType})`;
      this.ctx.addMilestone(worker, { type: 'status', label, ts: Date.now() });
      console.log(`[Worker ${worker.id}] ConfigChange: ${filePath} (${changeType}, blocked=${blockChanges})`);

      if (blockChanges) {
        return { continue: false };
      }

      return { async: true };
    };
  }

  // Create a Notification hook that captures agent status messages.
  // Emits milestones for dashboard visibility and logs the notification.
  createNotificationHook(worker: LocalWorker): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'Notification') return {};

      const message = (input as any).message as string;
      const title = (input as any).title as string | undefined;

      const label = title
        ? `${title}: ${message.slice(0, 60)}`
        : message.slice(0, 80);
      this.ctx.addMilestone(worker, { type: 'status', label, ts: Date.now() });
      console.log(`[Worker ${worker.id}] Notification: ${title ? `[${title}] ` : ''}${message}`);

      return { async: true };
    };
  }

  // Create a PreCompact hook that archives the full transcript before context compaction.
  // This preserves worker reasoning history that would otherwise be lost during compaction.
  createPreCompactHook(worker: LocalWorker): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'PreCompact') return {};

      const transcriptPath = (input as any).transcript_path as string | undefined;
      const trigger = (input as any).trigger as 'manual' | 'auto' | undefined;

      if (!transcriptPath) return {};

      try {
        const transcript = readFileSync(transcriptPath, 'utf-8');
        this.ctx.addMilestone(worker, { type: 'status', label: `Transcript archived (${trigger || 'auto'} compaction)`, ts: Date.now() });
        this.ctx.emit({
          type: 'transcript_archived',
          worker,
          data: {
            trigger: trigger || 'auto',
            transcriptPath,
            transcript,
          },
        });
        console.log(`[Worker ${worker.id}] Transcript archived before ${trigger || 'auto'} compaction (${transcript.length} chars)`);
      } catch {
        // Transcript file may not exist or be unreadable — non-fatal
      }
      return {};
    };
  }
}

// Extract prompt suggestions from the last assistant message and task context.
// Heuristic: look for actionable follow-up patterns in the final message.
export function extractPromptSuggestions(worker: LocalWorker, lastMessage: string): string[] {
  const suggestions: string[] = [];

  // Check for common follow-up patterns in the last message
  const hasCommits = worker.commits.length > 0;
  const hasPR = lastMessage.toLowerCase().includes('pull request') || lastMessage.toLowerCase().includes('pr ');
  const hasTests = lastMessage.toLowerCase().includes('test');
  const hasBuild = lastMessage.toLowerCase().includes('build');

  // If there are commits but no PR mentioned, suggest creating one
  if (hasCommits && !hasPR) {
    suggestions.push('Create a pull request for these changes');
  }

  // If code was changed, suggest running tests
  if (hasCommits && !hasTests) {
    suggestions.push('Run the test suite to verify changes');
  }

  // If tests were mentioned but not build, suggest build verification
  if (hasTests && !hasBuild) {
    suggestions.push('Run the build to check for errors');
  }

  // Look for explicit "next steps" or "you might want to" patterns
  const nextStepPatterns = [
    /(?:next steps?|you (?:can|could|might|may|should) (?:also |want to )?|consider |try |to follow up)[:\-]?\s*(.{10,80})/gi,
    /(?:TODO|FIXME|NOTE)[:\s]+(.{10,80})/gi,
  ];

  for (const pattern of nextStepPatterns) {
    let match;
    while ((match = pattern.exec(lastMessage)) !== null) {
      const suggestion = match[1].trim().replace(/[.!,;]+$/, '');
      if (suggestion.length >= 10 && suggestion.length <= 80) {
        suggestions.push(suggestion);
      }
      if (suggestions.length >= 5) break;
    }
    if (suggestions.length >= 5) break;
  }

  // Deduplicate and limit to 5 suggestions
  return [...new Set(suggestions)].slice(0, 5);
}
