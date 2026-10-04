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
  /**
   * Leaves the run collected; records why triage failed and bumps updated_at,
   * so a run that keeps failing rotates behind the others.
   */
  recordTriageFailure(runId: string, error: string, now: Date): Promise<void>;
}

/** What the decision call cost, from its usage receipts. `usd` null = no receipt priced it. */
export interface TriageCost {
  calls: number;
  usd: number | null;
  inputTokens: number;
  outputTokens: number;
}

export type TriagePostSessionResult =
  | {
    status: 'triaged';
    runId: string;
    finalDecision: TriageDecision;
    rule: TriageRule;
    triageStatus: PostSessionTriageRecord['status'];
    hardTriggered: boolean;
    cost: TriageCost;
  }
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

export function triageCost(receipts: DecisionReceipt[]): TriageCost {
  let usd: number | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const r of receipts) {
    const u = r.usage;
    if (typeof u?.costUsd === 'number') usd = (usd ?? 0) + u.costUsd;
    inputTokens += u?.inputTokens ?? 0;
    outputTokens += u?.outputTokens ?? 0;
  }
  // Float sums of sub-cent prices drift in the last digits; a readout wants the figure.
  return { calls: receipts.length, usd: usd === null ? null : Number(usd.toFixed(8)), inputTokens, outputTokens };
}

/** Ask the model. Never throws; every failure is an unavailable record. */
async function askModel(
  input: PostSessionTriageInput & { facts: StageAFacts },
  deps: TriageDeps,
  receipts: DecisionReceipt[],
): Promise<PostSessionTriageRecord> {
  if (input.dataClass === 'sensitive') return unavailableTriage('sensitive');
  if (!input.teamId) return unavailableTriage('no_team');
  const teamId = input.teamId;
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
  let store: PostSessionTriageStore | null = null;
  const now = deps.now ?? new Date();
  try {
    store = deps.store ?? await defaultStore();
    const input = await store.loadTriageInput(runId);
    if (!input) return { status: 'missing' };
    if (input.state !== 'collected' || !input.facts) return { status: 'not_ready', runId, state: input.state };

    const facts = input.facts;
    const hardTriggers = evaluateHardTriggers(facts);
    const receipts: DecisionReceipt[] = [];
    const triage = await askModel({ ...input, facts }, deps, receipts);
    const outcome = resolveTriageOutcome(triage, hardTriggers);
    const ok = await store.recordTriage(runId, outcome, now);
    if (!ok) return { status: 'fenced', runId };
    return {
      status: 'triaged',
      runId,
      finalDecision: outcome.finalDecision,
      rule: outcome.rule,
      triageStatus: outcome.triage.status,
      hardTriggered: outcome.hardTriggered,
      cost: triageCost(receipts),
    };
  } catch (err) {
    const error = errorText(err);
    // Contained and recorded: the run stays collected for the next sweep.
    await store?.recordTriageFailure(runId, error, now).catch(() => {});
    return { status: 'error', error };
  }
}
