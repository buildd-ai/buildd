/**
 * Server-side Needs You admission for a parked worker (design:
 * packages/core/needs-you.ts). The worker PATCH route calls
 * `disposeParkedWaitingFor` on every incoming `waitingFor` before writing it,
 * so no park is stored without a human-attention disposition:
 *
 *  - permission / confirmation prompts: `ask` (`dispositionBy: 'permission'`).
 *    Only a person can grant a tool; there is nothing for the gate to decide.
 *  - a question tagged `hold` by the gate: lib/question-hold.ts decides
 *    whether the hold stands; one it will not honour becomes an `ask`.
 *  - a question tagged `ask` by the gate: kept, with the gate's outcome/rail.
 *  - a question tagged `recovered` (a session-end park the gate recovered):
 *    kept only when its `repairTaskId` names a task in this workspace;
 *    otherwise re-checked like an untagged one.
 *  - an untagged question (a runner without the `question_gate` feature, a
 *    gate call that failed): `recheckParkedQuestion` — the kill switch, the
 *    hard rails and stage 0 (recover). A re-send of the same question keeps
 *    the disposition its first park got, so a 409 retry files nothing twice.
 *
 * Never throws: every failure stamps `ask`, the pre-gate behaviour.
 */
import type { HardRailKind, QuestionGateOutcome } from '@buildd/core/question-gate';
import type { BriefedQuestion } from '@buildd/core/question-brief';
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';
import { admitsToNeedsYou } from '@buildd/core/needs-you';
import { resolveHold, withoutHold, type HoldResolution } from './question-hold';
import { recheckParkedQuestion, type ParkDisposition, type QuestionCheckDeps, type QuestionCheckScope } from './question-gate-check';

type Q = Record<string, unknown>;

const GATE_OUTCOMES: ReadonlySet<string> = new Set<QuestionGateOutcome>([
  'actionable', 'pushback', 'max_pushbacks', 'sensitive', 'off', 'error', 'hard_rail', 'decided', 'held', 'asked', 'recovered',
]);
const RAILS: ReadonlySet<string> = new Set<HardRailKind>(['migration', 'auth_secrets', 'ci_deploy', 'protected_path', 'spending', 'irreversible']);

/** Every disposition field, so a stamp replaces whatever the runner sent rather than mixing with it. */
function withoutDisposition(q: Q): Q {
  const { disposition: _d, dispositionBy: _b, gateOutcome: _o, rail: _r, repairTaskId: _t, ...rest } = withoutHold(q);
  return rest;
}

function stamp(q: Q, d: ParkDisposition): Q {
  return {
    ...withoutDisposition(q),
    disposition: d.disposition,
    dispositionBy: d.dispositionBy,
    ...(d.gateOutcome ? { gateOutcome: d.gateOutcome } : {}),
    ...(d.rail ? { rail: d.rail } : {}),
    ...(d.repairTaskId ? { repairTaskId: d.repairTaskId } : {}),
  };
}

/** The gate fields a runner sent, kept only when they are values the gate can produce. */
function gateFields(q: Q): Pick<ParkDisposition, 'gateOutcome' | 'rail'> {
  return {
    ...(typeof q.gateOutcome === 'string' && GATE_OUTCOMES.has(q.gateOutcome) ? { gateOutcome: q.gateOutcome as QuestionGateOutcome } : {}),
    ...(typeof q.rail === 'string' && RAILS.has(q.rail) ? { rail: q.rail as HardRailKind } : {}),
  };
}

export interface ParkDispositionInput {
  /** The incoming (already brief-sanitized) `waitingFor`. */
  waitingFor: Q;
  /** What the worker row stores right now. */
  stored: Q | null | undefined;
  /** The gate's scope for this worker's task; null when the worker has no task (asked as-is). */
  scope: QuestionCheckScope | null;
  gitConfig: WorkspaceGitConfig | null | undefined;
  /** Workspace sensitivity and the task's paths, for the hold check even when there is no scope. */
  sensitive: boolean;
  pathManifest: readonly string[] | null | undefined;
  nowMs: number;
  /** Whether a runner-reported repair task exists in this workspace. */
  repairTaskExists: (id: string) => Promise<boolean>;
  deps?: Pick<QuestionCheckDeps, 'fileRepair' | 'record'>;
}

export interface ParkDispositionResult {
  /** What to store (before sensitive-workspace redaction). */
  waitingFor: Q;
  /** Set when the question arrived tagged `hold` (lib/question-hold.ts). */
  hold: HoldResolution | null;
  /** Whether a person should be shown and notified of it now. */
  admitted: boolean;
}

function result(waitingFor: Q, hold: HoldResolution | null, nowMs: number): ParkDispositionResult {
  // A settled hold (a re-send of one already surfaced) is never re-notified.
  const admitted = hold?.held === 'settled' ? false : admitsToNeedsYou(waitingFor, nowMs);
  return { waitingFor, hold, admitted };
}

export async function disposeParkedWaitingFor(input: ParkDispositionInput): Promise<ParkDispositionResult> {
  const q = input.waitingFor;
  const nowMs = input.nowMs;

  if (q.type !== 'question') {
    return result(stamp(q, { disposition: 'ask', dispositionBy: 'permission' }), null, nowMs);
  }

  if (q.disposition === 'hold') {
    const hold = resolveHold({
      waitingFor: q,
      stored: input.stored,
      sensitive: input.sensitive,
      gitConfig: input.gitConfig,
      pathManifest: input.pathManifest ?? null,
      nowMs,
    });
    if (hold.held) return result({ ...hold.waitingFor, dispositionBy: 'gate' }, hold, nowMs);
    const rail = typeof hold.rail === 'string' && RAILS.has(hold.rail) ? (hold.rail as HardRailKind) : undefined;
    return result(stamp(hold.waitingFor, { disposition: 'ask', dispositionBy: 'gate', ...(rail ? { gateOutcome: 'hard_rail', rail } : {}) }), hold, nowMs);
  }

  if (q.disposition === 'ask') {
    return result(stamp(q, { disposition: 'ask', dispositionBy: 'gate', ...gateFields(q) }), null, nowMs);
  }

  if (q.disposition === 'recovered' && typeof q.repairTaskId === 'string') {
    const exists = await input.repairTaskExists(q.repairTaskId).catch(() => false);
    if (exists) {
      return result(stamp(q, { disposition: 'recovered', dispositionBy: 'gate', gateOutcome: 'recovered', repairTaskId: q.repairTaskId }), null, nowMs);
    }
  }

  // Untagged (or an unverifiable tag): the server re-checks. A re-send of the
  // question it already disposed keeps that disposition.
  const stored = input.stored;
  if (stored && stored.type === 'question' && stored.prompt === q.prompt && stored.dispositionBy === 'server_recheck'
    && (stored.disposition === 'ask' || stored.disposition === 'recovered')) {
    return result(stamp(q, {
      disposition: stored.disposition,
      dispositionBy: 'server_recheck',
      ...gateFields(stored),
      ...(typeof stored.repairTaskId === 'string' ? { repairTaskId: stored.repairTaskId } : {}),
    }), null, nowMs);
  }
  const d = input.scope
    ? await recheckParkedQuestion(input.scope, q as unknown as BriefedQuestion, input.deps ?? {}).catch(
      (): ParkDisposition => ({ disposition: 'ask', dispositionBy: 'server_recheck' }),
    )
    : { disposition: 'ask' as const, dispositionBy: 'server_recheck' as const };
  return result(stamp(q, d), null, nowMs);
}
