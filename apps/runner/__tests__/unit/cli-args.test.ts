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
    expect(classifyCliArgs(argv('top'))).toEqual({ kind: 'top', missionId: null, workspace: null });
  });
  test('--mission <id> and --mission=<id>', () => {
    expect(classifyCliArgs(argv('top', '--mission', 'abc123'))).toEqual({ kind: 'top', missionId: 'abc123', workspace: null });
    expect(classifyCliArgs(argv('top', '--mission=abc123'))).toEqual({ kind: 'top', missionId: 'abc123', workspace: null });
  });
  test('--workspace <name or id> (R-19), alone or with --mission', () => {
    expect(classifyCliArgs(argv('top', '--workspace', 'alpha'))).toEqual({ kind: 'top', missionId: null, workspace: 'alpha' });
    expect(classifyCliArgs(argv('top', '--workspace=ws-1', '--mission', 'm1'))).toEqual({ kind: 'top', missionId: 'm1', workspace: 'ws-1' });
    expect(classifyCliArgs(argv('top', '--workspace'))).toEqual({ kind: 'unknown', arg: '--workspace' });
    expect(classifyCliArgs(argv('top', '--workspace='))).toEqual({ kind: 'unknown', arg: '--workspace=' });
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
