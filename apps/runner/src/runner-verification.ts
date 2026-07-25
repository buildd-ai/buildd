/**
 * Runner-side verification for loop-until-verified tasks.
 *
 * When a task carries loopConfig with exitCondition.type='command', the runner
 * executes the configured command in the task worktree after the agent finishes,
 * captures the result as tamper-evident evidence, and includes it in the
 * completion payload. The server (next task) owns the state transition; the
 * runner only supplies evidence.
 *
 * exitCondition.type='pr_checks_green': no runner work — server reads
 * webhook-maintained CI facts. Nothing runner-side is needed.
 *
 * exitCondition.type='structured_predicate': runner already sends structuredOutput
 * in the completion payload; no additional execution is required here.
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const pexec = promisify(exec);

/** Per-stream byte limit for captured stdout/stderr excerpts. */
export const VERIFICATION_EXCERPT_BYTES = 4096;

/** Default wall-clock timeout for the verification command. */
export const VERIFICATION_COMMAND_TIMEOUT_MS = 60_000;

export type VerificationOutcome = 'ok' | 'failed' | 'timeout' | 'exec_error';

/**
 * Structured evidence returned to the server after the runner runs the
 * verification command. Bound to workerId + iteration so the server can
 * reject stale or mismatched payloads.
 */
export interface VerificationEvidence {
  workerId: string;
  iteration: number;
  conditionType: 'command' | 'pr_checks_green' | 'structured_predicate';
  command?: string;
  exitCode?: number;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  outcome: VerificationOutcome;
}

export interface LoopExitConditionCommand {
  type: 'command';
  command?: string;
}

/**
 * Truncate a string so its UTF-8 representation does not exceed `limit` bytes.
 * Splits on character boundaries to avoid producing invalid Unicode.
 */
export function truncateExcerpt(text: string, limit = VERIFICATION_EXCERPT_BYTES): string {
  if (Buffer.byteLength(text, 'utf-8') <= limit) return text;
  // Walk codepoints until we exceed the byte budget.
  let byteLen = 0;
  let charIdx = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, 'utf-8');
    if (byteLen + charBytes > limit) break;
    byteLen += charBytes;
    charIdx += char.length; // surrogate pairs are length-2 in JS strings
  }
  return text.slice(0, charIdx);
}

/**
 * Resolve the command string from loopConfig's exitCondition and/or the task
 * context verificationCommand. exitCondition.command takes priority.
 */
export function resolveCommand(
  exitCondition: LoopExitConditionCommand,
  taskContext: Record<string, unknown> | undefined,
): string | undefined {
  const fromCondition = exitCondition.command?.trim();
  if (fromCondition) return fromCondition;
  const fromContext = taskContext?.verificationCommand;
  if (typeof fromContext === 'string' && fromContext.trim()) return fromContext.trim();
  return undefined;
}

/**
 * Execute the verification command in `cwd`, capture stdout/stderr up to
 * VERIFICATION_EXCERPT_BYTES each, and return tamper-evident evidence bound
 * to the given workerId and iteration.
 *
 * Timeout and exec failures are NOT code failures — they produce distinct
 * outcome values ('timeout' / 'exec_error') so the server can decide the
 * loop state transition.
 */
export async function runVerificationCommand(opts: {
  workerId: string;
  iteration: number;
  command: string;
  cwd: string;
  timeoutMs?: number;
}): Promise<VerificationEvidence> {
  const { workerId, iteration, command, cwd } = opts;
  const timeoutMs = opts.timeoutMs ?? VERIFICATION_COMMAND_TIMEOUT_MS;

  const base: Omit<VerificationEvidence, 'outcome'> = {
    workerId,
    iteration,
    conditionType: 'command',
    command,
  };

  const start = Date.now();
  try {
    const { stdout, stderr } = await pexec(command, {
      cwd,
      timeout: timeoutMs,
      encoding: 'utf-8',
      // Inherit no extra env so the command runs cleanly in the worktree
      env: process.env,
    });
    const durationMs = Date.now() - start;
    return {
      ...base,
      exitCode: 0,
      durationMs,
      stdout: truncateExcerpt(stdout ?? ''),
      stderr: truncateExcerpt(stderr ?? ''),
      outcome: 'ok',
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const e = err as NodeJS.ErrnoException & {
      code?: number | string;
      killed?: boolean;
      signal?: string;
      stdout?: string;
      stderr?: string;
    };

    // child_process timeout: err.killed === true and err.signal === 'SIGTERM'
    const isTimeout = e.killed === true || e.signal === 'SIGTERM' || e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    if (isTimeout) {
      return { ...base, durationMs, outcome: 'timeout' };
    }

    // Non-zero exit code: err.code is the numeric exit code
    if (typeof e.code === 'number') {
      return {
        ...base,
        exitCode: e.code,
        durationMs,
        stdout: truncateExcerpt(e.stdout?.toString?.() ?? ''),
        stderr: truncateExcerpt(e.stderr?.toString?.() ?? ''),
        outcome: 'failed',
      };
    }

    // Could not launch (ENOENT, permission denied, etc.)
    return {
      ...base,
      durationMs,
      stderr: truncateExcerpt(e.message ?? String(err)),
      outcome: 'exec_error',
    };
  }
}
