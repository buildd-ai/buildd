import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { runVerificationCommand, type VerificationResult } from '../../src/verification';

describe('runVerificationCommand', () => {
  it('returns success when command exits with 0', async () => {
    const result = await runVerificationCommand('echo "all tests pass"', '/tmp');
    expect(result.success).toBe(true);
    expect(result.output).toContain('all tests pass');
  });

  it('returns failure when command exits with non-zero', async () => {
    const result = await runVerificationCommand('exit 1', '/tmp');
    expect(result.success).toBe(false);
  });

  it('returns failure with output when command fails', async () => {
    const result = await runVerificationCommand('echo "FAIL: test_foo" && exit 1', '/tmp');
    expect(result.success).toBe(false);
    expect(result.output).toContain('FAIL: test_foo');
  });

  it('returns failure on timeout', async () => {
    const result = await runVerificationCommand('sleep 10', '/tmp', { timeoutMs: 500 });
    expect(result.success).toBe(false);
    expect(result.output).toContain('timed out');
  });

  it('truncates very long output', async () => {
    // Generate output longer than 10KB
    const result = await runVerificationCommand(
      'for i in $(seq 1 500); do echo "line $i: some test output that is fairly long to fill up space"; done && exit 1',
      '/tmp',
    );
    expect(result.success).toBe(false);
    // Output should be truncated to ~10KB
    expect(result.output.length).toBeLessThan(15000);
  });

  it('captures stderr in output', async () => {
    const result = await runVerificationCommand('echo "stderr msg" >&2 && exit 1', '/tmp');
    expect(result.success).toBe(false);
    expect(result.output).toContain('stderr msg');
  });

  it('uses the provided cwd', async () => {
    const result = await runVerificationCommand('pwd', '/tmp');
    expect(result.success).toBe(true);
    // macOS resolves /tmp to /private/tmp
    expect(result.output).toMatch(/\/?tmp/);
  });
});
