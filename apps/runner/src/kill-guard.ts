/**
 * Keeps an agent's process kills inside its own process tree.
 *
 * The runner is a bun process. Agents start bun, node and git children of
 * their own, and when one hangs the obvious way to stop it is by name:
 * `Get-Process bun,git | Stop-Process -Force`, `taskkill /IM bun.exe /F`,
 * `pkill bun`. Those reach every process of that name the user owns: the
 * runner, its launcher, and every other agent's tools. On a Windows host there
 * is no pid namespace to stop them (bwrap is Linux only), and on 2026-10-23 one
 * such call killed the runner mid-session and stranded its worker.
 *
 * So the PreToolUse hook refuses, for the Bash and PowerShell tools:
 *  - any kill that selects processes by name when the name is one the runner
 *    or its agents run as (PROTECTED_PROCESS_NAMES), and `Get-Process |
 *    Stop-Process` with no selector at all;
 *  - any kill that names the runner's own pid or its launcher's.
 * A kill by the pid the agent recorded when it started the process is allowed.
 *
 * This is a guard on what an agent asks for, not a sandbox: a determined
 * command can still find the runner. It closes the path agents actually take.
 */

/** Image names the runner, its launcher and agents' own tools run as. */
export const PROTECTED_PROCESS_NAMES = ['bun', 'node', 'git', 'claude', 'codex', 'buildd'] as const;

/** Shells whose commands the guard reads. */
export const KILL_GUARDED_TOOLS = new Set(['Bash', 'PowerShell']);

const KILL_VERB = /\b(?:stop-process|spps|taskkill|pkill|killall|kill|terminate)\b|\.kill\s*\(|invoke-cimmethod/i;
const PROTECTED_NAME = new RegExp(
  `(?:^|[\\s,'"(=/\\\\])(?:${PROTECTED_PROCESS_NAMES.join('|')})(?:\\.exe)?\\*?(?=$|[\\s,'")|;])`,
  'i',
);
/** `Get-Process | Stop-Process`, `gps * | kill`: every process the user owns. */
const KILL_EVERYTHING = /\b(?:get-process|gps)\s*(?:\*\s*)?\|/i;

export interface KillVerdict {
  reason: string;
  hint: string;
}

/**
 * Why `command` would kill outside the agent's own tree, or null when it
 * would not. `runnerPids` are the runner's own pid and its launcher's.
 */
export function findRunnerKill(command: string, runnerPids: readonly number[]): KillVerdict | null {
  if (!command || !KILL_VERB.test(command)) return null;
  const pids = new Set(runnerPids.filter(p => Number.isInteger(p) && p > 1));
  // One statement at a time, so `bun run x & kill $!` is two statements and
  // only the second is a kill. A pipeline stays whole: it is one selection.
  for (const statement of command.split(/&&|\|\||;|&|\r?\n/)) {
    if (!KILL_VERB.test(statement)) continue;
    for (const n of statement.match(/\b\d+\b/g) ?? []) {
      if (pids.has(Number(n))) {
        return {
          reason: `this command would kill the buildd runner's own process (pid ${n}), which ends every agent on this machine, including you`,
          hint: 'stop only the processes you started, by the pid you recorded when you started them',
        };
      }
    }
    const name = statement.match(PROTECTED_NAME);
    if (name || KILL_EVERYTHING.test(statement)) {
      const what = name ? `processes by name (${name[0].trim().replace(/^['"(=/\\,]+/, '')})` : 'every process you own';
      return {
        reason: `this command kills ${what}. The buildd runner and the other agents on this machine run as bun, node and git too, so a kill by name ends them as well, including your own session`,
        hint: 'stop only the processes you started, by the pid you recorded when you started them (PowerShell: `$p = Start-Process ... -PassThru` then `Stop-Process -Id $p.Id`; Bash: `cmd & pid=$!` then `kill $pid`). To find a pid, list processes without killing (`Get-Process bun | Select-Object Id,StartTime,CommandLine`) and kill that Id',
      };
    }
  }
  return null;
}

/** The runner's own pid and the launcher's, the pids no agent may kill. */
export function runnerProcessIds(): number[] {
  return [process.pid, process.ppid];
}
