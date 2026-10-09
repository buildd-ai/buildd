/**
 * The escalation gate's slots (lib/escalation-gate-check.ts), filled: Jev's
 * model call, the decision ledger, the ai_usage receipts and the repair-task
 * filer for an `act` verdict. One set, so every look takes the same action.
 *
 * Surfaces (Home, the PR inbox, the badge, list_prs) use `escalationGateReadDeps`:
 * they read stored verdicts and queue the rest, and the look runs after the
 * response (`after()`), so no page load waits on Jev. An escalation push looks
 * at once with `escalationGateDeps` (decide: true): that is the state change.
 */
import { after } from 'next/server';
import { ESCALATION_GATE_DECISION } from '@buildd/core/escalation-gate-decision';
import { resolveDecisionAccess } from '@buildd/core/decision-client';
import { recordDecision } from '@buildd/core/decision-ledger';
import { escalationActionFiler, gateEscalations, type EscalationGateDeps, type GatedSubject } from './escalation-gate-check';
import { escalationFingerprint } from '@buildd/core/escalation-gate';
import { escalationRuleExecutor } from './escalation-rule-executor';
import { insertDecisionReceipts } from './memory-decisions';
import { fileRecoverableBlockerRepair } from './recoverable-blocker-repair';

export function escalationGateDeps(): EscalationGateDeps {
  return {
    decide: true,
    resolveAccess: s => resolveDecisionAccess({ capability: 'escalation_gate', ...s }),
    run: ESCALATION_GATE_DECISION.run,
    record: input => recordDecision(input),
    recordReceipts: (receipts, scope) => insertDecisionReceipts(receipts, scope),
    act: escalationActionFiler(fileRecoverableBlockerRepair),
    actRule: escalationRuleExecutor(),
  };
}

/**
 * Queue a background look for these subjects. One look per (subject, state)
 * in flight on this instance, so two loads at once do not ask Jev twice.
 * Outside a request scope `after()` throws and the look runs fire-and-forget.
 */
export function createEscalationDecisionScheduler(
  schedule: (task: () => Promise<void>) => void = after,
  look: typeof gateEscalations = gateEscalations,
  deps: () => EscalationGateDeps = escalationGateDeps,
): (subjects: GatedSubject[]) => void {
  const inFlight = new Set<string>();
  return (subjects) => {
    const fresh = subjects.filter(s => {
      const id = `${s.key}|${escalationFingerprint(s)}`;
      if (inFlight.has(id)) return false;
      inFlight.add(id);
      return true;
    });
    if (fresh.length === 0) return;
    const task = async () => {
      try {
        await look(fresh, { ...deps(), decide: true });
      } catch (err) {
        console.warn('[escalation-gate] background look failed (non-fatal):', (err as Error)?.message ?? err);
      } finally {
        for (const s of fresh) inFlight.delete(`${s.key}|${escalationFingerprint(s)}`);
      }
    };
    try {
      schedule(task);
    } catch {
      void task();
    }
  };
}

const scheduleEscalationDecisions = createEscalationDecisionScheduler();

/** What a surface passes: read stored verdicts and rules, queue the rest. Never calls the model. */
export function escalationGateReadDeps(): EscalationGateDeps {
  return { ...escalationGateDeps(), decide: false, enqueue: scheduleEscalationDecisions };
}
