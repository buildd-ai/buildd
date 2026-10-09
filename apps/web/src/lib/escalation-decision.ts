/**
 * The escalation gate's slots (lib/escalation-gate-check.ts), filled: Jev's
 * model call, the decision ledger, the ai_usage receipts and the repair-task
 * filer for an `act` verdict. One set, so every surface that gates a PR (the
 * PR inbox, Home, the push check) takes the same action on the same look.
 */
import { ESCALATION_GATE_DECISION } from '@buildd/core/escalation-gate-decision';
import { resolveDecisionAccess } from '@buildd/core/decision-client';
import { recordDecision } from '@buildd/core/decision-ledger';
import { escalationActionFiler, type EscalationGateDeps } from './escalation-gate-check';
import { insertDecisionReceipts } from './memory-decisions';
import { fileRecoverableBlockerRepair } from './recoverable-blocker-repair';

export function escalationGateDeps(): EscalationGateDeps {
  return {
    resolveAccess: s => resolveDecisionAccess({ capability: 'escalation_gate', ...s }),
    run: ESCALATION_GATE_DECISION.run,
    record: input => recordDecision(input),
    recordReceipts: (receipts, scope) => insertDecisionReceipts(receipts, scope),
    act: escalationActionFiler(fileRecoverableBlockerRepair),
  };
}
