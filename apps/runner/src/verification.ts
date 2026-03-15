/**
 * Verification command runner for the Ralph loop.
 *
 * After an agent completes work, the runner can execute a verification command
 * (e.g., `bun test && bun run build`) to validate the output. If verification
 * fails, the task is marked as failed with the verification output, enabling
 * the retry loop.
 *
 * Uses Bun.spawnSync instead of child_process.execSync to avoid mock.module
 * pollution from other test files in the Bun test runner.
 */

export interface VerificationResult {
  success: boolean;
  output: string;
  exitCode: number | null;
  durationMs: number;
}

interface VerificationOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_OUTPUT_LENGTH = 10_000; // 10KB — enough for useful error context

/**
 * Run a verification command in the given working directory.
 *
 * @param command - Shell command to execute (e.g., "bun test && bun run build")
 * @param cwd - Working directory (typically the worktree path)
 * @param options - Optional timeout configuration
 * @returns Verification result with success status, output, and timing
 */
export async function runVerificationCommand(
  command: string,
  cwd: string,
  options: VerificationOptions = {},
): Promise<VerificationResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();

  try {
    const proc = Bun.spawnSync(['/bin/bash', '-c', command], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: timeoutMs,
    });

    const stdout = proc.stdout?.toString() || '';
    const stderr = proc.stderr?.toString() || '';
    const durationMs = Date.now() - start;

    if (proc.signalCode === 'SIGTERM' || proc.signalCode === 'SIGKILL') {
      return {
        success: false,
        output: truncateOutput(`Verification command timed out after ${timeoutMs}ms\n${stdout}${stderr}`),
        exitCode: null,
        durationMs,
      };
    }

    if (proc.exitCode === 0) {
      return {
        success: true,
        output: truncateOutput(stdout || ''),
        exitCode: 0,
        durationMs,
      };
    }

    const combined = `${stdout}${stderr ? '\n--- stderr ---\n' + stderr : ''}`;
    return {
      success: false,
      output: truncateOutput(combined || `Command failed with exit code ${proc.exitCode}`),
      exitCode: proc.exitCode ?? null,
      durationMs,
    };
  } catch (err: any) {
    const durationMs = Date.now() - start;
    return {
      success: false,
      output: truncateOutput(err.message || 'Unknown error'),
      exitCode: null,
      durationMs,
    };
  }
}

/**
 * Truncate output to MAX_OUTPUT_LENGTH, keeping the end (most useful for errors).
 */
function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_LENGTH) return output.trim();
  return `...[truncated]...\n${output.slice(-MAX_OUTPUT_LENGTH)}`.trim();
}
