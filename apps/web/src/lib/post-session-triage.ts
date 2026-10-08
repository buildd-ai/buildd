/**
 * Post-session quality loop — Stage B triage, the server half (artifact
 * post-session-quality-loop-spec §6; pure half: @buildd/core/post-session-triage).
 *
 * For one `collected` run: evaluate the hard triggers, run the registered
 * `postSessionTriageKind` through `runBuilddDecision` (the team's decision
 * model under its inference policy; a hard trigger decides without asking one,
 * and an answer below the kind's confidence threshold falls back to skip),
 * and record the result on the run — `triaged` when the final decision is
 * `analyse`, `skipped` otherwise. Stage C picks up `triaged` runs. Every
 * decision is also a `decision_records` row, subject `post_session_run`, which
 * Stage C labels with whether its analysis found anything.
 *
 * Invariants:
 *  - **Never throws.** Every outcome is a returned status.
 *  - **Fail open.** No team, a sensitive workspace, no key, a disabled
 *    capability, a timeout or a thrown call all record `triage_unavailable`;
 *    hard triggers still apply, otherwise the run skips.
 *  - **Out of band.** The store writes only `post_session_runs`, fenced on
 *    `state = 'collected'` so two sweeps cannot both triage one run.
 */

import type { PostSessionRunState, StageAFacts } from '@buildd/core/post-session-quality';
import {
  buildTriageFeatures,
  evaluateHardTriggers,
  resolveTriageOutcome,
  triageRecordFromResponse,
  unavailableTriage,
  type HardTrigger,
  type TriageOutcome,
  type TriageRule,
} from '@buildd/core/post-session-triage';
import { POST_SESSION_RUN_SUBJECT, postSessionTriageKind } from '@buildd/core/decision-kind-post-session-triage';
import { runBuilddDecision, type BuilddDecisionDeps } from '@buildd/core/decision-policy';
import type { PostSessionTriageRecord, TriageDecision } from '@buildd/core/post-session-quality';
import type { DecisionReceipt } from '@buildd/core/decision-client';

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

export interface TriageDeps {
  store?: PostSessionTriageStore;
  /** Seams for the policy runner (access, call, ledger write). */
  decisionDeps?: BuilddDecisionDeps;
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

/**
 * Run the kind. Never throws; every failure is an unavailable record. A
 * sensitive workspace or a run with no team sends nothing out and writes no
 * ledger row, but a hard trigger still decides.
 */
async function decide(
  runId: string,
  input: PostSessionTriageInput & { facts: StageAFacts },
  hardTriggers: HardTrigger[],
  deps: TriageDeps,
  receipts: DecisionReceipt[],
): Promise<{ record: PostSessionTriageRecord; finalDecision: TriageDecision }> {
  const skipped = (reason: string) => ({
    record: unavailableTriage(reason),
    finalDecision: (hardTriggers.length > 0 ? 'analyse' : 'skip') as TriageDecision,
  });
  if (input.dataClass === 'sensitive') return skipped('sensitive');
  if (!input.teamId) return skipped('no_team');
  const teamId = input.teamId;
  let out: { record: PostSessionTriageRecord; finalDecision: TriageDecision };
  try {
    const response = await runBuilddDecision(
      postSessionTriageKind,
      {
        features: buildTriageFeatures(input.facts, hardTriggers),
        subjectRef: { type: POST_SESSION_RUN_SUBJECT, id: runId },
      },
      { teamId, workspaceId: input.workspaceId, onUsage: r => { receipts.push(r); } },
      deps.decisionDeps,
    );
    out = { record: triageRecordFromResponse(response), finalDecision: response.decision };
  } catch {
    out = skipped('transport');
  }
  if (receipts.length > 0) {
    const write = deps.recordReceipts ?? (async (r: DecisionReceipt[], s: { teamId: string; accountId: string | null }) => {
      const { insertDecisionReceipts } = await import('./memory-decisions');
      await insertDecisionReceipts(r, s);
    });
    // Bookkeeping never changes the outcome.
    await write(receipts, { teamId, accountId: null }).catch(() => {});
  }
  return out;
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
    const { record, finalDecision } = await decide(runId, { ...input, facts }, hardTriggers, deps, receipts);
    const outcome = resolveTriageOutcome(record, finalDecision, hardTriggers);
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
