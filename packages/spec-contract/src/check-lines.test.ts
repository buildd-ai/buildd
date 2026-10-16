import { describe, expect, test } from 'bun:test';
import { CHECKOUT_FAILED_EXIT, checkCommandAt, checkVerdict, criterionChecks } from './check-lines';

describe('criterionChecks', () => {
  test('a check line belongs to the criterion above it; a criterion without one has none', () => {
    const body = [
      '# Checkout',
      'R-1: Totals are in the shopper currency.',
      '  check: `bun test apps/web/src/lib/fx.test.ts`',
      '- **AC-1** A EUR cart shows the euro sign.',
      '- AC-2: Refunds use the original rate.',
      '  - check: bun run scripts/refund-check.ts',
    ].join('\n');
    expect(criterionChecks(body)).toEqual([
      { criterionId: 'R-1', command: 'bun test apps/web/src/lib/fx.test.ts' },
      { criterionId: 'AC-2', command: 'bun run scripts/refund-check.ts' },
    ]);
  });

  test('checks under decisions, invariants, headings, fences or a repeated id are ignored; the first check wins', () => {
    const body = [
      'R-1: One.',
      'check: first',
      'check: second',
      '### D-1 A decision',
      'check: not-a-criterion',
      'I-1: An invariant.',
      'check: nope',
      'R-2: Two.',
      '## Notes',
      'check: under a heading',
      'R-3: Three.',
      '```',
      'check: fenced',
      '```',
      'R-1: Again.',
      'check: repeat',
    ].join('\n');
    expect(criterionChecks(body)).toEqual([{ criterionId: 'R-1', command: 'first' }]);
  });

  test('an empty or oversized command is not a check', () => {
    expect(criterionChecks(`R-1: x\ncheck: \`\``)).toEqual([]);
    expect(criterionChecks(`R-1: x\ncheck: ${'a'.repeat(1001)}`)).toEqual([]);
  });
});

describe('checkCommandAt', () => {
  test('pins the run to the judged head before the command', () => {
    const sha = 'A'.repeat(40);
    const cmd = checkCommandAt('bun test x', sha);
    expect(cmd).toContain(`git checkout -q --detach ${'a'.repeat(40)}`);
    expect(cmd).toContain(`|| exit ${CHECKOUT_FAILED_EXIT}`);
    expect(cmd.endsWith('; bun test x')).toBe(true);
  });

  test('refuses anything but a full SHA', () => {
    expect(() => checkCommandAt('x', 'main')).toThrow();
    expect(() => checkCommandAt('x', 'abc1234')).toThrow();
  });
});

describe('checkVerdict', () => {
  test('exit 0 passes, a failing command fails, anything that asserted nothing is inconclusive', () => {
    expect(checkVerdict({ outcome: 'ok', exitCode: 0 })).toBe('pass');
    expect(checkVerdict({ outcome: 'failed', exitCode: 1 })).toBe('fail');
    expect(checkVerdict({ outcome: 'failed', exitCode: CHECKOUT_FAILED_EXIT })).toBe('inconclusive');
    expect(checkVerdict({ outcome: 'timeout' })).toBe('inconclusive');
    expect(checkVerdict({ outcome: 'exec_error' })).toBe('inconclusive');
    expect(checkVerdict({})).toBeNull();
  });
});

describe('check lines around a table', () => {
  test('a table row with an id owns the check line under the table; header rows own nothing', () => {
    const body = ['| ID | Requirement |', '|---|---|', '| AC-1 | Empty state |', '  check: `bun test cart`', '- AC-2: Totals', '  check: `bun test totals`'].join('\n');
    expect(criterionChecks(body)).toEqual([{ criterionId: 'AC-1', command: 'bun test cart' }, { criterionId: 'AC-2', command: 'bun test totals' }]);
  });
});

