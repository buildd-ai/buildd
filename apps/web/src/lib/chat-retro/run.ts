/**
 * The daily chat retro pass: retros for opted-in teams, then the proposal
 * pass for teams that also turned proposals on. Called by
 * /api/cron/chat-retro. Deps are injectable so the whole pass runs in tests
 * with no DB and no model.
 */
import type { DecisionReceipt, DecisionResult } from '@buildd/core/decision-client';
import { GATE_SLUGS } from '@buildd/core/gate-slugs';
import type { ChatRetroSettings } from './settings';
import { chatRetroGloballyEnabled } from './settings';
import {
  buildTurns, detectCandidates, isTrivialWindow, renderState, windowTotals,
  type RetroWindowInput,
} from './skeleton';
import {
  buildQuestions, failedLesson, judgedLesson, skippedLesson,
  type LessonRow, type RetroQuestions, type WindowRef,
} from './lesson';
import {
  appendText, planProposals, proposalDescription, proposalTitle, rankClusters,
  type Cluster, type PriorFiling, type ProposalAction,
} from './proposals';

/** Judged retros per team per UTC day; the rest are skipped as `team_cap`. */
export const RETRO_MAX_PER_TEAM_DAY = 20;
/** Windows looked at per run across all teams; the rest wait for the next day. */
export const RETRO_MAX_PER_RUN = 100;
/** Stop starting new work this long before the route's deadline. */
export const RETRO_DEADLINE_MARGIN_MS = 10_000;
export const RETRO_TIMEOUT_MS = 5_000;

/** The gate slug for refused or deferred proposal decisions. */
export const CHAT_RETRO_GATE = GATE_SLUGS.CHAT_RETRO_PROPOSAL;

export interface PassDeps {
  env?: Record<string, string | undefined>;
  now: () => Date;
  deadlineAt: number;
  listOptedInTeams: () => Promise<Array<{ teamId: string; settings: ChatRetroSettings }>>;
  listPendingConversations: (teamId: string, now: Date, limit: number) => Promise<Array<{ id: string; workspaceId: string | null; dataClass: string | null }>>;
  loadWindow: (teamId: string, conversationId: string) => Promise<RetroWindowInput>;
  judgedToday: (teamId: string, now: Date) => Promise<number>;
  /** One decision call. `onUsage` receives the receipt of every call that reached the provider. */
  decide: (args: { teamId: string; workspaceId: string | null; state: string; questions: RetroQuestions; onUsage: (r: DecisionReceipt) => void }) => Promise<DecisionResult<RetroQuestions>>;
  insertLessons: (rows: LessonRow[]) => Promise<void>;
  receipts: (receipts: DecisionReceipt[], teamId: string) => Promise<void>;
  loadClusters: (teamId: string, now: Date) => Promise<Cluster[]>;
  proposalsFiledToday: (teamId: string, now: Date) => Promise<number>;
  priorFiling: (workspaceId: string, signature: string) => Promise<PriorFiling | null>;
  insertProposalTask: (args: { cluster: Cluster; title: string; description: string }) => Promise<string | null>;
  appendToProposal: (taskId: string, text: string, sessions: number) => Promise<void>;
  gate: (e: { outcome: 'rejected' | 'deferred'; reason: string; workspaceId: string | null; taskId?: string | null; detail: Record<string, unknown> }) => void;
  pruneExpiredLessons: (now: Date) => Promise<number>;
  lessonsUrl: string;
}

export interface PassCounts {
  disabled: boolean;
  teams: number;
  windows: number;
  judged: number;
  skipped: number;
  failed: number;
  filed: number;
  appended: number;
  muted: number;
  deferred: number;
  noWorkspace: number;
  pruned: number;
  errors: number;
  jevCostUsd: number;
}

const zero = (): PassCounts => ({
  disabled: false, teams: 0, windows: 0, judged: 0, skipped: 0, failed: 0,
  filed: 0, appended: 0, muted: 0, deferred: 0, noWorkspace: 0, pruned: 0, errors: 0, jevCostUsd: 0,
});

export async function runChatRetroPass(deps: PassDeps): Promise<PassCounts> {
  const counts = zero();
  if (!chatRetroGloballyEnabled(deps.env)) return { ...counts, disabled: true };
  const now = deps.now();
  const timeLeft = () => deps.deadlineAt - Date.now() > RETRO_DEADLINE_MARGIN_MS;

  try { counts.pruned = await deps.pruneExpiredLessons(now); } catch { counts.errors++; }

  const teams = await deps.listOptedInTeams();
  counts.teams = teams.length;
  let runBudget = RETRO_MAX_PER_RUN;

  for (const { teamId, settings } of teams) {
    if (!settings.lessons) continue;
    try {
      let judgedBudget = Math.max(0, RETRO_MAX_PER_TEAM_DAY - await deps.judgedToday(teamId, now));
      // Newest first: over the cap, the older windows are the ones skipped.
      const pending = await deps.listPendingConversations(teamId, now, runBudget);
      const rows: LessonRow[] = [];
      const receipts: DecisionReceipt[] = [];
      for (const conv of pending) {
        if (runBudget <= 0 || !timeLeft()) break;
        runBudget--;
        const input = await deps.loadWindow(teamId, conv.id);
        if (input.messages.length === 0) continue;
        counts.windows++;
        const first = input.messages[0];
        const last = input.messages[input.messages.length - 1];
        const ref: WindowRef = {
          teamId, conversationId: conv.id, workspaceId: conv.workspaceId,
          fromMessageId: first.id, toMessageId: last.id, toMessageAt: new Date(last.createdAt),
        };
        const turns = buildTurns(input);
        const totals = windowTotals(turns);
        const skip = (reason: Parameters<typeof skippedLesson>[2], stateTokens: number | null = null) => {
          rows.push(skippedLesson(ref, totals, reason, stateTokens));
          counts.skipped++;
        };
        if (conv.dataClass === 'sensitive') { skip('sensitive'); continue; }
        if (isTrivialWindow(turns)) { skip('trivial'); continue; }
        if (judgedBudget <= 0) { skip('team_cap'); continue; }
        const candidates = detectCandidates(turns);
        const rendered = renderState(turns, candidates);
        if (!rendered) { skip('state_budget'); continue; }

        judgedBudget--;
        const questions = buildQuestions(candidates);
        let result: DecisionResult<RetroQuestions>;
        try {
          result = await deps.decide({ teamId, workspaceId: conv.workspaceId, state: rendered.state, questions, onUsage: r => { receipts.push(r); } });
        } catch {
          rows.push(failedLesson(ref, totals, 'threw', rendered.tokens, null));
          counts.failed++;
          continue;
        }
        if (!result.ok) {
          // Never retried: the watermark advances, a lost lesson costs less than re-billing it daily.
          rows.push(failedLesson(ref, totals, result.error.kind, rendered.tokens, result.latencyMs));
          counts.failed++;
          continue;
        }
        const jevCost = result.usage.costUsd;
        counts.jevCostUsd += jevCost ?? 0;
        rows.push(judgedLesson({
          ref, totals, candidates, answers: result.answers as never, model: result.model,
          stateTokens: rendered.tokens, latencyMs: result.latencyMs, jevCostUsd: jevCost,
        }));
        counts.judged++;
      }
      await deps.insertLessons(rows);
      if (receipts.length > 0) await deps.receipts(receipts, teamId);
    } catch (err) {
      counts.errors++;
      console.error(`[chat-retro] retro pass failed for a team:`, err instanceof Error ? err.message : err);
    }

    if (!settings.proposals) continue;
    try {
      await proposeForTeam(teamId, now, deps, counts);
    } catch (err) {
      counts.errors++;
      console.error(`[chat-retro] proposal pass failed for a team:`, err instanceof Error ? err.message : err);
    }
  }
  return counts;
}

async function proposeForTeam(teamId: string, now: Date, deps: PassDeps, counts: PassCounts): Promise<ProposalAction[]> {
  const ranked = rankClusters(await deps.loadClusters(teamId, now));
  if (ranked.length === 0) return [];
  const priors = new Map<string, PriorFiling | null>();
  for (const c of ranked) {
    priors.set(c.signature, c.workspaceId ? await deps.priorFiling(c.workspaceId, c.signature) : null);
  }
  const actions = planProposals(ranked, priors, { filedToday: await deps.proposalsFiledToday(teamId, now) });
  for (const a of actions) {
    const detail = { signature: a.cluster.signature, sessions: a.cluster.sessions, wastedTokens: a.cluster.wastedTokens };
    switch (a.kind) {
      case 'file':
        await deps.insertProposalTask({ cluster: a.cluster, title: proposalTitle(a.cluster), description: proposalDescription(a.cluster, deps.lessonsUrl) });
        counts.filed++;
        break;
      case 'append':
        await deps.appendToProposal(a.prior.taskId, appendText(a.cluster, a.prior, now), a.cluster.sessions);
        counts.appended++;
        break;
      case 'unchanged':
        break;
      case 'muted':
        counts.muted++;
        deps.gate({ outcome: 'rejected', reason: 'chat retro proposal muted until its evidence doubles', workspaceId: a.cluster.workspaceId, taskId: a.prior.taskId, detail: { ...detail, priorSessions: a.prior.sessions } });
        break;
      case 'deferred':
        counts.deferred++;
        deps.gate({ outcome: 'deferred', reason: 'chat retro proposal over the daily cap', workspaceId: a.cluster.workspaceId, detail });
        break;
      case 'no_workspace':
        counts.noWorkspace++;
        deps.gate({ outcome: 'rejected', reason: 'chat retro proposal has no workspace to file into', workspaceId: null, detail });
        break;
    }
  }
  return actions;
}
