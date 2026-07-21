import { describe, it, expect, beforeEach } from 'bun:test';
import { scanToolResult, clearWorkerThrottle } from '../../src/error-trace-scanner';

describe('error-trace-scanner', () => {
  beforeEach(() => {
    clearWorkerThrottle('w1');
    clearWorkerThrottle('w2');
  });

  it('detects the 2026-05-25 incident pattern (cd: No such file or directory)', () => {
    const out = scanToolResult('w1', 'cd: /home/coder/project/moa-ops: No such file or directory', 'bash');
    expect(out).toHaveLength(1);
    expect(out[0].pattern).toBe('cd_no_such_file');
    expect(out[0].excerpt).toContain('moa-ops');
    expect(out[0].source).toBe('bash');
  });

  it('detects git fatal errors', () => {
    const out = scanToolResult('w1', 'fatal: not a git repository (or any of the parent directories): .git');
    expect(out.some((t) => t.pattern === 'git_fatal')).toBe(true);
  });

  it('detects permission denied', () => {
    const out = scanToolResult('w1', 'bash: /usr/local/bin/foo: Permission denied');
    expect(out.some((t) => t.pattern === 'permission_denied')).toBe(true);
  });

  it('detects OOM killed', () => {
    const out = scanToolResult('w1', 'Killed: 9');
    expect(out.some((t) => t.pattern === 'oom_killed')).toBe(true);
  });

  it('returns empty for benign output', () => {
    const out = scanToolResult('w1', 'Successfully installed package\nBuild complete.\n42 tests passed');
    expect(out).toEqual([]);
  });

  it('throttles repeated same-pattern matches within 60s', () => {
    const first = scanToolResult('w1', 'cd: /tmp/missing: No such file or directory');
    expect(first).toHaveLength(1);

    // Same pattern, same worker — should be throttled
    const second = scanToolResult('w1', 'cd: /tmp/also-missing: No such file or directory');
    expect(second).toHaveLength(0);
  });

  it('does NOT throttle across different workers', () => {
    scanToolResult('w1', 'cd: /tmp/a: No such file or directory');
    const w2 = scanToolResult('w2', 'cd: /tmp/b: No such file or directory');
    expect(w2).toHaveLength(1);
  });

  it('does NOT throttle different patterns from the same worker', () => {
    const a = scanToolResult('w1', 'cd: /tmp/a: No such file or directory');
    const b = scanToolResult('w1', 'fatal: bad revision HEAD~50');
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].pattern).not.toBe(b[0].pattern);
  });

  it('truncates long excerpts to 500 chars', () => {
    const huge = 'fatal: ' + 'x'.repeat(2000);
    const out = scanToolResult('w1', huge);
    expect(out[0].excerpt.length).toBeLessThanOrEqual(500);
  });

  it('scans multi-line output and catches mid-stream errors', () => {
    const multi = [
      'Cloning repo...',
      'Receiving objects: 100%',
      'fatal: remote authentication failed',
      'Done.',
    ].join('\n');
    const out = scanToolResult('w1', multi);
    expect(out.some((t) => t.pattern === 'git_fatal')).toBe(true);
  });

  it('returns empty for non-string content', () => {
    // @ts-expect-error testing defensive guard
    expect(scanToolResult('w1', null)).toEqual([]);
    // @ts-expect-error testing defensive guard
    expect(scanToolResult('w1', undefined)).toEqual([]);
  });

  it('detects bwrap namespace permission error', () => {
    const out = scanToolResult('w1', 'bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces.', 'bash');
    expect(out).toHaveLength(1);
    expect(out[0].pattern).toBe('bwrap_namespace_denied');
    expect(out[0].source).toBe('bash');
  });
});
