/**
 * Dependencies in the background, behind a gate (cloud executor only).
 *
 * On a fresh cloud container the dependency cache restore (warm-repo.ts) and
 * the install (git-operations.ts installWorkspaceDeps) take one to several
 * minutes, dominated by inode creation the host makes erratic. Neither can be
 * made much faster in place, but neither has to block the agent: its first
 * turns read the task and the code. So the session starts as soon as the repo
 * is checked out, the deps work runs here in the background, and a PreToolUse
 * hook on Bash holds only the commands that need it (commandNeedsDeps).
 *
 * Hook model: hold, with a cap. A held command waits for the install up to
 * DEPS_GATE_HOLD_MS and then runs as if nothing happened, so the common short
 * tail costs no model turn and no retry. Past the cap it is denied with
 * "dependencies still installing (n s so far)", so a multi-minute install
 * never looks like a frozen tool call, the SDK's hook timeout is never the
 * thing that decides, and the agent can do other work and come back. Denying
 * at once instead would spend a turn on every early command, which is most of
 * what the overlap is meant to save.
 *
 * knowledge-base: buildd/design/cloud-runner-warm-handover.md, section 2.
 */

import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { InstallOutcome } from './git-operations';
import { denyPreToolUse } from './hook-factory';
import { runnerDenial } from './runner-denial';
import { emitMetric, emitPhase } from './phase-lines';
import { formatInstallDir } from './install-diagnosis';

/** How long one held command waits for the install before it is denied. */
export const DEPS_GATE_HOLD_MS = 45_000;
/** The matcher's SDK timeout (seconds): the hold plus headroom, so the cap always decides first. */
export const DEPS_GATE_HOOK_TIMEOUT_S = Math.ceil(DEPS_GATE_HOLD_MS / 1000) + 15;

// ── Which commands need dependencies ──────────────────────────────────────────

/**
 * Programs that read node_modules (or build through something that does).
 * Everything else, git, rg, ls, cat and the like included, never waits.
 */
const NEEDS_DEPS = new Set([
  // package managers
  'npm', 'pnpm', 'yarn', 'bun', 'npx', 'pnpx', 'bunx', 'corepack',
  // runtimes that resolve packages
  'node', 'tsx', 'ts-node',
  // build and test tools
  'turbo', 'nx', 'tsc', 'vitest', 'jest', 'next', 'vite', 'webpack', 'eslint', 'playwright', 'make',
]);

/** Words that run the next word as the command. */
const WRAPPERS = new Set(['time', 'env', 'nice', 'nohup', 'exec', 'command', 'sudo', 'xargs', 'timeout']);

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The program a simple command runs, after env assignments and wrappers. */
function programOf(segment: string): string | null {
  const words = segment.trim().replace(/^[({\s!]+/, '').split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    if (ASSIGNMENT_RE.test(w)) { i++; continue; }
    if (WRAPPERS.has(w)) {
      i++;
      // `timeout 60 cmd`, `nice -n 5 cmd`, `env -i cmd`: skip flags and a duration.
      while (i < words.length && (/^-/.test(words[i]!) || /^\d+[smhd]?$/.test(words[i]!))) i++;
      continue;
    }
    return w.replace(/^['"]|['"]$/g, '');
  }
  return null;
}

/**
 * Whether a Bash command needs the dependency install to have finished. True
 * when any simple command in it (split on `;`, `&&`, `||`, `|`, newlines,
 * `$(`, backticks) runs one of NEEDS_DEPS, by name or by path, or anything
 * under `node_modules/.bin`.
 *
 * A heuristic over the text, by design (the design doc's open question): a
 * miss lets a command through that then fails as it would have without the
 * gate; a false hit holds a harmless command until the install ends.
 */
export function commandNeedsDeps(command: string): boolean {
  if (!command) return false;
  if (/node_modules\/\.bin\//.test(command)) return true;
  for (const segment of command.split(/&&|\|\||[;|\n`]|\$\(/)) {
    const program = programOf(segment);
    if (!program) continue;
    const name = program.slice(program.lastIndexOf('/') + 1);
    if (NEEDS_DEPS.has(name)) return true;
  }
  return false;
}

// ── The background job ────────────────────────────────────────────────────────

/** The dependency install running behind the gate, and what it ended with. */
export class DepsJob {
  readonly startedAt: number;
  readonly promise: Promise<InstallOutcome>;
  outcome: InstallOutcome | null = null;
  settledAt: number | null = null;

  constructor(work: () => Promise<InstallOutcome>, private readonly now: () => number = Date.now) {
    this.startedAt = now();
    this.promise = (async () => {
      let outcome: InstallOutcome;
      try {
        outcome = await work();
      } catch (err) {
        outcome = { status: 'failed', dir: '.', failure: 'unknown', message: err instanceof Error ? err.message : String(err) };
      }
      this.outcome = outcome;
      this.settledAt = this.now();
      emitPhase('deps_ready');
      return outcome;
    })();
    trackDepsWork(this.promise);
  }

  get settled(): boolean {
    return this.outcome !== null;
  }

  /** Wait for the job up to `ms`. True when it settled in time. */
  async wait(ms: number, signal?: AbortSignal): Promise<boolean> {
    if (this.settled) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const capped = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
      onAbort = () => resolve(false);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([this.promise.then(() => true as const), capped]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  }
}

// ── The gate ──────────────────────────────────────────────────────────────────

export interface DepsGateStats {
  /** When the agent first ran a command that needs deps (held or not). */
  firstGatedToolAt: number | null;
  /** Total time commands spent held. */
  gateWaitMs: number;
  /** Commands held at least briefly. */
  holds: number;
  /** Holds that hit the cap and were denied. */
  denials: number;
}

export interface DepsGateOptions {
  holdMs?: number;
  now?: () => number;
  /** A held command was released by a failed install: the caller surfaces it like any install failure. */
  onFailureSeen?: (outcome: Extract<InstallOutcome, { status: 'failed' }>) => void;
}

/** What the agent is told once, on its first deps command after a failed install. */
export function installFailureContext(outcome: Extract<InstallOutcome, { status: 'failed' }>): string {
  return `The runner's dependency install failed (${outcome.failure} at ${formatInstallDir(outcome.dir)}), ` +
    'so node_modules may be absent or incomplete. Run the install yourself before trusting a build or test result; ' +
    'if it cannot be fixed, report blocked rather than completing.';
}

/**
 * The PreToolUse hook. Register it with matcher `Bash` and timeout
 * DEPS_GATE_HOOK_TIMEOUT_S. `stats` is updated in place and mirrored to the
 * run report (first_gated_tool phase, gate_wait_ms / gate_holds metrics).
 */
export function createDepsGateHook(job: DepsJob, stats: DepsGateStats, opts: DepsGateOptions = {}): HookCallback {
  const holdMs = opts.holdMs ?? DEPS_GATE_HOLD_MS;
  const now = opts.now ?? Date.now;
  let failureNoticeSent = false;

  const afterSettle = () => {
    const o = job.outcome;
    if (o?.status !== 'failed' || failureNoticeSent) return {};
    failureNoticeSent = true;
    opts.onFailureSeen?.(o);
    return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, additionalContext: installFailureContext(o) } };
  };

  return async (input, _toolUseId, { signal }) => {
    if ((input as { hook_event_name?: string }).hook_event_name !== 'PreToolUse') return {};
    if ((input as { tool_name?: string }).tool_name !== 'Bash') return {};
    const command = String(((input as { tool_input?: { command?: unknown } }).tool_input?.command) ?? '');
    if (!commandNeedsDeps(command)) return {};

    if (stats.firstGatedToolAt === null) {
      stats.firstGatedToolAt = now();
      emitPhase('first_gated_tool', { now: () => stats.firstGatedToolAt! });
    }
    if (job.settled) return afterSettle();

    const heldAt = now();
    stats.holds++;
    emitMetric('gate_holds', stats.holds);
    const ready = await job.wait(holdMs, signal);
    stats.gateWaitMs += Math.max(0, now() - heldAt);
    emitMetric('gate_wait_ms', stats.gateWaitMs);
    if (ready) return afterSettle();

    stats.denials++;
    const soFar = Math.round((now() - job.startedAt) / 1000);
    return denyPreToolUse(runnerDenial(
      `dependencies still installing (${soFar} s so far); this command needs them, so it was held ${Math.round(holdMs / 1000)} s and not run`,
      'read code, plan or run commands that do not need node_modules (git, rg, cat), then run this one again; it waits for the install by itself',
    ));
  };
}

// ── Background work the run end must wait for ────────────────────────────────

const pending = new Set<Promise<unknown>>();
let prelude: Promise<void> | null = null;

/** Count `p` as dependency work in flight (depsWorkSettled waits for it). */
export function trackDepsWork(p: Promise<unknown>): void {
  pending.add(p);
  const done = () => { pending.delete(p); };
  p.then(done, done);
}

/**
 * What the install has to wait for: the dependency cache restore a warm
 * restore started in the background (warm-repo.ts deferCache). Set once per
 * process; a host runner never sets it.
 */
export function setDepsPrelude(p: Promise<void>): void {
  prelude = p;
  trackDepsWork(p);
}

export function depsPrelude(): Promise<void> {
  return prelude ?? Promise.resolve();
}

/** Resolves once no dependency work is in flight: the warm upload waits on it. */
export async function depsWorkSettled(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

/** Test hook. */
export function __resetDepsWork(): void {
  pending.clear();
  prelude = null;
}
