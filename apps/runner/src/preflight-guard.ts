/**
 * Runner preflight (docs/specs/workflow-state-kernel.md §6.10 tier 2, S31).
 *
 * Failures of rules known before CI runs (the production-data scan, ratchet and
 * drift tests, lint ratchets) are the largest avoidable class of red CI. A
 * workspace lists the cheap commands for them in `gitConfig.preflight.commands`
 * (default none); this PreToolUse guard runs them in the worktree before a
 * push or `create_pr`. A failure denies that one call with the command's output
 * as the agent's next instruction, so the attempt stays open (WORKING/FIXING)
 * and fixes it before anything ships.
 *
 * Advisory, as the spec requires: a command that cannot run (not found,
 * timed out) lets the ship through with a milestone saying so, and CI remains
 * the backstop. A head that already passed is not re-checked.
 */
import { execFileSync } from 'child_process';
import { isBuilddActionTool } from '@buildd/shared';
import { denyPreToolUse } from './hook-factory';
import { isShipCommand } from './path-claim-enforcement';
import { runnerDenial } from './runner-denial';
import { runVerificationCommand } from './runner-verification';

export interface PreflightRun {
  outcome: 'ok' | 'failed' | 'timeout' | 'exec_error';
  exitCode: number | null;
  output: string;
}

/** Shell exit 127: the command was not found. That is "could not run", not a failed check. */
const NOT_FOUND_EXIT = 127;
const OUTPUT_TAIL_CHARS = 2_000;
export const PREFLIGHT_COMMAND_TIMEOUT_MS = 120_000;

export function preflightCommands(gitConfig: { preflight?: { commands?: unknown } | null } | null | undefined): string[] {
  const raw = gitConfig?.preflight?.commands;
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is string => typeof c === 'string').map((c) => c.trim()).filter(Boolean);
}

export async function runPreflightCommand(command: string, cwd: string): Promise<PreflightRun> {
  const ev = await runVerificationCommand({ workerId: 'preflight', iteration: 0, command, cwd, timeoutMs: PREFLIGHT_COMMAND_TIMEOUT_MS });
  return {
    outcome: ev.outcome,
    exitCode: ev.exitCode ?? null,
    output: [ev.stdout, ev.stderr].filter(Boolean).join('\n'),
  };
}

function gitHead(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf-8', timeout: 5_000 }).trim() || null;
  } catch {
    return null;
  }
}

function tail(text: string): string {
  const t = text.trim();
  return t.length <= OUTPUT_TAIL_CHARS ? t : `…${t.slice(-OUTPUT_TAIL_CHARS)}`;
}

/** The ship calls preflight guards: `git push`, `gh pr create`, buildd `create_pr`. */
function isShip(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (toolName === 'Bash') return isShipCommand(toolInput.command);
  return isBuilddActionTool(toolName) && toolInput.action === 'create_pr';
}

export function createPreflightGuard(deps: {
  commands: string[];
  cwd: string;
  run?: (command: string, cwd: string) => Promise<PreflightRun>;
  headSha?: (cwd: string) => string | null;
  milestone?: (label: string) => void;
}) {
  const run = deps.run ?? runPreflightCommand;
  const headSha = deps.headSha ?? gitHead;
  let passedHead: string | null = null;

  return async (input: unknown): Promise<Record<string, unknown>> => {
    const i = (input ?? {}) as { hook_event_name?: string; tool_name?: string; tool_input?: Record<string, unknown> };
    if (i.hook_event_name !== 'PreToolUse') return {};
    if (!isShip(i.tool_name ?? '', i.tool_input ?? {})) return {};
    if (deps.commands.length === 0) return {};

    const head = headSha(deps.cwd);
    if (head && head === passedHead) return {};

    for (const command of deps.commands) {
      const r = await run(command, deps.cwd);
      if (r.outcome === 'ok') continue;
      if (r.outcome === 'failed' && r.exitCode !== NOT_FOUND_EXIT) {
        deps.milestone?.(`Preflight failed: ${command} (exit ${r.exitCode ?? '?'})`);
        return denyPreToolUse(runnerDenial(
          `this workspace's preflight check \`${command}\` failed (exit ${r.exitCode ?? '?'}) — CI runs the same rule and would fail. Output:\n${tail(r.output)}`,
          'fix what it reports, commit, and push or open the PR again',
        ));
      }
      // Advisory: a check that could not run never blocks a ship.
      deps.milestone?.(`Preflight ${command} could not run (${r.outcome === 'failed' ? 'not found' : r.outcome}) — shipping anyway; CI still checks`);
    }
    passedHead = head;
    return {};
  };
}

/**
 * The PreToolUse entry the session registers, or none: off unless the
 * workspace lists commands, and never for Codex (it has no PreToolUse seam).
 * The timeout covers every command's own budget plus headroom, because the
 * SDK's default hook timeout would cut a full run short.
 */
export function preflightHookEntries(p: {
  gitConfig: { preflight?: { commands?: unknown } | null } | null | undefined;
  isCodexTask: boolean;
  cwd: string;
  milestone?: (label: string) => void;
}): Array<{ timeout: number; hooks: Array<ReturnType<typeof createPreflightGuard>> }> {
  const commands = preflightCommands(p.gitConfig);
  if (p.isCodexTask || commands.length === 0) return [];
  return [{
    timeout: Math.ceil((PREFLIGHT_COMMAND_TIMEOUT_MS * commands.length) / 1000) + 15,
    hooks: [createPreflightGuard({ commands, cwd: p.cwd, milestone: p.milestone })],
  }];
}
