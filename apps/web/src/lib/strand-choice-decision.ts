/**
 * A typed Choice for a stranded local mission (lib/local-strand.ts): continue
 * on a runner, wait for the local session, or nothing to do until its
 * dependencies land. A decision model (Jev) picks one from STRUCTURED facts
 * only — quiet time, claimable work and its roles, dependency state, PR
 * states. Never a title, a description, a note or a diff.
 *
 * Gated advice can only order the two buttons; a person always taps and the
 * executor never changes here. Rollback: set STRAND_CHOICE_MODE to 'shadow'.
 * Every attempt is recorded in the ledger; human taps are observational
 * labels because button order can bias the choice.
 *
 * Fails open by construction: disabled, no key, a sensitive workspace, a
 * timeout, an error or a throw all return null, which is today's order.
 */
import { promptedQuestions } from '@buildd/core/prompted-decision';
import { createHash } from 'node:crypto';
import { OPEN_TASK_STATUSES, VISUAL_AUDITOR_ROLE_SLUG } from '@buildd/shared';
import type {
  ChoiceQuestion,
  DecisionAccess,
  DecisionReceipt,
  DecisionResult,
  decisionCall,
} from '@buildd/core/decision-client';
import { deriveFeedPrState } from './mission-pulse';
import { unmetDependencyIds, type DependencyRow } from './mission-helpers';
import type { LocalStrand } from './local-strand';
import { registerPromptedQuestions } from '@buildd/core/prompted-decision';
import { isJevModel } from '@buildd/core/decision-model';
import { recordDecision, type DecisionLedgerInput } from '@buildd/core/decision-ledger';

export const STRAND_CHOICE_CAPABILITY = 'mission_strand_choice' as const;
export const STRAND_CHOICE_DECISION_ID = 'mission_strand_choice';
export const DECISION_SHADOW_LOG_PREFIX = '[decision-shadow]';
export const DECISION_LABEL_LOG_PREFIX = '[decision-label]';
export const STRAND_CHOICE_TIMEOUT_MS = 3_000;
/** Starting threshold for reversible button ordering. */
export const STRAND_CHOICE_MIN_CONFIDENCE = 0.85;
/** Bump when the question, a definition or the state shape changes. */
export const STRAND_CHOICE_PROMPT_VERSION = 'ms1';

/** Rollback requires only changing this constant to 'shadow'. */
export const STRAND_CHOICE_MODE: 'shadow' | 'gated' = 'gated';

export const STRAND_CHOICE_LABELS = ['continue-on-runner', 'wait-for-local', 'blocked-on-deps'] as const;
export type StrandChoiceLabel = typeof STRAND_CHOICE_LABELS[number];

export const STRAND_CHOICE_QUESTION = {
  type: 'choice',
  instructions: {
    question: 'The tasks of `mission` are run from a person’s local session, and no session has touched it for a while. What should happen next?',
    rule: 'Judge from the facts only. Nothing claims these tasks unless a local session does, or the mission is switched to background runners.',
  },
  criteria: {
    'continue-on-runner': {
      what: 'There is claimable work, the local session has been gone for a long time, and nothing about the work needs that person’s machine: a background runner can do it now.',
      not_for: 'Work that needs a browser or tool only the local session has, a session that was active recently, or work that cannot start because its dependencies are still open.',
    },
    'wait-for-local': {
      what: 'The local session is likely to come back soon, or the claimable work needs what only that session has (a browser, a local tool), so switching to runners would not help.',
      not_for: 'A session gone for hours with plain build or docs work waiting, or work that cannot start yet whoever runs it.',
    },
    'blocked-on-deps': {
      what: 'Most open work is waiting on dependencies or on PRs still in review or CI, so whoever runs it there is little to do until those land.',
      not_for: 'Claimable work that is simply waiting for someone to pick it up.',
    },
  },
} satisfies ChoiceQuestion<StrandChoiceLabel>;

type Questions = { pick: typeof STRAND_CHOICE_QUESTION };

/** The prompts-table id whose active row may replace the question (`@buildd/core/prompted-decision`). */
export const STRAND_CHOICE_PROMPT_ID = 'buildd.mission_strand_choice';

/** The question and prompt version in effect: an active prompts row, else the public ones. */
function currentPrompt() {
  return promptedQuestions(STRAND_CHOICE_PROMPT_ID, { pick: STRAND_CHOICE_QUESTION }, STRAND_CHOICE_PROMPT_VERSION);
}

export interface StrandChoiceFacts {
  missionId: string;
  teamId: string;
  workspaceId: string | null;
  accountId?: string | null;
  userId?: string | null;
  /** `workspaces.gitConfig.dataClass`. A sensitive workspace never sends anything out. */
  dataClass?: string | null;
  executor: string;
  quietMinutes: number;
  lastSessionMinutesAgo: number | null;
  claimableTasks: number;
  /** Role slugs of the claimable tasks, sorted, deduped. */
  claimableRoles: string[];
  /** A claimable task needs a real browser (the visual auditor). */
  needsBrowser: boolean;
  /** Pending tasks waiting on unmet dependencies. */
  depBlockedTasks: number;
  openPrs: { checksRunning: number; green: number; red: number; conflict: number; underReview: number };
  /** "Continue on a runner" would be refused (`continueOnRunnerBlockedReason`). */
  flipRefused: boolean;
}

interface FactRow {
  id: string;
  status: string;
  roleSlug?: string | null;
  taskClass?: string | null;
  parentTaskId?: string | null;
  dependsOn?: string[] | null;
  workers?: Array<{ status: string; prNumber?: number | null; prUrl?: string | null; mergedAt?: Date | string | null; prLifecycleStatus?: string | null }> | null;
}

/** The facts, from the rows a card or `explain` already loaded. Pure. */
export function strandChoiceFacts(input: {
  missionId: string;
  teamId: string;
  workspaceId: string | null;
  executor: string;
  strand: LocalStrand & { flipBlockedReason: string | null };
  tasks: readonly FactRow[];
  now: number;
  dataClass?: string | null;
}): StrandChoiceFacts {
  const byId = new Map<string, DependencyRow>(input.tasks.map(t => [t.id, t as DependencyRow]));
  const claimable = new Set(input.strand.claimableTaskIds);
  const claimableRows = input.tasks.filter(t => claimable.has(t.id));
  const openPrs = { checksRunning: 0, green: 0, red: 0, conflict: 0, underReview: 0 };
  const reviewing = new Set(input.tasks
    .filter(t => t.taskClass === 'attempt' && (OPEN_TASK_STATUSES as readonly string[]).includes(t.status) && t.parentTaskId)
    .map(t => t.parentTaskId!));
  for (const t of input.tasks) {
    if (t.status !== 'completed') continue;
    const w = (t.workers ?? []).find(x => x.prNumber);
    const pr = deriveFeedPrState(w ? {
      status: w.status, startedAt: null, updatedAt: null, prNumber: w.prNumber ?? null, prUrl: w.prUrl ?? null,
      prLifecycleStatus: w.prLifecycleStatus ?? null, mergedAt: w.mergedAt ?? null,
    } : null);
    if (!pr || pr.state === 'merged' || pr.state === 'closed' || pr.state === 'unresolvable') continue;
    if (pr.state === 'checks_running') openPrs.checksRunning++;
    else if (pr.state === 'ci_failed') openPrs.red++;
    else if (pr.state === 'conflict') openPrs.conflict++;
    else openPrs.green++;
    if (reviewing.has(t.id)) openPrs.underReview++;
  }
  const lastSession = input.strand.lastSessionAt ? Date.parse(input.strand.lastSessionAt) : NaN;
  return {
    missionId: input.missionId,
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    dataClass: input.dataClass ?? null,
    executor: input.executor,
    quietMinutes: Math.round(input.strand.quietMs / 60_000),
    lastSessionMinutesAgo: Number.isFinite(lastSession) ? Math.round((input.now - lastSession) / 60_000) : null,
    claimableTasks: claimableRows.length,
    claimableRoles: [...new Set(claimableRows.map(t => t.roleSlug).filter((s): s is string => !!s))].sort(),
    needsBrowser: claimableRows.some(t => t.roleSlug === VISUAL_AUDITOR_ROLE_SLUG),
    depBlockedTasks: input.tasks.filter(t => t.status === 'pending' && unmetDependencyIds(t, byId).length > 0).length,
    openPrs,
    flipRefused: input.strand.flipBlockedReason !== null,
  };
}

/** What the call may see. Numbers, slugs and flags; no ids, no text. */
export function buildStrandChoiceState(f: StrandChoiceFacts) {
  return {
    mission: {
      executor: f.executor,
      sessionQuietMinutes: f.quietMinutes,
      lastSessionMinutesAgo: f.lastSessionMinutesAgo,
      claimableTasks: f.claimableTasks,
      claimableRoles: f.claimableRoles,
      needsBrowser: f.needsBrowser,
      depBlockedTasks: f.depBlockedTasks,
      openPrs: f.openPrs,
      flipRefused: f.flipRefused,
    },
  };
}

/** Quiet time is bucketed by the hour, so a card re-rendering every minute does not spend again. */
export function strandChoiceCacheKey(f: StrandChoiceFacts): string {
  const state = buildStrandChoiceState({ ...f, quietMinutes: Math.floor(f.quietMinutes / 60), lastSessionMinutesAgo: null });
  const digest = createHash('sha256').update(JSON.stringify(state)).digest('hex').slice(0, 16);
  return `${f.missionId}:${currentPrompt().promptVersion}:${digest}`;
}

export interface StrandChoice {
  pick: StrandChoiceLabel;
  confidence: number;
}

type DecideFn = typeof decisionCall<Questions>;
type ResolveAccess = (opts: {
  capability: typeof STRAND_CHOICE_CAPABILITY;
  teamId: string;
  workspaceId: string | null;
  accountId: string | null;
  userId: string | null;
}) => Promise<DecisionAccess>;

export interface StrandChoiceDeps {
  decide?: DecideFn;
  recordDecision?: (input: DecisionLedgerInput) => Promise<string | null>;
  resolveAccess?: ResolveAccess;
  recordReceipt?: (receipt: DecisionReceipt, scope: { teamId: string; accountId: string | null }) => Promise<void>;
  cache?: Map<string, StrandChoice>;
  log?: (line: string) => void;
}

const MAX_CACHE_ENTRIES = 200;
const sharedCache = new Map<string, StrandChoice>();

/**
 * Ask, log, return the pick. Never throws; null means "no pick", which is
 * today's order. Spends only on a cache miss.
 */
export async function adviseStrandChoice(facts: StrandChoiceFacts, deps: StrandChoiceDeps = {}): Promise<StrandChoice | null> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const cache = deps.cache ?? sharedCache;
  const record = deps.recordDecision ?? recordDecision;
  const fallback = async (reason: string, latencyMs?: number) => {
    await record({
      teamId: facts.teamId, workspaceId: facts.workspaceId, missionId: facts.missionId,
      capability: STRAND_CHOICE_CAPABILITY, fingerprint: strandChoiceCacheKey(facts),
      promptVersion: currentPrompt().promptVersion, minConfidence: STRAND_CHOICE_MIN_CONFIDENCE,
      confidence: null, verdict: null, ruleAnswer: 'runner-first', appliedAnswer: 'runner-first',
      applied: false, status: 'fallback', reason, latencyMs,
    });
    return null;
  };
  try {
    if (facts.dataClass === 'sensitive') return await fallback('sensitive');
    const key = strandChoiceCacheKey(facts);
    const hit = cache.get(key);
    if (hit) return hit;

    const client = deps.decide && deps.resolveAccess ? null : await import('@buildd/core/decision-client');
    const resolveAccess = deps.resolveAccess ?? (client!.resolveDecisionAccess as ResolveAccess);
    const access = await resolveAccess({
      capability: STRAND_CHOICE_CAPABILITY,
      teamId: facts.teamId,
      workspaceId: facts.workspaceId,
      accountId: facts.accountId ?? null,
      userId: facts.userId ?? null,
    });
    if (!access.ok) return await fallback(access.error.kind);

    const scope = { teamId: facts.teamId, accountId: facts.accountId ?? null };
    const recordReceipt = deps.recordReceipt ?? (async (receipt, s) => {
      const { insertDecisionReceipts } = await import('./memory-decisions');
      await insertDecisionReceipts([receipt], s);
    });
    const receipts: Promise<void>[] = [];
    const decide = deps.decide ?? (client!.decisionCall as DecideFn);
    const res: DecisionResult<Questions> = await decide({
      capability: STRAND_CHOICE_CAPABILITY,
      teamId: facts.teamId,
      workspaceId: facts.workspaceId,
      accountId: facts.accountId ?? null,
      userId: facts.userId ?? null,
      state: buildStrandChoiceState(facts),
      questions: currentPrompt().questions,
      timeoutMs: STRAND_CHOICE_TIMEOUT_MS,
      decisionId: STRAND_CHOICE_DECISION_ID,
      access,
      onUsage: receipt => { receipts.push(recordReceipt(receipt, scope).catch(() => {})); },
    });
    await Promise.all(receipts);

    const mission = facts.missionId.slice(0, 8);
    if (!res.ok) {
      log(`${DECISION_SHADOW_LOG_PREFIX} ${JSON.stringify({ site: 'mission_strand', mission, error: res.error.kind, latencyMs: res.latencyMs })}`);
      return await fallback(res.error.kind, res.latencyMs);
    }
    const { choice, confidence } = res.answers.pick;
    // Ids, labels and numbers only.
    log(`${DECISION_SHADOW_LOG_PREFIX} ${JSON.stringify({
      site: 'mission_strand',
      v: `${currentPrompt().promptVersion}|${res.model}`,
      mission,
      pick: choice,
      confidence,
      mode: STRAND_CHOICE_MODE,
      quietMinutes: facts.quietMinutes,
      latencyMs: res.latencyMs,
      inputTokens: res.usage?.inputTokens ?? null,
      costUsd: res.usage?.costUsd ?? null,
    })}`);
    if (!(STRAND_CHOICE_LABELS as readonly string[]).includes(choice)) return await fallback('invalid_choice');
    if (!isJevModel(res.model)) return await fallback('non_jev');

    const isConfidentWaitForLocal = choice === 'wait-for-local' && confidence >= STRAND_CHOICE_MIN_CONFIDENCE;
    const applied = STRAND_CHOICE_MODE === 'gated' && isConfidentWaitForLocal;
    const appliedAnswer = applied ? choice : 'runner-first';
    const status = applied ? 'applied' : 'suggested';

    // Record the decision to the ledger
    await record({
      teamId: facts.teamId,
      workspaceId: facts.workspaceId,
      missionId: facts.missionId,
      capability: STRAND_CHOICE_CAPABILITY,
      fingerprint: key,
      promptVersion: currentPrompt().promptVersion,
      model: res.model,
      minConfidence: STRAND_CHOICE_MIN_CONFIDENCE,
      confidence,
      verdict: choice,
      ruleAnswer: 'runner-first',
      appliedAnswer,
      applied,
      status,
      reason: isConfidentWaitForLocal ? undefined : 'below_threshold',
      latencyMs: res.latencyMs,
      inputTokens: res.usage?.inputTokens ?? null,
      costUsd: res.usage?.costUsd ?? null,
    });

    const out: StrandChoice = { pick: choice as StrandChoiceLabel, confidence };
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, out);
    return out;
  } catch (err) {
    console.error(`${DECISION_SHADOW_LOG_PREFIX} mission_strand failed (non-fatal, card unchanged):`, err);
    return await fallback('exception');
  }
}

/** Peek at the cache without awaiting or making calls. Returns cached pick if present, null if miss. */
export function peekStrandChoiceCache(facts: StrandChoiceFacts, cache?: Map<string, StrandChoice>): StrandChoice | null {
  const key = strandChoiceCacheKey(facts);
  const c = cache ?? sharedCache;
  return c.get(key) ?? null;
}

export type StrandButtonOrder = 'runner-first' | 'local-first';

/**
 * Which button leads. Today's order is "Continue on a runner" first; only a
 * gated, confident `wait-for-local` puts "Keep local" first. Nothing else the
 * model says changes the card, and nothing it says ever flips the executor.
 */
export function strandButtonOrder(choice: StrandChoice | null, mode: 'shadow' | 'gated' = STRAND_CHOICE_MODE): StrandButtonOrder {
  if (mode !== 'gated' || !choice) return 'runner-first';
  return choice.pick === 'wait-for-local' && choice.confidence >= STRAND_CHOICE_MIN_CONFIDENCE ? 'local-first' : 'runner-first';
}

/** The owner's tap, as a content-free label line (the label route logs it). */
export function strandLabelLine(input: {
  missionId: string;
  label: 'continue-on-runner' | 'wait-for-local';
  order: StrandButtonOrder;
  quietMs: number;
}): string {
  return `${DECISION_LABEL_LOG_PREFIX} ${JSON.stringify({
    site: 'mission_strand',
    mission: input.missionId.slice(0, 8),
    label: input.label,
    order: input.order,
    quietMinutes: Math.round(input.quietMs / 60_000),
  })}`;
}

/** Where a label line goes: the server log, next to the shadow lines it joins. */
export function emitDecisionLabel(line: string): void {
  console.log(line);
}

// Registered for the deploy seed and the fallback alert (`@buildd/core/prompts`).
registerPromptedQuestions(STRAND_CHOICE_PROMPT_ID, { pick: STRAND_CHOICE_QUESTION });
