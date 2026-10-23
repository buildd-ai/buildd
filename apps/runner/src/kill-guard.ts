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
 * Only a kill is judged. A statement is a kill when its command word, or the
 * command word of a segment it pipes into, is a kill command. Quoted text is
 * never a command word, so `git commit -m "fix: kill stale lock"` is a git
 * call, not a kill.
 *
 * This is a guard on what an agent asks for, not a sandbox: a determined
 * command can still find the runner (`wmic process ... delete`, a script file
 * that kills by name, a CIM pipeline split across statements). It closes the
 * path agents actually take.
 */

/** Image names the runner, its launcher and agents' own tools run as. */
export const PROTECTED_PROCESS_NAMES = ['bun', 'node', 'git', 'claude', 'codex', 'buildd'] as const;

/** Shells whose commands the guard reads. */
export const KILL_GUARDED_TOOLS = new Set(['Bash', 'PowerShell']);

/** Command words that kill, after stripping a path and `.exe`. `kill` is also PowerShell's alias for Stop-Process. */
const KILL_COMMANDS = new Set(['stop-process', 'spps', 'taskkill', 'pkill', 'killall', 'kill']);
/** Words that run the command after them: `xargs -r kill -9`, `env X=1 pkill bun`. */
const WRAPPERS = new Set(['sudo', 'doas', 'xargs', 'env', 'nohup', 'command', 'exec', 'nice', '&']);
/** Selectors that, with no argument, pick every process the user owns. */
const PROCESS_LISTERS = new Set(['get-process', 'gps']);
/** A protected name as a word of an argument: `bun`, `bun.exe`, `bun*`, `-Name=bun`, `Name='bun.exe'`. */
const PROTECTED_NAME = new RegExp(
  `(?:^|[^a-z0-9_.-])(${PROTECTED_PROCESS_NAMES.join('|')})(?:\\.exe)?\\*?(?=$|[^a-z0-9_.-])`,
  'i',
);

export interface KillVerdict {
  reason: string;
  hint: string;
}

interface Token {
  text: string;
  quoted: boolean;
}

/**
 * Statements, each a pipeline of segments, each a list of words. Operators
 * inside quotes are text, so `git commit -m "a; kill b"` stays one statement
 * whose command word is `git`. `2>&1` and `&>` are redirections, not `&`.
 */
function parse(command: string): Token[][][] {
  const statements: Token[][][] = [];
  let pipeline: Token[][] = [];
  let segment: Token[] = [];
  let word = '';
  let quotedWord = false;
  let inWord = false;
  const endWord = () => {
    if (inWord) segment.push({ text: word, quoted: quotedWord });
    word = '';
    quotedWord = false;
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (segment.length) pipeline.push(segment);
    segment = [];
  };
  const endStatement = () => {
    endSegment();
    if (pipeline.length) statements.push(pipeline);
    pipeline = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '"' || c === "'") {
      const close = command.indexOf(c, i + 1);
      const stop = close === -1 ? command.length : close;
      word += command.slice(i + 1, stop);
      quotedWord = true;
      inWord = true;
      i = stop;
    } else if (c === '\n' || c === '\r' || c === ';') {
      endStatement();
    } else if (c === '&') {
      if (command[i - 1] === '>' || command[i + 1] === '>') {
        word += c;
        inWord = true;
      } else {
        if (command[i + 1] === '&') i++;
        endStatement();
      }
    } else if (c === '|') {
      if (command[i + 1] === '|') {
        i++;
        endStatement();
      } else {
        endSegment();
      }
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  endStatement();
  return statements;
}

/** `C:\Windows\System32\taskkill.exe` → `taskkill`. */
function commandName(token: Token): string {
  return token.text.toLowerCase().replace(/^.*[\\/]/, '').replace(/\.exe$/, '');
}

/** The command word's index in a segment, past wrappers, their flags and `VAR=value`. */
function commandIndex(segment: Token[]): number {
  let i = 0;
  while (i < segment.length) {
    const t = segment[i];
    if (!t.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t.text)) i++;
    else if (!t.quoted && WRAPPERS.has(commandName(t))) {
      i++;
      while (i < segment.length && !segment[i].quoted && segment[i].text.startsWith('-')) i++;
    } else break;
  }
  return i;
}

/** A segment's arguments: everything after its command word. */
function argsOf(segment: Token[]): Token[] {
  return segment.slice(commandIndex(segment) + 1);
}

/**
 * The words a kill in this segment acts on, or null when the segment is not
 * a kill: a kill command as the command word, `Invoke-CimMethod ...
 * Terminate`, or an unquoted `.Kill()` call such as `(Get-Process bun).Kill()`.
 */
function killArgs(segment: Token[]): Token[] | null {
  const at = commandIndex(segment);
  if (at >= segment.length) return null;
  const name = commandName(segment[at]);
  const args = segment.slice(at + 1);
  if (KILL_COMMANDS.has(name)) return args;
  if (name === 'invoke-cimmethod' && args.some(t => /^terminate$/i.test(t.text))) return args;
  if (segment.some(t => !t.quoted && /\.kill\s*\(/i.test(t.text))) return segment;
  return null;
}

function protectedNameIn(tokens: Token[]): string | null {
  for (const t of tokens) {
    const m = t.text.match(PROTECTED_NAME);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/**
 * Why `command` would kill outside the agent's own tree, or null when it
 * would not. `runnerPids` are the runner's own pid and its launcher's.
 *
 * What the kill selects is read from its own arguments (`-Name`, `/IM`, `/FI`,
 * a `pkill -f` pattern, a pid) and from the arguments of the segments piped
 * into it (`Get-Process bun |`, `grep bun | xargs kill`). A protected name that
 * only starts the statement (`bun test -t terminate`) selects nothing.
 */
export function findRunnerKill(command: string, runnerPids: readonly number[]): KillVerdict | null {
  if (!command) return null;
  const pids = new Set(runnerPids.filter(p => Number.isInteger(p) && p > 1));
  for (const pipeline of parse(command)) {
    const killAt = pipeline.findIndex(segment => killArgs(segment) !== null);
    if (killAt === -1) continue;
    const upstream = pipeline.slice(0, killAt);
    const targets = [...upstream.flatMap(argsOf), ...killArgs(pipeline[killAt])!];
    for (const t of targets) {
      for (const n of t.text.split(',')) {
        if (/^\d+$/.test(n) && pids.has(Number(n))) {
          return {
            reason: `this command would kill the buildd runner's own process (pid ${n}), which ends every agent on this machine, including you`,
            hint: 'stop only the processes you started, by the pid you recorded when you started them',
          };
        }
      }
    }
    const name = protectedNameIn(targets);
    const everything = upstream.some(segment => {
      const at = commandIndex(segment);
      return at < segment.length
        && PROCESS_LISTERS.has(commandName(segment[at]))
        && argsOf(segment).every(t => t.text === '*');
    });
    if (name || everything) {
      const what = name ? `processes by name (${name})` : 'every process you own';
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
