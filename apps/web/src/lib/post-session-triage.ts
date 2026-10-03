/**
 * Post-session quality loop — Stage B triage, the server half (artifact
 * post-session-quality-loop-spec §6; pure half: @buildd/core/post-session-triage).
 *
 * For one `collected` run: evaluate the hard triggers, ask the team's decision
 * model (through `decisionCall`, so whichever model the team configured, under
 * its inference policy), resolve the final routing, and record all three on
 * the run — `triaged` when the final decision is `analyse`, `skipped`
 * otherwise. Stage C picks up `triaged` runs.
 *
 * Invariants:
 *  - **Never throws.** Every outcome is a returned status.
 *  - **Fail open.** No team, a sensitive workspace, no key, a disabled
 *    capability, a timeout, a thrown call or a malformed answer all record
 *    `triage_unavailable`; hard triggers still apply, otherwise the run skips.
 *  - **Out of band.** The store writes only `post_session_runs`, fenced on
 *    `state = 'collected'` so two sweeps cannot both triage one run.
 */

import type { PostSessionRunState, StageAFacts } from '@buildd/core/post-session-quality';
import {
  POST_SESSION_TRIAGE_CAPABILITY,
  POST_SESSION_TRIAGE_QUESTIONS,
  POST_SESSION_TRIAGE_TIMEOUT_MS,
  buildTriageState,
  evaluateHardTriggers,
  readTriageAnswers,
  resolveTriageOutcome,
  unavailableTriage,
  type PostSessionTriageQuestions,
  type TriageOutcome,
  type TriageRule,
} from '@buildd/core/post-session-triage';
import type { PostSessionTriageRecord, TriageDecision } from '@buildd/core/post-session-quality';
import type { DecisionReceipt, decisionCall } from '@buildd/core/decision-client';

export interface PostSessionTriageInput {
  runId: string;
  state: PostSessionRunState;
  facts: StageAFacts | null;
  teamId: string | null;
  workspaceId: string;
  /** `workspaces.dataClass`. Sensitive workspaces send nothing out. */
  dataClass: string | null;
}

export interface PostSessionTriageStore {
  loadTriageInput(runId: string): Promise<PostSessionTriageInput | null>;
  /** Fenced on state='collected'. false = another sweep got there first. */
  recordTriage(runId: string, outcome: TriageOutcome, now: Date): Promise<boolean>;
  /** Collected runs for this policy version that have not been triaged yet, oldest first. */
  listUntriaged(input: { policyVersion: string; limit: number }): Promise<string[]>;
}

export type TriagePostSessionResult =
  | { status: 'triaged'; runId: string; finalDecision: TriageDecision; rule: TriageRule; triageStatus: PostSessionTriageRecord['status'] }
  | { status: 'not_ready'; runId: string; state: PostSessionRunState | null }
  | { status: 'fenced'; runId: string }
  | { status: 'missing' }
  | { status: 'error'; error: string };

type DecideFn = typeof decisionCall<PostSessionTriageQuestions>;

export interface TriageDeps {
  store?: PostSessionTriageStore;
  decide?: DecideFn;
  recordReceipts?: (receipts: DecisionReceipt[], scope: { teamId: string; accountId: string | null }) => Promise<void>;
  now?: Date;
}

const MAX_ERROR_CHARS = 500;

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > MAX_ERROR_CHARS ? msg.slice(0, MAX_ERROR_CHARS) : msg;
}

async function defaultStore(): Promise<PostSessionTriageStore> {
  const mod = await import('./post-session-store');
  return mod.postSessionRunStore;
}

/** Ask the model. Never throws; every failure is an unavailable record. */
async function askModel(input: PostSessionTriageInput & { facts: StageAFacts }, deps: TriageDeps): Promise<PostSessionTriageRecord> {
  if (input.dataClass === 'sensitive') return unavailableTriage('sensitive');
  if (!input.teamId) return unavailableTriage('no_team');
  const teamId = input.teamId;
  const receipts: DecisionReceipt[] = [];
  let record: PostSessionTriageRecord;
  try {
    const decide = deps.decide ?? (await import('@buildd/core/decision-client')).decisionCall;
    const result = await decide({
      capability: POST_SESSION_TRIAGE_CAPABILITY,
      teamId,
      workspaceId: input.workspaceId,
      state: buildTriageState(input.facts),
      questions: POST_SESSION_TRIAGE_QUESTIONS,
      timeoutMs: POST_SESSION_TRIAGE_TIMEOUT_MS,
      decisionId: POST_SESSION_TRIAGE_CAPABILITY,
      onUsage: r => { receipts.push(r); },
    });
    record = result.ok
      ? readTriageAnswers(result.answers, { model: result.model, latencyMs: result.latencyMs, attempts: result.attempts })
      : unavailableTriage(result.error.kind, { latencyMs: result.latencyMs, attempts: result.attempts });
  } catch {
    record = unavailableTriage('transport');
  }
  if (receipts.length > 0) {
    const write = deps.recordReceipts ?? (async (r: DecisionReceipt[], s: { teamId: string; accountId: string | null }) => {
      const { insertDecisionReceipts } = await import('./memory-decisions');
      await insertDecisionReceipts(r, s);
    });
    // Bookkeeping never changes the outcome.
    await write(receipts, { teamId, accountId: null }).catch(() => {});
  }
  return record;
}

export async function triagePostSessionRun(runId: string, deps: TriageDeps = {}): Promise<TriagePostSessionResult> {
  try {
    const store = deps.store ?? await defaultStore();
    const now = deps.now ?? new Date();
    const input = await store.loadTriageInput(runId);
    if (!input) return { status: 'missing' };
    if (input.state !== 'collected' || !input.facts) return { status: 'not_ready', runId, state: input.state };

    const facts = input.facts;
    const hardTriggers = evaluateHardTriggers(facts);
    const triage = await askModel({ ...input, facts }, deps);
    const outcome = resolveTriageOutcome(triage, hardTriggers);
    const ok = await store.recordTriage(runId, outcome, now);
    if (!ok) return { status: 'fenced', runId };
    return {
      status: 'triaged',
      runId,
      finalDecision: outcome.finalDecision,
      rule: outcome.rule,
      triageStatus: outcome.triage.status,
    };
  } catch (err) {
    return { status: 'error', error: errorText(err) };
  }
}
