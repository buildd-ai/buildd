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

  test('usage names help, login, service and the flags', () => {
    for (const s of ['buildd login', 'buildd service', '--debug', '--once', '--version', '--help']) {
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
