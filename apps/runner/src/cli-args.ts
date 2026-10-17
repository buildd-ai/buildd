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
  '  buildd top                 Watch the runner on this machine and act on its work',
  '                             (--mission <id> opens on one mission, --workspace <name or id>',
  '                             on one workspace, --team <name> on one team; t switches team,',
  '                             w switches workspace, ? shows the keys)',
  '  buildd login [--device]    Sign in and save an API key to ~/.buildd/config.json',
  '  buildd login --workspaces  Choose which workspaces this runner serves; the key stays the same',
  '  buildd logout              Remove the saved API key',
  '  buildd status              Show whether you are signed in',
  '  buildd service <cmd>       Run in the background: install | status | logs | uninstall',
  '  buildd init <workspace-id> Write .mcp.json for this repo',
  '  buildd install --global    Register the buildd MCP server for your workspace folders only,',
  '                             plus session presence hooks for Claude Code / Codex / Cursor',
  '  buildd install --here      Register the buildd MCP server for this folder (any repo)',
  '  buildd install --global --everywhere   Register it for every Claude Code session',
  '  buildd install --global --oauth        Same, but with no key on disk: you sign in in the browser,',
  '                             and the connection acts as you',
  '  buildd install --global --as-agent     The same sign-in, but the connection acts as your agent,',
  '                             not as you (for a shared or remote machine)',
  '  buildd install [--global] --status|--uninstall   Inspect or remove those hooks',
  '  buildd env verify [--json] Check that the current repo is runnable',
  '  buildd name [<name>]       Name this runner on the dashboard (the hostname by default);',
  '                             with no name, print it and where it comes from. --clear removes it',
  '  buildd hold [--for <time>] Stop this runner taking new work; running agents finish',
  '                             (--for 2h or 30m resumes on its own; h in buildd top does the same)',
  '  buildd resume              Let this runner take new work again',
  '  buildd stop [--yes]        Pause every running agent and hold this runner (asks first);',
  '                             buildd resume continues them. --abort ends them instead',
  '  buildd slots [<n>]         How many agents run at once (+ and - in buildd top); with no n,',
  '                             print it. Lowering lets the extras finish; --pause pauses the',
  '                             newest extras instead, --abort ends them (asks first)',
  '  buildd web                 Open the runner on this machine in your browser',
  '  buildd help                Show this help',
  '',
  'Options:',
  '  --debug                    Serve the local UI at http://localhost:8766',
  '  --foreground               Run in this terminal (refused while the background runner runs)',
  '  --once --task <task-id>    Run one task and exit',
  '  --doctor [--fix]           Diagnose (and repair) the install',
  '  --version                  Print the runner version',
  '  -h, --help                 Show this help',
  '',
  'Configuration comes from ~/.buildd/config.json and variables exported in your',
  'shell or service (BUILDD_API_KEY, BUILDD_SERVER, BUILDD_RUNNER_NAME, PROJECTS_ROOT, PORT).',
  'A .env file in the current folder is never read.',
].join('\n');

const HELP = new Set(['--help', '-h', 'help']);
/** Flags that stand alone. */
const BOOLEAN_FLAGS = new Set(['--debug', '--foreground', '--version', '--doctor', '--fix', '--env-verify', '--json', '--once']);
/** Flags that take the next argument (or `=value`) as their value. */
const VALUE_FLAGS = new Set(['--task', '--resume-worker', '--park-orphan', '--attach-orphan']);
/** Positional subcommands the runner itself understands, as word sequences. */
const SUBCOMMANDS: string[][] = [['version'], ['env', 'verify']];

/** What `buildd slots` does with the agents a lower N makes extra (runner-slots.ts). */
export type ExtrasMode = 'finish' | 'pause' | 'abort';
export type SlotsCommand = { kind: 'show' } | { kind: 'set'; raw: string; mode: ExtrasMode; yes: boolean };

/** `buildd slots …` arguments, after `slots`. */
export function classifySlotsArgs(args: string[]): SlotsCommand | { kind: 'unknown'; arg: string } {
  let raw: string | null = null;
  let mode: ExtrasMode = 'finish';
  let yes = false;
  for (const a of args) {
    if (a === '--pause' || a === '--abort') {
      if (mode !== 'finish') return { kind: 'unknown', arg: a };
      mode = a === '--pause' ? 'pause' : 'abort';
      continue;
    }
    if (a === '--yes' || a === '-y') { yes = true; continue; }
    if (a.startsWith('-') || raw !== null) return { kind: 'unknown', arg: a };
    raw = a;
  }
  if (raw === null) return mode === 'finish' && !yes ? { kind: 'show' } : { kind: 'unknown', arg: mode !== 'finish' ? `--${mode}` : '--yes' };
  return { kind: 'set', raw, mode, yes };
}

export type CliDecision =
  | { kind: 'help' }
  /** `buildd name [<name>|--clear]` (runner-name.ts); `args` are the words after `name`. */
  | { kind: 'name'; args: string[] }
  /** `buildd hold [--for <time>]` (runner-hold.ts); `forArg` is checked there. */
  | { kind: 'hold'; forArg: string | null }
  /** `buildd resume` (runner-hold.ts). */
  | { kind: 'resume' }
  /** `buildd stop [--abort] [--yes|-y]` (runner-hold.ts runStopCommand). */
  | { kind: 'stop'; yes: boolean; abort: boolean }
  /** `buildd slots [<n>] [--pause|--abort] [--yes]` (runner-slots.ts). */
  | { kind: 'slots'; cmd: SlotsCommand }
  /** `buildd web`: open the running runner's local web UI (runner-web.ts). */
  | { kind: 'web' }
  | { kind: 'run' }
  | { kind: 'top'; missionId: string | null; workspace: string | null; team: string | null; frame?: { view: 'missions' | 'queue'; cols: number; rows: number } }
  | { kind: 'unknown'; arg: string };

/** `buildd top [--mission <id>] [--workspace <name or id>] [--team <name>]`: its own small grammar, nothing else is accepted. */
function classifyTop(args: string[]): CliDecision {
  const values: Record<'--mission' | '--workspace' | '--team' | '--cols' | '--rows', string | null> = { '--mission': null, '--workspace': null, '--team': null, '--cols': null, '--rows': null };
  // Hidden: `--frame [--queue] [--cols N] [--rows N]` prints one frame and exits (top/frame.ts).
  let frame = false;
  let queue = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--frame') { frame = true; continue; }
    if (a === '--queue') { queue = true; continue; }
    const flag = (['--mission', '--workspace', '--team', '--cols', '--rows'] as const).find(f => a === f || a.startsWith(f + '='));
    if (!flag) return { kind: 'unknown', arg: a };
    if (a === flag) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('-')) return { kind: 'unknown', arg: a };
      values[flag] = v;
      i++;
      continue;
    }
    const v = a.slice(flag.length + 1);
    if (!v) return { kind: 'unknown', arg: a };
    values[flag] = v;
  }
  const size = (v: string | null, fallback: number) => (v && /^\d+$/.test(v) ? Math.max(20, Math.min(400, Number(v))) : fallback);
  if (!frame && (queue || values['--cols'] || values['--rows'])) return { kind: 'unknown', arg: queue ? '--queue' : values['--cols'] ? '--cols' : '--rows' };
  return {
    kind: 'top', missionId: values['--mission'], workspace: values['--workspace'], team: values['--team'],
    ...(frame ? { frame: { view: queue ? 'queue' as const : 'missions' as const, cols: size(values['--cols'], 120), rows: size(values['--rows'], 40) } } : {}),
  };
}

/** `buildd hold [--for <time>]`: nothing else is accepted. */
function classifyHold(args: string[]): CliDecision {
  let forArg: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--for') {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('-')) return { kind: 'unknown', arg: a };
      forArg = v;
      i++;
      continue;
    }
    if (a.startsWith('--for=')) {
      const v = a.slice('--for='.length);
      if (!v) return { kind: 'unknown', arg: a };
      forArg = v;
      continue;
    }
    return { kind: 'unknown', arg: a };
  }
  return { kind: 'hold', forArg };
}

export function classifyCliArgs(argv: string[]): CliDecision {
  const args = argv.slice(2);
  if (args.some(a => HELP.has(a))) return { kind: 'help' };
  if (args[0] === 'top') return classifyTop(args.slice(1));

  if (args[0] === 'name') {
    const rest = args.slice(1);
    const flag = rest.find(a => a.startsWith('-') && a !== '--clear');
    return flag ? { kind: 'unknown', arg: flag } : { kind: 'name', args: rest };
  }
  if (args[0] === 'hold') return classifyHold(args.slice(1));
  if (args[0] === 'resume') {
    return args.length > 1 ? { kind: 'unknown', arg: args[1] } : { kind: 'resume' };
  }
  if (args[0] === 'stop') {
    const rest = args.slice(1);
    const bad = rest.find(a => a !== '--yes' && a !== '-y' && a !== '--abort');
    if (bad !== undefined) return { kind: 'unknown', arg: bad };
    return { kind: 'stop', yes: rest.includes('--yes') || rest.includes('-y'), abort: rest.includes('--abort') };
  }
  if (args[0] === 'slots') {
    const c = classifySlotsArgs(args.slice(1));
    return c.kind === 'unknown' ? c : { kind: 'slots', cmd: c };
  }
  if (args[0] === 'web') {
    return args.length > 1 ? { kind: 'unknown', arg: args[1] } : { kind: 'web' };
  }

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
