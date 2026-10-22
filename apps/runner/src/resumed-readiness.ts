/**
 * Readiness on a resumed checkpoint.
 *
 * The provision gate (env-verify.ts) runs the repo's declared readiness command
 * before the agent starts. On a fresh claim the tree is the base branch, so a
 * failure there is the base's problem and blocking is right: no agent budget is
 * spent on a tree nobody in this task can be blamed for.
 *
 * A retry that resumes the task's own branch is different. Its tree carries the
 * prior attempt's commits, e.g. a WIP checkpoint pushed when a usage limit hit
 * mid-change. If that checkpoint fails readiness, blocking means every retry
 * fails in provisioning before an agent turn, and the only session that could
 * repair the branch never starts.
 *
 * So, for a resumed tree only, and only for the readiness phase (toolchain,
 * install, env and provision still block, and run first), the failure is handed
 * to the session as its first job instead of ending it. The check is not waived:
 * the same command is re-run before every push, create_pr and successful
 * complete_task, and denies the call until it passes. That needs a PreToolUse
 * seam, so a backend without one (Codex) keeps the blocking behaviour.
 */
import { execFileSync } from 'child_process';
import { isBuilddActionTool } from '@buildd/shared';
import {
  executeSteps,
  planSteps,
  resolveManifest,
  type CommandRunner,
  type FsProbe,
  type ProvisionGateResult,
  type Step,
} from './env-verify';
import { denyPreToolUse } from './hook-factory';
import { isShipCommand } from './path-claim-enforcement';
import { runnerDenial } from './runner-denial';

/** Why this session's tree is not a clean base checkout. */
export interface ResumedTree {
  /** The prior attempt's branch the worktree was resumed from. */
  from: string;
}

export interface DeferredReadiness {
  /** The readiness step to re-run at ship time, exactly as the gate ran it. */
  step: Step;
  /** First-line diagnosis, as recorded on a blocked worker. */
  message: string;
  /** Tail of the failing command's output. */
  output: string;
  resumedFrom: string;
}

/**
 * Should this gate failure become repair context instead of a block? Only when
 * the tree is a resumed checkpoint, the ONLY failure is readiness, and the
 * session can enforce the re-check at ship time.
 */
export function deferrableReadinessFailure(p: {
  gate: ProvisionGateResult;
  resumed: ResumedTree | null | undefined;
  canEnforceAtShip: boolean;
  root: string;
  /** Filesystem probe for tests; defaults to the real fs at `root`. */
  fs?: FsProbe;
}): DeferredReadiness | null {
  const { gate, resumed } = p;
  if (!gate.enforced || gate.ok || !resumed || !p.canEnforceAtShip) return null;
  if (gate.failure?.phase !== 'readiness') return null;
  // Every other phase must have actually passed — a skipped earlier phase
  // (warm cache, runner-owned) is fine, a failed one never reaches here.
  if (gate.steps.some((s) => s.status === 'fail' && s.phase !== 'readiness')) return null;
  const failed = gate.steps.find((s) => s.phase === 'readiness' && s.status === 'fail');
  if (!failed) return null;

  const { manifest } = resolveManifest(p.root, p.fs);
  const step = manifest ? planSteps(manifest).find((s) => s.phase === 'readiness') : undefined;
  if (!step?.command) return null;

  return { step, message: failed.message, output: failed.output ?? '', resumedFrom: resumed.from };
}

/** System-prompt section that makes the repair the session's first job. */
export function readinessRepairSection(d: DeferredReadiness): string {
  const output = d.output.trim();
  return [
    '',
    '',
    '## First: this branch fails the repository readiness check',
    `You are resuming \`${d.resumedFrom}\`, which a previous attempt left unfinished. The repository's readiness command fails on it:`,
    '',
    '```',
    `$ ${d.step.command}`,
    output || d.message,
    '```',
    '',
    'A fresh claim would have been stopped here. You were started anyway because the failure is most likely in the unfinished work on this branch, and you are the one who can repair it.',
    `Fix what it reports first, then run \`${d.step.command}\` yourself and make sure it passes.`,
    'Pushing, create_pr and complete_task are refused until it does. If the failure is genuinely not caused by this branch, report that with complete_task and an error instead of working around the check.',
  ].join('\n');
}

export interface ReadinessGuardDeps {
  deferred: DeferredReadiness;
  cwd: string;
  env: NodeJS.ProcessEnv;
  runCommand?: CommandRunner;
  headSha?: (cwd: string) => string | null;
  milestone?: (label: string) => void;
}

function gitHead(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf-8', timeout: 5_000 }).trim() || null;
  } catch {
    return null;
  }
}

type ShipKind = 'push' | 'create_pr' | 'complete_task';

function shipKind(toolName: string, toolInput: Record<string, any>): ShipKind | null {
  if (toolName === 'Bash') return isShipCommand(toolInput.command) ? 'push' : null;
  if (!isBuilddActionTool(toolName)) return null;
  if (toolInput.action === 'create_pr') return 'create_pr';
  // A failure report is how the agent says "not caused by this branch"; never refuse it.
  if (toolInput.action === 'complete_task' && !toolInput.params?.error) return 'complete_task';
  return null;
}

/**
 * PreToolUse guard: re-run the deferred readiness command before a ship and
 * deny it unless the command passes. Strict, unlike the advisory workspace
 * preflight: this check already failed on this branch, so "could not run" is
 * not evidence that it was fixed. A head that passed is not re-checked.
 */
export function createResumedReadinessGuard(deps: ReadinessGuardDeps) {
  const headSha = deps.headSha ?? gitHead;
  let passedHead: string | null = null;
  let reportedPass = false;

  return async (input: unknown): Promise<Record<string, unknown>> => {
    const i = (input ?? {}) as { hook_event_name?: string; tool_name?: string; tool_input?: Record<string, any> };
    if (i.hook_event_name !== 'PreToolUse') return {};
    const kind = shipKind(i.tool_name ?? '', i.tool_input ?? {});
    if (!kind) return {};

    const head = headSha(deps.cwd);
    if (head && head === passedHead) return {};

    const [result] = await executeSteps([deps.deferred.step], {
      root: deps.cwd,
      env: deps.env,
      ...(deps.runCommand ? { runCommand: deps.runCommand } : {}),
    });
    if (result && result.status !== 'fail') {
      passedHead = head;
      if (!reportedPass) {
        reportedPass = true;
        deps.milestone?.('Readiness check passes on the repaired branch');
      }
      return {};
    }

    deps.milestone?.(`Readiness still failing — ${kind} refused`);
    const output = (result?.output || result?.message || '').trim();
    return denyPreToolUse(runnerDenial(
      `this branch still fails the repository readiness check \`${deps.deferred.step.command}\` (${result?.message ?? 'failed'}), ` +
        `and it must pass before ${kind === 'push' ? 'a push' : kind}. Output:\n${output}`,
      'fix what it reports, commit, and try again; if the failure is not caused by this branch, call complete_task with an error saying so',
    ));
  };
}
