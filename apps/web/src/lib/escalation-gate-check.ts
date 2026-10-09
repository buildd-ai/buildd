/**
 * Escalation gate, server half (pure half: @buildd/core/escalation-gate).
 *
 * `gateEscalations` decides, for every PR about to reach a person (the PR
 * inbox behind Home, the nav badge and list_prs, and every escalation push),
 * who owns its next move. Rules first; Jev decides what no rule covers; Buildd
 * takes the action Jev names; only a person-owned verdict reaches the owner.
 *
 * Two modes. A page load, the badge and list_prs read (`decide` unset): one
 * indexed ledger query, the rules, no model call and no write; a state with
 * no stored verdict is queued (`enqueue`) for a look after the response. The
 * look itself (`decide: true`) runs there and on an escalation push: it files
 * the rule's row or asks Jev, and takes the action Jev names.
 *
 * One look per state. The verdict for a PR is filed in the decision ledger
 * (capability `escalation_gate`, subject `pr`/<key>, fingerprint = the state
 * it was made on), and a read of the same state reuses it: a page refresh
 * never calls the model again and never writes a second row. A new push, CI
 * change or new reason is a new fingerprint, so a new look.
 *
 * Never silences. A failed or unsure model call asks the person. A
 * Buildd-owned state that has not changed for `ESCALATION_STUCK_MS` is the
 * person's again, with that said, so a rule that names a step nothing takes
 * cannot hide a PR forever. Never throws: a gate failure asks.
 *
 * Core: the model call, the ledger write and the action filer are slots
 * (`EscalationGateDeps`), filled by lib/escalation-decision.ts. A caller with
 * no slots filled still gets every rule, and the person for the rest.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { decisionRecords } from '@buildd/core/db/schema';
import {
  ESCALATION_GATE_CAPABILITY,
  ESCALATION_GATE_DECISION_TIMEOUT_MS,
  ESCALATION_GATE_MIN_CONFIDENCE,
  ESCALATION_GATE_PROMPT_VERSION,
  buildEscalationGateState,
  escalationFingerprint,
  escalationRule,
  readEscalationGateRun,
  resolveEscalationAnswer,
  verdictAt,
  verdictCode,
  verdictFromCode,
  type EscalationSubject,
  type EscalationVerdict,
  type JevAction,
} from '@buildd/core/escalation-gate';
import type * as EscalationDecision from '@buildd/core/escalation-gate-decision';
import type { DecisionAccess, DecisionReceipt } from '@buildd/core/decision-client';
import type { DecisionLedgerInput } from '@buildd/core/decision-ledger';
import type { FileRepairInput } from './question-gate-check';

/** A Buildd-owned state that has not changed for this long is the person's again. */
export const ESCALATION_STUCK_MS = 6 * 60 * 60_000;
/**
 * Shorter for a policy merge: the rule says it should land, and until the
 * kernel lands it by policy (task a90fc99b) nothing else will, so the person
 * gets it back sooner.
 */
export const POLICY_MERGE_STUCK_MS = 2 * 60 * 60_000;
/** Model calls one gate pass may make; the rest ask this time and get their look on the next read. */
export const ESCALATION_MAX_MODEL_CALLS = 6;
export const ESCALATION_SUBJECT_TYPE = 'pr';

export interface GatedSubject extends EscalationSubject {
  teamId: string;
  accountId?: string | null;
  /** `workspaces.dataClass === 'sensitive'`: no text leaves, so no model call. */
  sensitive?: boolean;
}

export interface StoredVerdict {
  fingerprint: string;
  appliedAnswer: string | null;
  createdAt: Date;
}

export interface EscalationGateDeps {
  /**
   * true: file rule rows and ask Jev (a background look, an escalation push).
   * Unset or false: read only. A request path never waits on the model.
   */
  decide?: boolean;
  /** Read mode: the subjects with no stored verdict for their state, for a background look. Never throws into the read. */
  enqueue?: (subjects: GatedSubject[]) => void;
  /** subjectKey → its newest ledger row, for one team. */
  loadStored?: (teamId: string, keys: string[]) => Promise<Map<string, StoredVerdict>>;
  resolveAccess?: (scope: { teamId: string; workspaceId: string; accountId: string | null }) => Promise<DecisionAccess>;
  run?: typeof EscalationDecision.ESCALATION_GATE_DECISION.run;
  record?: (input: DecisionLedgerInput) => Promise<string | null | void>;
  recordReceipts?: (receipts: DecisionReceipt[], scope: { teamId: string; accountId: string | null }) => Promise<void>;
  /**
   * Take the machine action a Jev `act` verdict named (`escalationActionFiler`
   * over the question gate's filer). Every surface passes the same deps, so
   * whichever makes the look first also takes the action: the verdict is
   * stored once and later reads only reuse it.
   */
  act?: (subject: GatedSubject, action: JevAction) => Promise<void>;
  now?: () => number;
  maxModelCalls?: number;
}

/** The stored-verdict read's WHERE: this team's escalation looks at these PRs. Exported so a test can render it. */
export function storedVerdictWhere(teamId: string, keys: string[]) {
  return and(
    eq(decisionRecords.teamId, teamId),
    eq(decisionRecords.capability, ESCALATION_GATE_CAPABILITY),
    eq(decisionRecords.subjectType, ESCALATION_SUBJECT_TYPE),
    inArray(decisionRecords.subjectId, keys),
  );
}

async function defaultLoadStored(teamId: string, keys: string[]): Promise<Map<string, StoredVerdict>> {
  const out = new Map<string, StoredVerdict>();
  if (keys.length === 0) return out;
  try {
    const rows = await db
      .select({
        subjectId: decisionRecords.subjectId,
        fingerprint: decisionRecords.fingerprint,
        appliedAnswer: decisionRecords.appliedAnswer,
        createdAt: decisionRecords.createdAt,
      })
      .from(decisionRecords)
      .where(storedVerdictWhere(teamId, keys))
      .orderBy(desc(decisionRecords.createdAt))
      .limit(keys.length * 4);
    for (const r of rows) {
      if (r.subjectId && !out.has(r.subjectId)) {
        out.set(r.subjectId, { fingerprint: r.fingerprint, appliedAnswer: r.appliedAnswer, createdAt: r.createdAt });
      }
    }
  } catch (err) {
    console.warn('[escalation-gate] stored verdict read failed (non-fatal):', (err as Error)?.message ?? err);
  }
  return out;
}

const stuck = (since: Date, nowMs: number): EscalationVerdict => ({
  owner: 'person', by: 'rule',
  reason: `Buildd has been on it for ${Math.round((nowMs - since.getTime()) / 3_600_000)}h with nothing changing, so it is yours now.`,
});

/** A stored verdict for the same state, as of now (expired hold, stuck ceiling). */
function reuse(stored: StoredVerdict, nowMs: number): EscalationVerdict | null {
  const v = verdictFromCode(stored.appliedAnswer);
  if (!v) return null;
  const ceiling = v.owner === 'buildd' && v.action === 'policy_merge' ? POLICY_MERGE_STUCK_MS : ESCALATION_STUCK_MS;
  if (v.owner === 'buildd' && v.action !== 'hold' && nowMs - stored.createdAt.getTime() >= ceiling) {
    return stuck(stored.createdAt, nowMs);
  }
  return verdictAt(v, nowMs);
}

/** A gateway-routed decision model cannot answer a decision pinned to Jev. */
function unsupportedModel(access: DecisionAccess & { ok: true }): boolean {
  return !!access.endpoint && access.endpoint.kind !== 'systemone';
}

async function askJev(
  s: GatedSubject,
  deps: Pick<EscalationGateDeps, 'resolveAccess' | 'recordReceipts' | 'run'>,
  started: number,
  now: () => number,
): Promise<{ verdict: EscalationVerdict; jev: { label: string; confidence: number } | null; error?: string }> {
  const fallback = (error: string) => ({
    verdict: { owner: 'person' as const, by: 'fallback' as const, reason: 'Jev couldn\'t be asked, so it comes to you.' },
    jev: null,
    error,
  });
  if (s.sensitive) return fallback('sensitive');
  if (!deps.resolveAccess || !deps.run) return fallback('no_decision_model');
  const receipts: DecisionReceipt[] = [];
  try {
    const access = await deps.resolveAccess({ teamId: s.teamId, workspaceId: s.workspaceId, accountId: s.accountId ?? null });
    if (!access.ok) return fallback(access.error.kind);
    if (unsupportedModel(access)) return fallback('unsupported_decision_model');
    const remaining = ESCALATION_GATE_DECISION_TIMEOUT_MS - (now() - started);
    if (remaining <= 100) return fallback('timeout');
    const result = await deps.run({
      apiKey: access.apiKey,
      state: buildEscalationGateState(s),
      timeoutMs: remaining,
      headers: { 'http-referer': 'https://buildd.dev', 'x-title': 'buildd' },
      onUsage: r => { receipts.push(r); },
    });
    const read = readEscalationGateRun(result);
    if ('error' in read) return fallback(read.error);
    return {
      verdict: resolveEscalationAnswer(read, ESCALATION_GATE_MIN_CONFIDENCE, now()),
      jev: { label: read.action ? `${read.disposition}:${read.action}` : read.disposition, confidence: read.dispositionConfidence },
    };
  } catch {
    return fallback('transport');
  } finally {
    if (receipts.length && deps.recordReceipts) await deps.recordReceipts(receipts, { teamId: s.teamId, accountId: s.accountId ?? null }).catch(() => {});
  }
}

/**
 * subjectKey → verdict for every subject. Subjects of several teams may be
 * mixed; each team's stored verdicts are read once.
 */
export async function gateEscalations(subjects: GatedSubject[], deps: EscalationGateDeps = {}): Promise<Map<string, EscalationVerdict>> {
  const out = new Map<string, EscalationVerdict>();
  if (subjects.length === 0) return out;
  const now = deps.now ?? (() => Date.now());
  const loadStored = deps.loadStored ?? defaultLoadStored;
  const record = deps.record ?? (async () => {});
  const jevDeps = { resolveAccess: deps.resolveAccess, recordReceipts: deps.recordReceipts, run: deps.run };
  let budget = deps.maxModelCalls ?? ESCALATION_MAX_MODEL_CALLS;
  const decide = deps.decide === true;
  const queued: GatedSubject[] = [];

  const byTeam = new Map<string, GatedSubject[]>();
  for (const s of subjects) byTeam.set(s.teamId, [...(byTeam.get(s.teamId) ?? []), s]);

  for (const [teamId, list] of byTeam) {
    let stored: Map<string, StoredVerdict>;
    try {
      stored = await loadStored(teamId, [...new Set(list.map(s => s.key))]);
    } catch {
      stored = new Map();
    }
    // Rules and stored verdicts first (no model call), then Jev for the rest
    // in parallel, so a pass costs at most one model timeout, not one per PR.
    const forJev: Array<{ s: GatedSubject; started: number; ledgerBase: Omit<DecisionLedgerInput, 'applied' | 'status'> }> = [];
    for (const s of list) {
      const started = now();
      try {
        const fingerprint = escalationFingerprint(s);
        const prior = stored.get(s.key);
        const reused = prior && prior.fingerprint === fingerprint ? reuse(prior, started) : null;
        if (reused) {
          out.set(s.key, reused);
          continue;
        }

        const rule = escalationRule(s);
        if (!decide) {
          out.set(s.key, rule ?? { owner: 'person', by: 'fallback', reason: 'Not looked at yet, so it comes to you for now.' });
          queued.push(s);
          continue;
        }
        const ledgerBase = {
          teamId, workspaceId: s.workspaceId, missionId: s.missionId, taskId: s.taskId,
          capability: ESCALATION_GATE_CAPABILITY, fingerprint, promptVersion: ESCALATION_GATE_PROMPT_VERSION,
          minConfidence: ESCALATION_GATE_MIN_CONFIDENCE,
          subjectType: ESCALATION_SUBJECT_TYPE, subjectId: s.key,
        };
        if (rule) {
          out.set(s.key, rule);
          await record({
            ...ledgerBase, ruleAnswer: verdictCode(rule), appliedAnswer: verdictCode(rule), applied: true, status: 'applied',
            reason: rule.owner === 'person' ? `rule:${rule.rail ?? 'person'}` : `rule:${rule.action}`, latencyMs: now() - started,
          }).catch(() => {});
          continue;
        }

        if (budget <= 0) {
          // Not filed: the next read gives it its look.
          out.set(s.key, { owner: 'person', by: 'fallback', reason: 'Not looked at yet, so it comes to you for now.' });
          continue;
        }
        budget -= 1;
        forJev.push({ s, started, ledgerBase });
      } catch {
        out.set(s.key, { owner: 'person', by: 'fallback', reason: 'The check failed, so it comes to you.' });
      }
    }

    await Promise.all(forJev.map(async ({ s, started, ledgerBase }) => {
      try {
        const answer = await askJev(s, jevDeps, started, now);
        out.set(s.key, answer.verdict);
        await record({
          ...ledgerBase,
          verdict: answer.jev?.label ?? null, confidence: answer.jev?.confidence ?? null,
          appliedAnswer: verdictCode(answer.verdict),
          applied: answer.verdict.by === 'jev', status: answer.error ? 'fallback' : answer.verdict.by === 'jev' ? 'applied' : 'suggested',
          reason: answer.error ?? null, latencyMs: now() - started,
        }).catch(() => {});
        if (answer.verdict.owner === 'buildd' && answer.verdict.by === 'jev' && answer.verdict.action !== 'hold' && deps.act) {
          await deps.act(s, answer.verdict.action as JevAction).catch(() => {});
        }
      } catch {
        out.set(s.key, { owner: 'person', by: 'fallback', reason: 'The check failed, so it comes to you.' });
      }
    }));
  }
  if (queued.length > 0 && deps.enqueue) {
    try { deps.enqueue(queued); } catch { /* the read stands */ }
  }
  return out;
}

/**
 * The filer behind a Jev `act` verdict: one repair task per (PR, action), the
 * same filer and dedupe the question gate's recover stage uses. The kernel's
 * own next steps (CI fix, renumber, landing retry) are rule verdicts and are
 * left to the kernel; this only runs for what Jev chose.
 */
export function escalationActionFiler(fileRepair: (input: FileRepairInput) => Promise<{ id: string; reused: boolean } | null>) {
  return async (s: GatedSubject, action: JevAction): Promise<void> => {
    if (s.prNumber == null || !s.taskId) return;
    const what: Record<JevAction, string> = {
      re_review: `Re-run the reviewer on PR #${s.prNumber} at its current head (request_pr_review with force: true), then let the merge policy take it from there.`,
      address_review: `Make the changes the reviewer asked for on PR #${s.prNumber}, push them to that PR's own branch, and request a fresh review.`,
      ci_fix: `Fix the failing checks on PR #${s.prNumber} and push to that PR's own branch.`,
      conflict_fix: `Resolve PR #${s.prNumber}'s conflict with its base branch on that PR's own branch.`,
    };
    await fileRepair({
      workspaceId: s.workspaceId,
      missionId: s.missionId,
      blockedTaskId: s.taskId,
      spec: {
        title: `fix: move PR #${s.prNumber} on without paging the owner`,
        description: [
          `PR #${s.prNumber} ("${s.title}") stopped moving. Jev decided Buildd can take the next step itself instead of asking the owner.`,
          '',
          what[action],
          s.detail ? `\nWhat stopped it: ${s.detail.replace(/\s+/g, ' ').slice(0, 600)}` : '',
          '',
          'Work on the PR\'s own branch; do not open a new PR. If the step turns out to need a person\'s decision, say so with post_note type=question.',
        ].join('\n'),
        signature: `escalation-gate:${action}:${s.workspaceId}:${s.prNumber}`,
      },
    });
  };
}
