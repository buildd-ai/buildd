import { describe, expect, test } from 'bun:test';
import { normalizeCommandOutput } from '../../src/command-output';

describe('normalizeCommandOutput', () => {
  test('strips ANSI and extracts bun failures and summary', () => {
    const result = normalizeCommandOutput(
      '\u001b[0m\n\n\napps/example.test.ts:\n\n(fail) handles expired tokens [2.00ms]\n' +
      'Expected: 200\nReceived: 401\n\n\n 12 pass\n 1 fail\n 34 expect() calls\n',
      'bun test',
    );

    expect(result.output).not.toContain('\u001b');
    expect(result.output).not.toContain('\n\n\n');
    expect(result.testSummary).toEqual({ passed: 12, failed: 1 });
    expect(result.failures).toEqual(['(fail) handles expired tokens [2.00ms]']);
    expect(result.state).toBe('fail');
  });

  test('recognizes slash summaries and passing bun runs', () => {
    const result = normalizeCommandOutput('18 pass / 0 fail\nRan 18 tests', 'bun test');

    expect(result.testSummary).toEqual({ passed: 18, failed: 0 });
    expect(result.failures).toEqual([]);
    expect(result.state).toBe('pass');
  });

  test('keeps failure details when oversized output is capped', () => {
    const noise = Array.from({ length: 500 }, (_, i) => `passing output ${i}`).join('\n');
    const result = normalizeCommandOutput(
      `${noise}\n(fail) preserves the useful tail\nExpected: true\nReceived: false\n\n499 pass\n1 fail`,
      'bun test',
      240,
    );

    expect(result.output.length).toBeLessThanOrEqual(240);
    expect(result.output).toContain('(fail) preserves the useful tail');
    expect(result.output).toContain('499 pass');
    expect(result.output).toContain('1 fail');
  });
});
