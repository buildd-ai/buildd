/**
 * The runner's fixed rules for local tool calls (Bash, Read, Write, Edit …),
 * applied the same way on every path a call can take:
 *
 *  - PreToolUse (createPermissionHook): every call, main agent and subagents.
 *    A call these rules name is refused; every other call is allowed.
 *  - PermissionRequest: the agent SDK's own safety checks still want a person
 *    after that (a path outside the working directory, a repo `ask` rule).
 *  - canUseTool for a background subagent: its would-be permission prompt.
 *
 * The last two used to ask whoever was watching ("Allow once / Always allow /
 * Deny"), in a channel no spec defines: unrecorded, outside team policy, and
 * "Always allow" rewrote the session's settings. They are refused now, with a
 * reason and a way on. Access a run lacks is asked for through buildd
 * (AskUserQuestion; request_capability for a provider), never granted by a click
 * on one machine. BUILDD_PERMISSION_PROMPTS=ask restores the old prompt.
 */
import {
  DANGEROUS_PATTERNS,
  DANGEROUS_CREDENTIAL_READ_PATTERNS,
  OWNER_ONLY_GITHUB_COMMAND_PATTERNS,
  SENSITIVE_PATHS,
  SENSITIVE_READ_PATHS,
} from '@buildd/shared';
import { findRunnerKill, KILL_GUARDED_TOOLS, runnerProcessIds } from './kill-guard.js';
import { runnerDenial } from './runner-denial.js';

export type PermissionPromptMode = 'policy' | 'ask';

export function permissionPromptMode(env: Record<string, string | undefined> = process.env): PermissionPromptMode {
  return env.BUILDD_PERMISSION_PROMPTS === 'ask' ? 'ask' : 'policy';
}

/**
 * The refusal for a call the rules name, or null when they have nothing
 * against it. `pids` are the runner's own processes, for the kill guard.
 */
export function localPolicyDenial(
  toolName: string,
  toolInput: Record<string, unknown>,
  pids: number[] = runnerProcessIds(),
): string | null {
  if (KILL_GUARDED_TOOLS.has(toolName)) {
    const kill = findRunnerKill((toolInput.command as string) || '', pids);
    if (kill) return runnerDenial(kill.reason, kill.hint);
  }

  if (toolName === 'Bash') {
    const command = (toolInput.command as string) || '';
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        return runnerDenial(
          `this Bash command matches the destructive-command rule ${pattern}`,
          'use a narrower command that does the same job (for example delete a specific path inside your worktree, or reset one file), or skip the step if the task does not need it',
        );
      }
    }
    for (const pattern of DANGEROUS_CREDENTIAL_READ_PATTERNS) {
      if (pattern.test(command)) {
        return runnerDenial(
          'reading the runner\'s own credential files is blocked',
          'use the credentials already provided to you through your environment and MCP tools',
        );
      }
    }
    for (const pattern of OWNER_ONLY_GITHUB_COMMAND_PATTERNS) {
      if (pattern.test(command)) {
        return runnerDenial(
          'dispatching the Release workflow is an owner action, and from here GitHub would record it as the owner',
          'buildd amends a release candidate by itself when its fix PR merges; if a release really is needed, ask for it with buildd action=post_note or use the trigger_release action',
        );
      }
    }
    return null;
  }

  if (toolName === 'Read') {
    const filePath = (toolInput.file_path as string) || '';
    for (const pattern of SENSITIVE_READ_PATHS) {
      if (pattern.test(filePath)) {
        return runnerDenial(
          `reading the runner's own credential files is blocked (${filePath})`,
          'use the credentials already provided to you through your environment and MCP tools',
        );
      }
    }
  }

  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
    const filePath = (toolInput.file_path as string) || (toolInput.filePath as string) || '';
    for (const pattern of SENSITIVE_PATHS) {
      if (pattern.test(filePath)) {
        return runnerDenial(
          `writes to ${filePath} are blocked because it is a sensitive path`,
          'leave that file unchanged; if the task genuinely needs it changed, say so in your complete_task summary',
        );
      }
    }
  }

  return null;
}

/**
 * The refusal for a call the agent SDK still wanted a person for, after the
 * rules allowed it: the run's policy does not give it this access, and no
 * one approves tool calls one by one here.
 */
export function outsidePolicyDenial(toolName: string, subject?: string): string {
  const what = subject ? `${toolName} (${subject.slice(0, 120)})` : toolName;
  return runnerDenial(
    `${what} needs access this run's policy does not give it. The agent SDK asked for a person to approve it, and tool calls here are decided by policy, not approved one at a time`,
    'keep the work inside your own worktree and the tools you already have; if the task truly cannot be done without this, ask with AskUserQuestion, saying exactly what access you need and why',
  );
}

/** What a refused call was about, for the reason text: a command or a path. */
export function callSubject(toolName: string, toolInput: Record<string, unknown>): string | undefined {
  if (toolName === 'Bash' && typeof toolInput.command === 'string') return toolInput.command;
  const path = toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path;
  return typeof path === 'string' ? path : undefined;
}
