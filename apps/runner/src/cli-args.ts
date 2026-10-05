/**
 * What `buildd <args>` means, decided before the runner starts anything.
 *
 * `buildd --help` used to start the runner, and so did any typo'd flag: index.ts
 * only ever looked for the flags it knew and ignored the rest. Help and unknown
 * arguments are now answered here and never reach the runner.
 *
 * The launcher (install.sh) handles its own subcommands (init, install, login,
 * logout, status, service) before the runner is invoked; everything else
 * arrives here.
 */

/** sysexits EX_USAGE, the same code `--once` uses for a bad invocation. */
export const EXIT_CLI_USAGE = 64;

export const RUNNER_USAGE = [
  'Usage: buildd [command] [options]',
  '',
  'Commands:',
  '  buildd                     Start the runner in the foreground',
  '  buildd login [--device]    Sign in and save an API key to ~/.buildd/config.json',
  '  buildd logout              Remove the saved API key',
  '  buildd status              Show whether you are signed in',
  '  buildd service <cmd>       Run in the background: install | status | logs | uninstall',
  '  buildd init <workspace-id> Write .mcp.json for this repo',
  '  buildd install --global    Register the buildd MCP server for Claude Code',
  '  buildd env verify [--json] Check that the current repo is runnable',
  '  buildd help                Show this help',
  '',
  'Options:',
  '  --debug                    Serve the local UI at http://localhost:8766',
  '  --once --task <task-id>    Run one task and exit',
  '  --doctor [--fix]           Diagnose (and repair) the install',
  '  --version                  Print the runner version',
  '  -h, --help                 Show this help',
  '',
  'Configuration comes from ~/.buildd/config.json and variables exported in your',
  'shell or service (BUILDD_API_KEY, BUILDD_SERVER, PROJECTS_ROOT, PORT).',
  'A .env file in the current folder is never read.',
].join('\n');

const HELP = new Set(['--help', '-h', 'help']);
/** Flags that stand alone. */
const BOOLEAN_FLAGS = new Set(['--debug', '--version', '--doctor', '--fix', '--env-verify', '--json', '--once']);
/** Flags that take the next argument (or `=value`) as their value. */
const VALUE_FLAGS = new Set(['--task', '--resume-worker', '--park-orphan']);
/** Positional subcommands the runner itself understands, as word sequences. */
const SUBCOMMANDS: string[][] = [['version'], ['env', 'verify']];

export type CliDecision =
  | { kind: 'help' }
  | { kind: 'run' }
  | { kind: 'unknown'; arg: string };

export function classifyCliArgs(argv: string[]): CliDecision {
  const args = argv.slice(2);
  if (args.some(a => HELP.has(a))) return { kind: 'help' };

  let i = 0;
  // A subcommand may only lead.
  const sub = SUBCOMMANDS.find(words => words.every((w, j) => args[j] === w));
  if (sub) i = sub.length;

  for (; i < args.length; i++) {
    const a = args[i];
    if (BOOLEAN_FLAGS.has(a)) continue;
    if (VALUE_FLAGS.has(a)) {
      // Missing/flag-shaped values are parseOnceArgs' error to report.
      if (args[i + 1] !== undefined && !args[i + 1].startsWith('-')) i++;
      continue;
    }
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0 && VALUE_FLAGS.has(a.slice(0, eq))) continue;
    return { kind: 'unknown', arg: a };
  }
  return { kind: 'run' };
}
