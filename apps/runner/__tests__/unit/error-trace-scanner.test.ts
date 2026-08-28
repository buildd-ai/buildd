import { describe, it, expect, beforeEach } from 'bun:test';
import { scanToolResult, clearWorkerThrottle } from '../../src/error-trace-scanner';

describe('error-trace-scanner', () => {
  beforeEach(() => {
    clearWorkerThrottle('w1');
    clearWorkerThrottle('w2');
  });

  it('detects the 2026-05-25 incident pattern (cd: No such file or directory)', () => {
    const out = scanToolResult('w1', 'cd: /home/coder/project/sibling-app: No such file or directory', 'bash');
    expect(out).toHaveLength(1);
    expect(out[0].pattern).toBe('cd_no_such_file');
    expect(out[0].excerpt).toContain('sibling-app');
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

  describe('sandbox_mount_gap patterns', () => {
    beforeEach(() => clearWorkerThrottle('wg'));

    it('detects ENOENT on .npmrc (npm config outside allowlist)', () => {
      const out = scanToolResult('wg', "Error: ENOENT: no such file or directory, open '/home/coder/.npmrc'", 'bash');
      expect(out.some(t => t.pattern === 'sandbox_mount_gap')).toBe(true);
    });

    it('detects ENOENT on .gitconfig (git config outside allowlist)', () => {
      const out = scanToolResult('wg', "ENOENT: no such file or directory '/home/runner/.gitconfig'", 'bash');
      expect(out.some(t => t.pattern === 'sandbox_mount_gap')).toBe(true);
    });

    it('detects ENOENT on /snap/ path (snap-installed tool binary)', () => {
      const out = scanToolResult('wg', "ENOENT: /snap/bin/go: No such file or directory", 'bash');
      expect(out.some(t => t.pattern === 'sandbox_mount_gap')).toBe(true);
    });

    it('detects EACCES on /snap/ path', () => {
      const out = scanToolResult('wg', 'EACCES: permission denied, access \'/snap/bin/node\'', 'bash');
      expect(out.some(t => t.pattern === 'sandbox_mount_gap')).toBe(true);
    });

    it('detects ENOENT on /opt/ path', () => {
      const out = scanToolResult('wg', "ENOENT: no such file or directory, open '/opt/homebrew/bin/node'", 'bash');
      expect(out.some(t => t.pattern === 'sandbox_mount_gap')).toBe(true);
    });

    it('near-miss: generic ENOENT on in-repo file does NOT match sandbox_mount_gap', () => {
      const out = scanToolResult('wg', "ENOENT: no such file or directory, open 'src/config.ts'", 'bash');
      expect(out.some(t => t.pattern === 'sandbox_mount_gap')).toBe(false);
    });

    it('near-miss: ENOENT inside ~/.bun (allowlisted) does NOT match', () => {
      const out = scanToolResult('wg', "Error: ENOENT: no such file or directory, open '/home/coder/.bun/install/foo.json'", 'bash');
      expect(out.some(t => t.pattern === 'sandbox_mount_gap')).toBe(false);
    });

    it('near-miss: ENOENT inside ~/.npm (allowlisted) does NOT match', () => {
      const out = scanToolResult('wg', "ENOENT: /home/coder/.npm/some-package: No such file or directory", 'bash');
      expect(out.some(t => t.pattern === 'sandbox_mount_gap')).toBe(false);
    });

    it('near-miss: permission denied on /usr/ (allowlisted as ro) does NOT match sandbox_mount_gap', () => {
      // /usr is mounted ro — a write-EACCES to /usr is NOT a mount gap; it's expected.
      // The sandbox_mount_gap pattern does not fire for /usr/.
      const out = scanToolResult('wg', "EACCES: permission denied, open '/usr/local/bin/something'", 'bash');
      expect(out.some(t => t.pattern === 'sandbox_mount_gap')).toBe(false);
    });

    it('only reports sandbox_mount_gap once per 60s window per worker (throttle)', () => {
      const first = scanToolResult('wg', "ENOENT: no such file or directory, open '/home/coder/.npmrc'", 'bash');
      expect(first.some(t => t.pattern === 'sandbox_mount_gap')).toBe(true);
      // Same worker, same pattern — throttled
      const second = scanToolResult('wg', "Error: ENOENT: /home/coder/.gitconfig", 'bash');
      expect(second.some(t => t.pattern === 'sandbox_mount_gap')).toBe(false);
    });
  });
});
