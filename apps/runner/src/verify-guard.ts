/**
 * Keeps a whole-project verify run from being killed before it finishes, and a
 * success from being reported over one that was.
 *
 * What happened, repeatedly: Claude Code's Bash tool kills a command after
 * 2 minutes unless the call passes a longer `timeout`, and agents wrap the
 * long ones in a shell `timeout 120` as well. This repo's full test suite and
 * its project-wide typecheck take 4 to 8 minutes, so `bun run test` and
 * `bun run type-check` died with "Command timed out after 2m 0s" (exit 143),
 * the agent read the partial output as a pass, called complete_task, and the
 * server flagged `last_command_failed` after the fact. Each one cost a CI
 * round and a review round.
 *
 * Three deterministic pieces, none of them prompt text:
 *  1. The agent env raises the Bash tool's default timeout to what a
 *     whole-project run needs (BASH_DEFAULT_TIMEOUT_MS / BASH_MAX_TIMEOUT_MS,
 *     both read by the Claude Code CLI).
 *  2. A PreToolUse deny for a whole-project test, typecheck or build that the
 *     call itself caps below the floor, by the `timeout` parameter or a shell
 *     `timeout N` wrapper. A targeted run (a file named on the command line)
 *     may be capped as short as the agent likes: it finishes in seconds.
 *  3. A PreToolUse deny for complete_task while the last test / typecheck /
 *     lint command failed and no later run of its kind passed, read from the
 *     same state the runner keeps for the bash_verify_recovered marker. A
 *     failure report (`error`), a wait (`blockedOnTaskId`) and a scratch
 *     completion (`discardEdits`) are never refused; a reviewer may request
 *     changes on a red run, but not approve on one.
 */

import { verifyFamilyOf, type VerifyFamily } from '@buildd/core/bash-failure-trace';
import { isBuilddActionTool } from '@buildd/shared';
import { unrecoveredVerifyFailures, type OpenVerifyFailure } from './error-trace-scanner';
import { denyPreToolUse } from './hook-factory';
import { runnerDenial } from './runner-denial';
import type { LocalWorker } from './types';

/** The least a whole-project verify may be capped at: a 4-8 minute suite has to finish. */
export const VERIFY_TIMEOUT_FLOOR_MS = 10 * 60_000;
/** The Bash tool's timeout when the call passes none. Was the CLI's own 2 minutes. */
export const BASH_DEFAULT_TIMEOUT_MS = VERIFY_TIMEOUT_FLOOR_MS;
/** The most a call may ask for. The CLI's own ceiling is 10 minutes, which a build plus tests can exceed. */
export const BASH_MAX_TIMEOUT_MS = 30 * 60_000;

/** Sets the Bash timeout env on `env`, over any inherited value. Mutates and returns `env`. */
export function applyBashTimeoutEnv<T extends Record<string, string | undefined>>(env: T): T {
  Object.assign(env, {
    BASH_DEFAULT_TIMEOUT_MS: String(BASH_DEFAULT_TIMEOUT_MS),
    BASH_MAX_TIMEOUT_MS: String(BASH_MAX_TIMEOUT_MS),
  });
  return env;
}

export type WholeVerifyFamily = VerifyFamily | 'build';

export interface WholeProjectVerify {
  family: WholeVerifyFamily;
  /** The segment that runs it, trimmed. */
  segment: string;
  /** The cap a leading shell `timeout N` wrapper puts on it, in ms, or null. */
  shellTimeoutMs: number | null;
}

/** Words that run the next word as the command. */
const WRAPPERS = new Set(['time', 'env', 'nice', 'nohup', 'exec', 'command', 'xargs']);
/** `timeout` flags that take a separate argument. */
const TIMEOUT_FLAGS_WITH_ARG = new Set(['-k', '--kill-after', '-s', '--signal']);
const BUILD_RE = /(?:^|[\s;&|(])(?:(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?build\S*|next\s+build|turbo\s+(?:run\s+)?build)(?:\s|$)/;
/** Runners whose file arguments make the run targeted. The package-script forms (`bun run test`) are always whole. */
const DIRECT_TEST_RUNNER_RE = /^(?:bun\s+test|vitest|jest|pytest|bun\s+run\s+\S*run-unit-tests\S*)(?:\s|$)/;
const FILE_ARG_RE = /^[^-].*\.(?:tsx?|jsx?|mjs|cjs|py|go|rs)$/;

const DURATION_UNIT_MS: Record<string, number> = { '': 1000, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function durationMs(token: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(token);
  return m ? Number(m[1]) * DURATION_UNIT_MS[m[2]] : null;
}

/**
 * The command words of one pipeline segment past env assignments and wrappers,
 * and the cap a leading `timeout` put on it.
 */
function strip(segment: string): { words: string[]; shellTimeoutMs: number | null } {
  const words = segment.trim().replace(/^[({\s!]+/, '').split(/\s+/).filter(Boolean);
  let shellTimeoutMs: number | null = null;
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i++; continue; }
    if (w === 'timeout') {
      i++;
      while (i < words.length && words[i]!.startsWith('-')) {
        i += TIMEOUT_FLAGS_WITH_ARG.has(words[i]!) ? 2 : 1;
      }
      const d = i < words.length ? durationMs(words[i]!) : null;
      if (d !== null) { shellTimeoutMs = shellTimeoutMs === null ? d : Math.min(shellTimeoutMs, d); i++; }
      continue;
    }
    if (WRAPPERS.has(w)) {
      i++;
      while (i < words.length && /^-/.test(words[i]!)) i++;
      continue;
    }
    break;
  }
  return { words: words.slice(i), shellTimeoutMs };
}

function familyOf(words: string[]): WholeVerifyFamily | null {
  const text = words.join(' ');
  if (BUILD_RE.test(text)) return 'build';
  const family = verifyFamilyOf(text);
  if (!family || family === 'lint') return null;
  // A file named on the command line: a targeted run, seconds long.
  if (family === 'test' && !DIRECT_TEST_RUNNER_RE.test(text)) return 'test';
  const program = DIRECT_TEST_RUNNER_RE.exec(text)?.[0].trim().split(/\s+/).length ?? 1;
  const args = family === 'test' ? words.slice(program) : words.slice(1);
  if (args.some(a => FILE_ARG_RE.test(a))) return null;
  return family;
}

/**
 * The first whole-project test, typecheck or build in `command`, or null. A
 * segment is one simple command: the text is split on `&&`, `||`, `;`, `|`,
 * newlines and command substitution, so `cd x && bun run test | tail` finds
 * the test run. A quoted mention (`echo "bun run test"`) is not a run.
 */
export function wholeProjectVerify(command: string): WholeProjectVerify | null {
  if (!command) return null;
  for (const raw of command.split(/&&|\|\||[;|\n`]|\$\(/)) {
    const segment = raw.trim();
    if (!segment || /^["']/.test(segment)) continue;
    const { words, shellTimeoutMs } = strip(segment);
    if (!words.length || /["']/.test(words[0]!)) continue;
    const family = familyOf(words);
    if (family) return { family, segment, shellTimeoutMs };
  }
  return null;
}

export interface VerifyTimeoutVerdict {
  reason: string;
  hint: string;
}

const FAMILY_WORD: Record<WholeVerifyFamily, string> = {
  test: 'the full test suite',
  typecheck: 'a project-wide typecheck',
  lint: 'a lint run',
  build: 'a build',
};

function minutes(ms: number): string {
  const m = ms / 60_000;
  return `${Number.isInteger(m) ? m : m.toFixed(1)} min`;
}

/**
 * Why `command` would be killed before it finishes, or null. `toolTimeoutMs` is
 * the Bash call's own `timeout` parameter; absent, the raised default applies
 * and only a shell wrapper can cut the run short.
 */
export function shortVerifyTimeout(command: string, toolTimeoutMs: number | undefined): VerifyTimeoutVerdict | null {
  const whole = wholeProjectVerify(command);
  if (!whole) return null;
  const caps = [whole.shellTimeoutMs, typeof toolTimeoutMs === 'number' && toolTimeoutMs > 0 ? toolTimeoutMs : null]
    .filter((c): c is number => c !== null);
  if (!caps.length) return null;
  const cap = Math.min(...caps);
  if (cap >= VERIFY_TIMEOUT_FLOOR_MS) return null;
  const by = whole.shellTimeoutMs !== null && whole.shellTimeoutMs === cap ? 'the shell `timeout` wrapper' : 'the Bash tool `timeout` parameter';
  return {
    reason:
      `this command runs ${FAMILY_WORD[whole.family]} (\`${whole.segment.slice(0, 120)}\`) capped at ${minutes(cap)} by ${by}, ` +
      `and here it needs up to ${minutes(VERIFY_TIMEOUT_FLOOR_MS)}: the cap would kill it with exit 143 before it finished, ` +
      'which reads as a failed run and is recorded as one',
    hint:
      `run it with no shell \`timeout\` wrapper and either no Bash timeout parameter (the default here is ${minutes(BASH_DEFAULT_TIMEOUT_MS)}) ` +
      `or timeout: ${VERIFY_TIMEOUT_FLOOR_MS} or more (up to ${minutes(BASH_MAX_TIMEOUT_MS)}); to check one change quickly, run its own test file instead`,
  };
}

function describe(f: OpenVerifyFailure): string {
  const how = f.timedOut
    ? `was killed by its timeout (exit ${f.exitCode}) before it finished`
    : `exited ${f.exitCode}`;
  return `the last ${f.family} command, \`${f.command.slice(0, 140)}\`, ${how} and no later ${f.family} run passed`;
}

const APPROVE_VERDICT = 'approve';

function isSuccessCompletion(input: Record<string, unknown>): boolean {
  if (input.action !== 'complete_task') return false;
  const params = (input.params ?? {}) as Record<string, unknown>;
  // A failure report, a wait on another task and a scratch completion are not a success claim.
  return !params.error && !params.blockedOnTaskId && !params.discardEdits;
}

function approves(input: Record<string, unknown>): boolean {
  const params = (input.params ?? {}) as Record<string, unknown>;
  const out = params.structuredOutput as { verdict?: unknown } | null | undefined;
  return out?.verdict === APPROVE_VERDICT;
}

export interface VerifyGuardDeps {
  worker: Pick<LocalWorker, 'id'>;
  /** A reviewer's red run is its finding: only an approve over one is refused. */
  isReviewer: boolean;
  /** Test seam; defaults to the scanner's own state. */
  openFailures?: (workerId: string) => OpenVerifyFailure[];
  log?: (line: string) => void;
}

/**
 * The PreToolUse hook. Register it for the Claude backend (Codex has no
 * PreToolUse seam); it reads Bash calls and buildd action calls and returns
 * {} for everything else.
 */
export function createVerifyGuardHook(deps: VerifyGuardDeps) {
  const openFailures = deps.openFailures ?? unrecoveredVerifyFailures;
  const log = deps.log ?? ((line: string) => console.log(`[Worker ${deps.worker.id}] ${line}`));

  return async (input: unknown): Promise<Record<string, unknown>> => {
    const i = (input ?? {}) as { hook_event_name?: string; tool_name?: string; tool_input?: Record<string, unknown> };
    if (i.hook_event_name !== 'PreToolUse') return {};
    const toolName = i.tool_name ?? '';
    const toolInput = i.tool_input ?? {};

    if (toolName === 'Bash') {
      const command = typeof toolInput.command === 'string' ? toolInput.command : '';
      const timeout = typeof toolInput.timeout === 'number' ? toolInput.timeout : undefined;
      const short = shortVerifyTimeout(command, timeout);
      if (!short) return {};
      log(`Refused a short-capped verify run: ${command.slice(0, 80)}`);
      return denyPreToolUse(runnerDenial(short.reason, short.hint));
    }

    if (!isBuilddActionTool(toolName) || !isSuccessCompletion(toolInput)) return {};
    if (deps.isReviewer && !approves(toolInput)) return {};
    const open = openFailures(deps.worker.id);
    if (!open.length) return {};
    log(`Refused complete_task over an unrecovered verify failure: ${open.map(f => `${f.family} exit ${f.exitCode}`).join(', ')}`);
    const what = deps.isReviewer ? 'this approve' : 'this success';
    return denyPreToolUse(runnerDenial(
      `${what} is not supported by the record: ${open.map(describe).join('; ')}`,
      `run it again to completion (a whole-project run needs up to ${minutes(VERIFY_TIMEOUT_FLOOR_MS)} here; do not cap it with a shell \`timeout\` ` +
        `or a short Bash timeout parameter), fix what it reports, and then call complete_task; ` +
        `if the failure is not caused by this branch, call complete_task with an error saying so`,
    ));
  };
}
