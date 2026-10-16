/**
 * Spec c7410e76 R-16: `buildd --help` lists top, web and name, and `buildd web`
 * is a command of its own (decided before anything starts).
 */
import { describe, expect, test } from 'bun:test';
import { classifyCliArgs, RUNNER_USAGE } from '../../src/cli-args';

const argv = (...a: string[]) => ['bun', '/x/index.ts', ...a];

describe('buildd --help', () => {
  for (const cmd of ['top', 'web', 'name']) {
    test(`lists buildd ${cmd}`, () => {
      expect(RUNNER_USAGE).toMatch(new RegExp(`^ {2}buildd ${cmd}\\b.* {2,}\\S`, 'm'));
    });
  }
});

describe('buildd web', () => {
  test('is its own command', () => {
    expect(classifyCliArgs(argv('web'))).toEqual({ kind: 'web' });
  });
  test('takes nothing after it', () => {
    expect(classifyCliArgs(argv('web', '--debug'))).toEqual({ kind: 'unknown', arg: '--debug' });
    expect(classifyCliArgs(argv('web', 'extra'))).toEqual({ kind: 'unknown', arg: 'extra' });
  });
  test('help still wins', () => {
    expect(classifyCliArgs(argv('web', '--help'))).toEqual({ kind: 'help' });
  });
});
