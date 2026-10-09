/**
 * Escalation gate: the decision definition. Server-only, like
 * ./question-gate-decision.ts, whose prompt plumbing (`definePromptedDecision`)
 * and ledger it shares.
 *
 * Jev reads one stuck PR, already past every rule in ./escalation-gate.ts, and
 * answers: can Buildd move it on itself (and with which action), should it
 * wait, or is this a call for a person? The state it reads and the reader of
 * its answer are in ./escalation-gate.ts (`buildEscalationGateState`,
 * `readEscalationGateRun`), so the server gate needs no import of this module.
 */
import { choice } from '@builddai/ai-kit/decide';
import { definePromptedDecision } from './prompted-decision';
import {
  ESCALATION_GATE_DECISION_TIMEOUT_MS,
  ESCALATION_GATE_PROMPT_VERSION,
  type JevAction,
} from './escalation-gate';

export const ESCALATION_GATE_QUESTIONS = {
  disposition: choice(
    {
      question: 'A pull request opened by an AI agent has stopped moving and is about to be sent to the team owner as "needs you". You are the team\'s standing decision-maker for this. Can the platform move it on by itself, should it wait, or does a person have to decide?',
      rule: 'Judge only what is written in `pr`. Pick "ask" whenever the next step needs a person\'s judgment about the product, the risk or the scope, or getting it wrong would be hard to undo. Pick "act" only when one of the listed platform actions is plainly the next step and needs no judgment. Pick "hold" when nothing needs doing right now and the situation will likely change on its own.',
    },
    {
      act: 'The platform takes one of the listed actions itself; nobody is notified.',
      hold: 'Nothing to do yet; keep it out of the owner\'s list for a while and look again if it is still stuck.',
      ask: 'Send it to the owner now: it needs a person\'s decision.',
    },
  ),
  action: choice(
    {
      question: 'If you picked "act" above, which platform action is the next step? Ignored otherwise.',
      rule: 'Choose the one action that directly addresses why the PR stopped, as written in `pr.why` and `pr.detail`.',
    },
    {
      re_review: 'Ask the reviewer agent for a fresh review of the current head (the escalation or approval is about an older head, or the reviewer gave up for a reason that has since changed).',
      address_review: 'Send a builder agent to make the changes the reviewer asked for, then review again.',
      ci_fix: 'Send a builder agent to fix the failing checks.',
      conflict_fix: 'Send a builder agent to resolve the merge conflict with the base branch.',
      retry_landing: 'Retry the automatic merge once the base branch settles.',
    } satisfies Record<JevAction, string>,
  ),
};

export const ESCALATION_GATE_DECISION = definePromptedDecision({
  id: 'buildd.escalation_gate',
  promptVersion: ESCALATION_GATE_PROMPT_VERSION,
  questions: ESCALATION_GATE_QUESTIONS,
  mode: 'live',
  timeoutMs: ESCALATION_GATE_DECISION_TIMEOUT_MS,
});
