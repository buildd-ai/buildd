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
    // `git_fatal` is now one of the broad patterns and requires the result to
    // be marked an error — the bare string appears in mocked git-error test
    // fixtures across the repo.
    const out = scanToolResult('w1', 'fatal: not a git repository (or any of the parent directories): .git', undefined, { isError: true });
    expect(out.some((t) => t.pattern === 'git_fatal')).toBe(true);
  });

  it('detects permission denied', () => {
    // `permission_denied` is one of the broad patterns and now requires the
    // result to be marked an error — the bare string matches ordinary source
    // code, including this scanner's own pattern table.
    const out = scanToolResult('w1', 'bash: /usr/local/bin/foo: Permission denied', 'Bash', { isError: true });
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
    const b = scanToolResult('w1', 'fatal: bad revision HEAD~50', undefined, { isError: true });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].pattern).not.toBe(b[0].pattern);
  });

  it('truncates long excerpts to 500 chars', () => {
    const huge = 'fatal: ' + 'x'.repeat(2000);
    const out = scanToolResult('w1', huge, undefined, { isError: true });
    expect(out[0].excerpt.length).toBeLessThanOrEqual(500);
  });

  it('scans multi-line output and catches mid-stream errors', () => {
    const multi = [
      'Cloning repo...',
      'Receiving objects: 100%',
      'fatal: remote authentication failed',
      'Done.',
    ].join('\n');
    const out = scanToolResult('w1', multi, undefined, { isError: true });
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
    const ERR = { isError: true };

    it('detects ENOENT on .npmrc (npm config outside allowlist)', () => {
      const out = scanToolResult('wg', "Error: ENOENT: no such file or directory, open '/home/coder/.npmrc'", 'bash', ERR);
      expect(out.some(t => t.pattern === 'sandbox_mount_gap')).toBe(true);
    });

    it('detects ENOENT on .gitconfig (git config outside allowlist)', () => {
      const out = scanToolResult('wg', "ENOENT: no such file or directory '/home/runner/.gitconfig'", 'bash', ERR);
      expect(out.some(t => t.pattern === 'sandbox_mount_gap')).toBe(true);
    });

    it('detects ENOENT on /snap/ path (snap-installed tool binary)', () => {
      const out = scanToolResult('wg', "ENOENT: /snap/bin/go: No such file or directory", 'bash', ERR);
      expect(out.some(t => t.pattern === 'sandbox_mount_gap')).toBe(true);
    });

    it('detects EACCES on /snap/ path', () => {
      const out = scanToolResult('wg', 'EACCES: permission denied, access \'/snap/bin/node\'', 'bash', ERR);
      expect(out.some(t => t.pattern === 'sandbox_mount_gap')).toBe(true);
    });

    it('detects ENOENT on /opt/ path', () => {
      const out = scanToolResult('wg', "ENOENT: no such file or directory, open '/opt/homebrew/bin/node'", 'bash', ERR);
      expect(out.some(t => t.pattern === 'sandbox_mount_gap')).toBe(true);
    });

    it('near-miss: generic ENOENT on in-repo file does NOT match sandbox_mount_gap', () => {
      const out = scanToolResult('wg', "ENOENT: no such file or directory, open 'src/config.ts'", 'bash', ERR);
      expect(out.some(t => t.pattern === 'sandbox_mount_gap')).toBe(false);
    });

    it('near-miss: ENOENT inside ~/.bun (allowlisted) does NOT match', () => {
      const out = scanToolResult('wg', "Error: ENOENT: no such file or directory, open '/home/coder/.bun/install/foo.json'", 'bash', ERR);
      expect(out.some(t => t.pattern === 'sandbox_mount_gap')).toBe(false);
    });

    it('near-miss: ENOENT inside ~/.npm (allowlisted) does NOT match', () => {
      const out = scanToolResult('wg', "ENOENT: /home/coder/.npm/some-package: No such file or directory", 'bash', ERR);
      expect(out.some(t => t.pattern === 'sandbox_mount_gap')).toBe(false);
    });

    it('near-miss: permission denied on /usr/ (allowlisted as ro) does NOT match sandbox_mount_gap', () => {
      // /usr is mounted ro — a write-EACCES to /usr is NOT a mount gap; it's expected.
      // The sandbox_mount_gap pattern does not fire for /usr/.
      const out = scanToolResult('wg', "EACCES: permission denied, open '/usr/local/bin/something'", 'bash', ERR);
      expect(out.some(t => t.pattern === 'sandbox_mount_gap')).toBe(false);
    });

    it('only reports sandbox_mount_gap once per 60s window per worker (throttle)', () => {
      const first = scanToolResult('wg', "ENOENT: no such file or directory, open '/home/coder/.npmrc'", 'bash', ERR);
      expect(first.some(t => t.pattern === 'sandbox_mount_gap')).toBe(true);
      // Same worker, same pattern — throttled
      const second = scanToolResult('wg', "Error: ENOENT: /home/coder/.gitconfig", 'bash', ERR);
      expect(second.some(t => t.pattern === 'sandbox_mount_gap')).toBe(false);
    });

    it('does NOT fire without isError, even on a well-formed gap path', () => {
      // `sandbox_mount_gap` is gated by requiresError now — a bare match on a
      // successful tool result (a Read, or a Bash command that merely quotes
      // this text) is not evidence of a real denial.
      const out = scanToolResult('wg', "Error: ENOENT: no such file or directory, open '/home/coder/.npmrc'", 'bash');
      expect(out.some(t => t.pattern === 'sandbox_mount_gap')).toBe(false);
    });

    describe('real production false positives (worker was killed on these)', () => {
      // These three signatures are the actual `worker.error` values captured in
      // the 24h window that motivated this fix. All three were produced by an
      // agent reading/grepping the error-trace-scanner's own source and test
      // fixtures — never a real bwrap denial — yet the old regexes ("contains
      // ENOENT somewhere, then .npmrc somewhere later") matched all of them and
      // the worker was aborted every time.

      it('rejects a test case title mentioning ENOENT and .npmrc', () => {
        const line = "52:    it('detects ENOENT on .npmrc (npm config outside allowlist)', () => {";
        // Adversarial: even forcing isError:true and a non-read-only source,
        // the text has no path-shaped token — extraction alone rejects it.
        const out = scanToolResult('wg', line, 'Bash', ERR);
        expect(out.some(t => t.pattern === 'sandbox_mount_gap')).toBe(false);
      });

      it('rejects a grepped source line quoting a real-shaped gap path, via the requiresError gate', () => {
        // This line's quoted content IS shaped like a real denial (that's the
        // point of the fixture it's quoting) — extraction alone cannot tell it
        // apart from genuine output. What defeats it in production is that a
        // successful grep/cat exits 0, so is_error is false.
        const line = "apps/runner/__tests__/unit/error-trace-scanner.test.ts:102:      "
          + "const out = scanToolResult('wg', \"Error: ENOENT: no such file or directory, open '/home/coder/.npmrc'\", 'bash');";
        const out = scanToolResult('wg', line, 'Bash');
        expect(out.some(t => t.pattern === 'sandbox_mount_gap')).toBe(false);
      });

      it('rejects the same line via READ_ONLY_TOOLS when read with Read/Grep', () => {
        const line = "apps/runner/__tests__/unit/error-trace-scanner.test.ts:102:      "
          + "const out = scanToolResult('wg', \"Error: ENOENT: no such file or directory, open '/home/coder/.npmrc'\", 'bash');";
        for (const tool of ['Read', 'Grep']) {
          expect(scanToolResult('wg', line, tool, ERR)).toEqual([]);
        }
      });

      it('rejects a fixture string literal inside a test array', () => {
        const line = '5:  "ENOENT: no such file or directory, open \'/home/coder/.npmrc\'",';
        // Same reasoning as the grepped-source case: shape alone can't reject
        // this (it's a byte-for-byte real denial shape), so a successful,
        // non-error read is what keeps it from firing.
        const out = scanToolResult('wg', line, 'Bash');
        expect(out.some(t => t.pattern === 'sandbox_mount_gap')).toBe(false);
      });
    });
  });
});

describe('precision gates', () => {
  const ERR = { isError: true };

  it('skips read-only tool results entirely', () => {
    // The pattern table itself contains the strings `Permission denied` and
    // `ECONNREFUSED`, so an agent reading error-trace-scanner.ts used to match
    // its own source. File contents are not execution output.
    const source = "  { slug: 'permission_denied', re: /Permission denied/ },";
    for (const tool of ['Read', 'Grep', 'Glob', 'NotebookRead', 'WebFetch', 'WebSearch']) {
      expect(scanToolResult('w-ro', source, tool, ERR)).toEqual([]);
    }
    // Same text from a shell is a real match.
    expect(scanToolResult('w-ro2', 'bash: /x: Permission denied', 'Bash', ERR).length).toBe(1);
  });

  it('holds the broad patterns unless the result was marked an error', () => {
    // `^error: ` matched hundreds of bun test assertions; `rate.?limit` matched
    // grepped TypeScript unions and never a real 429.
    const cases = [
      'error: expect(received).toBe(expected)',
      "| 'budget_paused'  // reset to pending by budget/rate-limit exhaustion",
      "throw new Error('ECONNREFUSED')",
    ];
    for (const text of cases) {
      expect(scanToolResult(`w-np-${text.length}`, text, 'Bash')).toEqual([]);
      expect(scanToolResult(`w-nf-${text.length}`, text, 'Bash', { isError: false })).toEqual([]);
    }
  });

  it('holds git_fatal, no_such_file, and command_not_found unless marked an error', () => {
    // Each of these is stock POSIX/git wording that shows up verbatim in this
    // repo's own mocked-error test fixtures and fallback shell messaging
    // (`which x || echo "x not found"`), so a bare match on a successful
    // result is not evidence of anything.
    const cases: Array<[string, string]> = [
      ["fatal: a branch named 'foo' already exists", 'git_fatal'],
      ['Some tool printed: No such file or directory', 'no_such_file'],
      ['bash: foo: command not found', 'command_not_found'],
      ['sh: 1: tsx: not found', 'command_not_found'],
    ];
    cases.forEach(([text, slug], i) => {
      // Each case needs its own worker id — two cases share the
      // `command_not_found` slug and would otherwise throttle each other.
      expect(scanToolResult(`w-nf2-${i}`, text, 'Bash')).toEqual([]);
      expect(scanToolResult(`w-nf3-${i}`, text, 'Bash', { isError: false })).toEqual([]);
      expect(
        scanToolResult(`w-yf-${i}`, text, 'Bash', { isError: true }).some(t => t.pattern === slug),
      ).toBe(true);
    });
  });

  it('still fires the broad patterns on a genuine error result', () => {
    expect(scanToolResult('w-ge', 'error: cannot lock ref', 'Bash', ERR).some(t => t.pattern === 'git_error')).toBe(true);
    expect(scanToolResult('w-rl', '429 Too Many Requests', 'Bash', ERR).some(t => t.pattern === 'rate_limit')).toBe(true);
  });

  it('keeps narrow patterns unconditional, since is_error is only a lower bound', () => {
    // A Bash command can print a real failure and still exit 0. These stay
    // ungated because each needs a compound, format-locked signal (a specific
    // shell prefix, or an error token plus a specific non-allowlisted path)
    // rather than a generic English phrase — unlike git_fatal/no_such_file/
    // command_not_found above, which are gated.
    expect(scanToolResult('w-narrow1', 'cd: /tmp/missing: No such file or directory', 'Bash').some(t => t.pattern === 'cd_no_such_file')).toBe(true);
    expect(scanToolResult('w-narrow2', 'bwrap: No permissions to create a new namespace', 'Bash').length).toBe(1);
    expect(scanToolResult('w-narrow3', 'Killed: 9', 'Bash').some(t => t.pattern === 'oom_killed')).toBe(true);
  });
});

describe('recall fixes', () => {
  it('catches zsh cd failure, which is what the agent shell actually emits', () => {
    // The slug this file was written for had never fired in production: the
    // regex is anchored on bash wording, the shell is zsh.
    const out = scanToolResult('w-zsh', '(eval):cd:1: no such file or directory: apps/web', 'Bash');
    expect(out.some(t => t.pattern === 'cd_no_such_file')).toBe(true);
  });

  it('catches the sh/dash wording for a missing command', () => {
    // `command_not_found` is one of the broad patterns and requires the
    // result to be marked an error.
    const out = scanToolResult('w-sh', 'sh: 1: tsx: not found', 'Bash', { isError: true });
    expect(out.some(t => t.pattern === 'command_not_found')).toBe(true);
  });
});
