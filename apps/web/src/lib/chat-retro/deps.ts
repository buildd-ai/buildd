/**
 * The production wiring of the chat retro pass: the DB store, the team's
 * decision model, the `ai_usage` receipt path and the gate ledger.
 */
import { decisionCall } from '@buildd/core/decision-client';
import { recordGateEvent } from '@buildd/core/gate-events';
import { insertDecisionReceipts } from '@/lib/memory-decisions';
import { CHAT_RETRO_DECISION_ID } from './lesson';
import { CHAT_RETRO_GATE, RETRO_TIMEOUT_MS, type PassDeps } from './run';
import * as store from './store';

const APP_BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://buildd.dev';

export function productionDeps(deadlineAt: number): PassDeps {
  return {
    now: () => new Date(),
    deadlineAt,
    listOptedInTeams: store.listOptedInTeams,
    listPendingConversations: store.listPendingConversations,
    loadWindow: store.loadWindow,
    judgedToday: store.judgedToday,
    decide: ({ teamId, workspaceId, state, questions, onUsage }) => decisionCall({
      // The chat surface's own spending policy: the retro reads chat sessions
      // and spends the same team key chat routing does. Whether it runs at
      // all is the team's chat retro opt-in, checked before this call.
      capability: 'chat',
      teamId,
      workspaceId,
      state,
      questions,
      timeoutMs: RETRO_TIMEOUT_MS,
      decisionId: CHAT_RETRO_DECISION_ID,
      onUsage,
    }),
    insertLessons: store.insertLessons,
    receipts: (receipts, teamId) => insertDecisionReceipts(receipts, { teamId }),
    loadClusters: store.loadClusters,
    proposalsFiledToday: store.proposalsFiledToday,
    priorFiling: store.priorFiling,
    insertProposalTask: store.insertProposalTask,
    appendToProposal: store.appendToProposal,
    gate: e => {
      void recordGateEvent({
        gate: CHAT_RETRO_GATE,
        surface: 'cron /api/cron/chat-retro',
        outcome: e.outcome,
        reason: e.reason,
        workspaceId: e.workspaceId,
        taskId: e.taskId ?? null,
        detail: e.detail,
        callerOrigin: 'system',
      });
    },
    pruneExpiredLessons: store.pruneExpiredLessons,
    lessonsUrl: `${APP_BASE_URL}/app/settings/ai#chat-retro`,
  };
}
