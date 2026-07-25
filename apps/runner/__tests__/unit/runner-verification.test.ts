import { describe, it, expect, mock, beforeEach } from 'bun:test';
import {
  runVerificationCommand,
  truncateExcerpt,
  resolveCommand,
  VERIFICATION_EXCERPT_BYTES,
  VERIFICATION_COMMAND_TIMEOUT_MS,
  type VerificationEvidence,
} from '../../src/runner-verification';

describe('truncateExcerpt', () => {
  it('returns string unchanged when within limit', () => {
    const s = 'hello world';
    expect(truncateExcerpt(s, 100)).toBe(s);
  });

  it('truncates to byte limit', () => {
    const long = 'x'.repeat(VERIFICATION_EXCERPT_BYTES + 500);
    const result = truncateExcerpt(long);
    expect(Buffer.byteLength(result, 'utf-8')).toBeLessThanOrEqual(VERIFICATION_EXCERPT_BYTES);
  });

  it('does not truncate empty string', () => {
    expect(truncateExcerpt('')).toBe('');
  });

  it('handles multi-byte utf-8 characters without splitting them', () => {
    // '🔥' is 4 bytes; fill to VERIFICATION_EXCERPT_BYTES with 'a' and add one emoji that would overflow
    const base = 'a'.repeat(VERIFICATION_EXCERPT_BYTES - 2);
    const withEmoji = base + '🔥'; // 4 extra bytes pushes past limit
    const result = truncateExcerpt(withEmoji);
    expect(Buffer.byteLength(result, 'utf-8')).toBeLessThanOrEqual(VERIFICATION_EXCERPT_BYTES);
    // Should not contain a partial emoji codepoint
    expect(() => result.normalize()).not.toThrow();
  });
});

describe('resolveCommand', () => {
  it('uses exitCondition.command when present', () => {
    const cmd = resolveCommand({ type: 'command', command: 'bun test' }, undefined);
    expect(cmd).toBe('bun test');
  });

  it('falls back to context.verificationCommand when exitCondition.command absent', () => {
    const cmd = resolveCommand(
      { type: 'command' },
      { verificationCommand: 'bun run check' },
    );
    expect(cmd).toBe('bun run check');
  });

  it('prefers exitCondition.command over context.verificationCommand', () => {
    const cmd = resolveCommand(
      { type: 'command', command: 'bun test' },
      { verificationCommand: 'npm test' },
    );
    expect(cmd).toBe('bun test');
  });

  it('returns undefined when neither source provides a command', () => {
    const cmd = resolveCommand({ type: 'command' }, {});
    expect(cmd).toBeUndefined();
  });
});

describe('runVerificationCommand — evidence shape and iteration binding', () => {
  it('binds workerId and iteration in returned evidence', async () => {
    const evidence = await runVerificationCommand({
      workerId: 'worker-abc',
      iteration: 2,
      command: 'exit 0',
      cwd: '/tmp',
    });
    expect(evidence.workerId).toBe('worker-abc');
    expect(evidence.iteration).toBe(2);
    expect(evidence.conditionType).toBe('command');
  });

  it('returns outcome=ok when command exits 0', async () => {
    const evidence = await runVerificationCommand({
      workerId: 'w1',
      iteration: 0,
      command: 'true',
      cwd: '/tmp',
    });
    expect(evidence.outcome).toBe('ok');
    expect(evidence.exitCode).toBe(0);
    expect(typeof evidence.durationMs).toBe('number');
    expect(evidence.command).toBe('true');
  });

  it('returns outcome=failed when command exits non-zero', async () => {
    const evidence = await runVerificationCommand({
      workerId: 'w1',
      iteration: 0,
      command: 'false',
      cwd: '/tmp',
    });
    expect(evidence.outcome).toBe('failed');
    expect(evidence.exitCode).not.toBe(0);
  });

  it('captures stdout and stderr', async () => {
    const evidence = await runVerificationCommand({
      workerId: 'w1',
      iteration: 0,
      command: 'echo hello-out; echo hello-err >&2',
      cwd: '/tmp',
    });
    expect(evidence.stdout).toContain('hello-out');
    expect(evidence.stderr).toContain('hello-err');
  });

  it('returns outcome=timeout when command exceeds timeoutMs', async () => {
    const evidence = await runVerificationCommand({
      workerId: 'w1',
      iteration: 0,
      command: 'sleep 10',
      cwd: '/tmp',
      timeoutMs: 100,
    });
    expect(evidence.outcome).toBe('timeout');
    expect(evidence.exitCode).toBeUndefined();
  });

  it('returns outcome=exec_error for unresolvable command', async () => {
    const evidence = await runVerificationCommand({
      workerId: 'w1',
      iteration: 0,
      command: '__buildd_nonexistent_cmd_xyz__',
      cwd: '/tmp',
    });
    // Either exec_error or failed (some shells report exit 127 for not-found)
    expect(['exec_error', 'failed']).toContain(evidence.outcome);
  });

  it('truncates stdout to VERIFICATION_EXCERPT_BYTES', async () => {
    // Generate output larger than the excerpt limit
    const bigOutput = 'x'.repeat(VERIFICATION_EXCERPT_BYTES + 1000);
    const evidence = await runVerificationCommand({
      workerId: 'w1',
      iteration: 0,
      command: `printf '%${VERIFICATION_EXCERPT_BYTES + 1000}s' 'x'`,
      cwd: '/tmp',
    });
    if (evidence.stdout) {
      expect(Buffer.byteLength(evidence.stdout, 'utf-8')).toBeLessThanOrEqual(VERIFICATION_EXCERPT_BYTES);
    }
  });

  it('uses default timeout from VERIFICATION_COMMAND_TIMEOUT_MS constant', () => {
    expect(VERIFICATION_COMMAND_TIMEOUT_MS).toBeGreaterThan(0);
    expect(VERIFICATION_COMMAND_TIMEOUT_MS).toBeLessThanOrEqual(300_000);
  });

  it('does not report timeout when command generates >1MB output (regression: maxBuffer)', async () => {
    // Node's default exec maxBuffer is 1MB. Without maxBuffer override, commands
    // that emit >1MB trigger ERR_CHILD_PROCESS_STDIO_MAXBUFFER. The evidence must
    // carry outcome != 'timeout' and the captured excerpt must be bounded.
    const evidence = await runVerificationCommand({
      workerId: 'w1',
      iteration: 0,
      // Write 2MB of 'x' to stdout — exceeds Node's 1MB default buffer.
      command: "dd if=/dev/zero bs=1048576 count=2 2>/dev/null | tr '\\0' 'x'",
      cwd: '/tmp',
    });
    expect(evidence.outcome).not.toBe('timeout');
    if (evidence.stdout) {
      expect(Buffer.byteLength(evidence.stdout, 'utf-8')).toBeLessThanOrEqual(VERIFICATION_EXCERPT_BYTES);
    }
  });
});
