import { describe, it, expect, beforeEach } from 'bun:test';
import {
  scanBashResult,
  clearWorkerThrottle,
  BASH_FAILURE_CAP_PER_WORKER,
} from '../../src/error-trace-scanner';
import { createSecretRedactor } from '@buildd/core/redaction';
import {
  parseBashTraceExcerpt,
  formatBashTraceExcerpt,
  BASH_TRACE_EXCERPT_MAX,
  BASH_TRACE_TAIL_LINES,
  verifyFamilyOf,
} from '@buildd/core/bash-failure-trace';

const fail = (text: string) => `Exit code 1\n${text}`;

describe('scanBashResult', () => {
  beforeEach(() => clearWorkerThrottle('w1'));

  it('files a trace for a non-zero exit that no fixed pattern knows', () => {
    const out = scanBashResult('w1', {
      command: 'bun test apps/web/foo.test.ts',
      content: fail('(fail) foo > does the thing\nerror: expect(received).toBe(expected)'),
      isError: true,
    });
    expect(out).toHaveLength(1);
    expect(out[0].pattern).toBe('bash_nonzero_exit');
    const parsed = parseBashTraceExcerpt(out[0].excerpt)!;
    expect(parsed.command).toBe('bun test apps/web/foo.test.ts');
    expect(parsed.exitCode).toBe(1);
    expect(parsed.output).toContain('(fail) foo > does the thing');
  });

  it('never leaks a secret from the command or the output', () => {
    const secret = 'sk-live-abcdefghijklmnopqrstuvwxyz012345';
    const redact = createSecretRedactor([{ value: secret, name: 'API' }] as never);
    const out = scanBashResult('w1', {
      command: `curl -H "x-api-key: ${secret}" https://example.test`,
      content: `Exit code 22\nrequest with ${secret} was rejected`,
      isError: true,
    }, redact);
    expect(out).toHaveLength(1);
    expect(out[0].excerpt).not.toContain(secret);
  });

  it('keeps only a bounded tail', () => {
    const many = Array.from({ length: 500 }, (_, i) => `line ${i} ${'z'.repeat(400)}`).join('\n');
    const out = scanBashResult('w1', { command: 'bun test', content: fail(many), isError: true });
    const excerpt = out[0].excerpt;
    expect(excerpt.length).toBeLessThanOrEqual(BASH_TRACE_EXCERPT_MAX);
    expect(excerpt.split('\n').length).toBeLessThanOrEqual(BASH_TRACE_TAIL_LINES + 1);
    expect(excerpt).toContain('line 499');
  });

  it('drops an exact repeat', () => {
    const args = { command: 'bun test', content: fail('(fail) x'), isError: true };
    expect(scanBashResult('w1', args)).toHaveLength(1);
    expect(scanBashResult('w1', args)).toHaveLength(0);
  });

  it('holds the per-worker rate cap', () => {
    let filed = 0;
    for (let i = 0; i < BASH_FAILURE_CAP_PER_WORKER + 15; i++) {
      filed += scanBashResult('w1', { command: `run-thing ${i}`, content: fail(`boom ${i}`), isError: true }).length;
    }
    expect(filed).toBe(BASH_FAILURE_CAP_PER_WORKER);
  });

  it('skips a silent exit 1 and a result with no exit code', () => {
    expect(scanBashResult('w1', { command: 'grep -q foo file', content: 'Exit code 1\n', isError: true })).toHaveLength(0);
    expect(scanBashResult('w1', { command: 'ls', content: 'some tool error text', isError: true })).toHaveLength(0);
  });

  it('files nothing for a success', () => {
    expect(scanBashResult('w1', { command: 'ls', content: 'a\nb', isError: false })).toHaveLength(0);
  });

  it('marks a verify command that passes after failing, once', () => {
    scanBashResult('w1', { command: 'bun run test', content: fail('(fail) x'), isError: true });
    const ok = scanBashResult('w1', { command: 'bun run test', content: 'all passed', isError: false });
    expect(ok).toHaveLength(1);
    expect(ok[0].pattern).toBe('bash_verify_recovered');
    expect(scanBashResult('w1', { command: 'bun run test', content: 'all passed', isError: false })).toHaveLength(0);
  });

  it('does not mark a pass with no earlier failure, or a different family', () => {
    expect(scanBashResult('w1', { command: 'bun run test', content: 'ok', isError: false })).toHaveLength(0);
    scanBashResult('w1', { command: 'bun run test', content: fail('(fail) x'), isError: true });
    expect(scanBashResult('w1', { command: 'tsc --noEmit', content: '', isError: false })).toHaveLength(0);
  });
});

describe('bash trace excerpt format', () => {
  it('round-trips', () => {
    const e = formatBashTraceExcerpt({ command: 'tsc --noEmit', exitCode: 2, output: 'a.ts(1,1): error TS1\n' });
    expect(parseBashTraceExcerpt(e)).toEqual({ command: 'tsc --noEmit', exitCode: 2, output: 'a.ts(1,1): error TS1' });
  });

  it('keeps every line of a multi-line command on the one header line', () => {
    const e = formatBashTraceExcerpt({ command: 'echo a\necho b', exitCode: 1, output: 'x' });
    expect(e.split('\n')[0]).toBe('$ echo a ⏎ echo b [exit 1]');
    expect(parseBashTraceExcerpt(e)?.command).toBe('echo a ⏎ echo b');
  });

  it('keeps a long command whole (well past the old 200-char clip)', () => {
    const command = `grep -rn ${'x'.repeat(600)} apps/web`;
    expect(parseBashTraceExcerpt(formatBashTraceExcerpt({ command, exitCode: 2, output: '' }))?.command).toBe(command);
  });

  it('classifies verify commands', () => {
    expect(verifyFamilyOf('bun run test')).toBe('test');
    expect(verifyFamilyOf('cd apps/web && bunx tsc --noEmit')).toBe('typecheck');
    expect(verifyFamilyOf('bun run scripts/run-unit-tests.ts a.test.ts')).toBe('test');
    expect(verifyFamilyOf('ls -la')).toBeNull();
  });
});
