/**
 * `buildd --help` used to start the runner, and so did any typo'd flag. Help,
 * unknown flags and unknown subcommands must all be decided before anything
 * starts — classifyCliArgs is that decision.
 */
import { describe, test, expect } from 'bun:test';
import { classifyCliArgs, RUNNER_USAGE, EXIT_CLI_USAGE } from '../../src/cli-args';

const argv = (...a: string[]) => ['bun', '/x/index.ts', ...a];

describe('classifyCliArgs', () => {
  for (const h of ['--help', '-h', 'help']) {
    test(`${h} asks for help`, () => {
      expect(classifyCliArgs(argv(h))).toEqual({ kind: 'help' });
    });
  }

  test('help wins even next to other flags', () => {
    expect(classifyCliArgs(argv('--debug', '--help'))).toEqual({ kind: 'help' });
  });

  test('no args starts the runner', () => {
    expect(classifyCliArgs(argv())).toEqual({ kind: 'run' });
  });

  test.each([
    [['--debug']],
    [['--foreground']],
    [['--foreground', '--debug']],
    [['--version']],
    [['version']],
    [['--doctor']],
    [['--doctor', '--fix']],
    [['--env-verify', '--json']],
    [['env', 'verify']],
    [['env', 'verify', '--json']],
    [['--once', '--task', 'abc-123']],
    [['--once', '--task=abc-123']],
    [['--once', '--resume-worker', 'w1', '--task', 't1']],
    [['--once', '--park-orphan', 'w1', '--task', 't1']],
  ])('known args %p run', (args) => {
    expect(classifyCliArgs(argv(...args)).kind).toBe('run');
  });

  test('an unknown flag is rejected, naming it', () => {
    expect(classifyCliArgs(argv('--hepl'))).toEqual({ kind: 'unknown', arg: '--hepl' });
  });

  test('an unknown short flag is rejected', () => {
    expect(classifyCliArgs(argv('-x'))).toEqual({ kind: 'unknown', arg: '-x' });
  });

  test('an unknown subcommand is rejected', () => {
    expect(classifyCliArgs(argv('strat'))).toEqual({ kind: 'unknown', arg: 'strat' });
  });

  test('a value-taking flag consumes its value, not a stray positional', () => {
    expect(classifyCliArgs(argv('--once', '--task', 't1', 'stray'))).toEqual({ kind: 'unknown', arg: 'stray' });
  });

  test('`name` is answered before the runner starts, with its words as the name', () => {
    expect(classifyCliArgs(argv('name'))).toEqual({ kind: 'name', args: [] });
    expect(classifyCliArgs(argv('name', 'atlas'))).toEqual({ kind: 'name', args: ['atlas'] });
    expect(classifyCliArgs(argv('name', 'quill', 'studio'))).toEqual({ kind: 'name', args: ['quill', 'studio'] });
    expect(classifyCliArgs(argv('name', '--clear'))).toEqual({ kind: 'name', args: ['--clear'] });
  });

  test('`name` rejects any other flag', () => {
    expect(classifyCliArgs(argv('name', '--debug'))).toEqual({ kind: 'unknown', arg: '--debug' });
  });

  test('`name` only counts as the leading word', () => {
    expect(classifyCliArgs(argv('--debug', 'name'))).toEqual({ kind: 'unknown', arg: 'name' });
  });

  test('`name --help` is help', () => {
    expect(classifyCliArgs(argv('name', '--help'))).toEqual({ kind: 'help' });
  });

  test('usage lists buildd name', () => {
    expect(RUNNER_USAGE).toContain('buildd name');
    expect(RUNNER_USAGE).toContain('BUILDD_RUNNER_NAME');
  });

  test('usage names help, login, service and the flags', () => {
    for (const s of ['buildd login', 'buildd login --workspaces', 'buildd service', '--debug', '--foreground', '--once', '--version', '--help']) {
      expect(RUNNER_USAGE).toContain(s);
    }
  });

  test('usage names both kinds of OAuth connection in plain words', () => {
    expect(RUNNER_USAGE).toContain('--as-agent');
    expect(RUNNER_USAGE).toContain('acts as you');
    expect(RUNNER_USAGE).toContain('acts as your agent');
  });

  test('usage exit code is the sysexits usage code', () => {
    expect(EXIT_CLI_USAGE).toBe(64);
  });
});

describe('buildd top', () => {
  test('top on its own', () => {
    expect(classifyCliArgs(argv('top'))).toEqual({ kind: 'top', missionId: null, workspace: null, team: null });
  });
  test('--mission <id> and --mission=<id>', () => {
    expect(classifyCliArgs(argv('top', '--mission', 'abc123'))).toEqual({ kind: 'top', missionId: 'abc123', workspace: null, team: null });
    expect(classifyCliArgs(argv('top', '--mission=abc123'))).toEqual({ kind: 'top', missionId: 'abc123', workspace: null, team: null });
  });
  test('--workspace <name or id> (R-19), alone or with --mission', () => {
    expect(classifyCliArgs(argv('top', '--workspace', 'alpha'))).toEqual({ kind: 'top', missionId: null, workspace: 'alpha', team: null });
    expect(classifyCliArgs(argv('top', '--workspace=ws-1', '--mission', 'm1'))).toEqual({ kind: 'top', missionId: 'm1', workspace: 'ws-1', team: null });
    expect(classifyCliArgs(argv('top', '--workspace'))).toEqual({ kind: 'unknown', arg: '--workspace' });
    expect(classifyCliArgs(argv('top', '--workspace='))).toEqual({ kind: 'unknown', arg: '--workspace=' });
  });
  test('--team <name> (R-23), alone or with --workspace', () => {
    expect(classifyCliArgs(argv('top', '--team', 'Acme'))).toEqual({ kind: 'top', missionId: null, workspace: null, team: 'Acme' });
    expect(classifyCliArgs(argv('top', '--team=Acme', '--workspace', 'a'))).toEqual({ kind: 'top', missionId: null, workspace: 'a', team: 'Acme' });
    expect(classifyCliArgs(argv('top', '--team'))).toEqual({ kind: 'unknown', arg: '--team' });
  });
  test('anything else after top is refused, not ignored', () => {
    expect(classifyCliArgs(argv('top', '--debug'))).toEqual({ kind: 'unknown', arg: '--debug' });
    expect(classifyCliArgs(argv('top', '--mission'))).toEqual({ kind: 'unknown', arg: '--mission' });
    expect(classifyCliArgs(argv('top', 'extra'))).toEqual({ kind: 'unknown', arg: 'extra' });
  });
  test('--mission is not a runner flag', () => {
    expect(classifyCliArgs(argv('--mission', 'x'))).toEqual({ kind: 'unknown', arg: '--mission' });
  });
  test('help lists top', () => {
    expect(RUNNER_USAGE).toMatch(/^ {2}buildd top {2,}\S/m);
  });
});

describe('hold and resume (R-32)', () => {
  test('`hold` alone, or with --for <time> / --for=<time>', () => {
    expect(classifyCliArgs(argv('hold'))).toEqual({ kind: 'hold', forArg: null });
    expect(classifyCliArgs(argv('hold', '--for', '2h'))).toEqual({ kind: 'hold', forArg: '2h' });
    expect(classifyCliArgs(argv('hold', '--for=30m'))).toEqual({ kind: 'hold', forArg: '30m' });
  });
  test('`hold` refuses anything else, and --for needs a value', () => {
    expect(classifyCliArgs(argv('hold', '--for'))).toEqual({ kind: 'unknown', arg: '--for' });
    expect(classifyCliArgs(argv('hold', '--for='))).toEqual({ kind: 'unknown', arg: '--for=' });
    expect(classifyCliArgs(argv('hold', 'now'))).toEqual({ kind: 'unknown', arg: 'now' });
    expect(classifyCliArgs(argv('hold', '--debug'))).toEqual({ kind: 'unknown', arg: '--debug' });
  });
  test('`resume` takes nothing', () => {
    expect(classifyCliArgs(argv('resume'))).toEqual({ kind: 'resume' });
    expect(classifyCliArgs(argv('resume', 'now'))).toEqual({ kind: 'unknown', arg: 'now' });
  });
  test('only as the leading word', () => {
    expect(classifyCliArgs(argv('--debug', 'hold'))).toEqual({ kind: 'unknown', arg: 'hold' });
  });
  test('help lists hold and resume', () => {
    expect(RUNNER_USAGE).toMatch(/^ {2}buildd hold \[--for <time>\] +\S/m);
    expect(RUNNER_USAGE).toMatch(/^ {2}buildd resume {2,}\S/m);
  });
});

describe('stop (R-36)', () => {
  test('`stop`, `--yes` / `-y`, `--abort`', () => {
    expect(classifyCliArgs(argv('stop'))).toEqual({ kind: 'stop', yes: false, abort: false });
    expect(classifyCliArgs(argv('stop', '--yes'))).toEqual({ kind: 'stop', yes: true, abort: false });
    expect(classifyCliArgs(argv('stop', '-y'))).toEqual({ kind: 'stop', yes: true, abort: false });
    expect(classifyCliArgs(argv('stop', '--abort'))).toEqual({ kind: 'stop', yes: false, abort: true });
    expect(classifyCliArgs(argv('stop', '--abort', '--yes'))).toEqual({ kind: 'stop', yes: true, abort: true });
    expect(classifyCliArgs(argv('stop', 'now'))).toEqual({ kind: 'unknown', arg: 'now' });
  });
  test('help lists top, web, name, hold, resume and stop (R-16)', () => {
    for (const c of ['top', 'web', 'name', 'hold', 'resume', 'stop']) expect(RUNNER_USAGE).toMatch(new RegExp(`^ {2}buildd ${c}\\b`, 'm'));
  });
});
