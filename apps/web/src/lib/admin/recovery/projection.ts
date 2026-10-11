/**
 * State, owner and sentence for one incident, as the operator queue shows them
 * (operator-recovery R5, OR-3: admin never re-derives state).
 *
 * Everything here is read off the stored FIR assessment and nothing is
 * inferred: the state and owner are `recovery.state` / `recovery.owner`, and the
 * sentence is the words the assessment itself carries (the decision question,
 * the next action's label, the passing check's summary).
 *
 * FIR workstream (b) adds the shared projection in `apps/web/src/lib/incident-view.ts`
 * that the incident page, Home and the push will use. When it lands, this
 * function should delegate to it so every surface reads one function; until
 * then it stays a pure reader of the same stored fields.
 */
import type { FailureIncident, OperatorRecoveryOwner, OperatorRecoveryState } from '@buildd/shared';

export interface IncidentProjection {
  state: OperatorRecoveryState;
  owner: OperatorRecoveryOwner;
  sentence: string;
}

const NOT_ASSESSED = 'Buildd has not assessed this yet.';

export function projectIncident(i: Pick<FailureIncident, 'status' | 'recovery' | 'resolvedAt'>): IncidentProjection {
  const r = i.recovery && i.recovery.v === 1 ? i.recovery : null;
  if (!r) {
    return i.status === 'resolved'
      ? { state: 'recovered', owner: 'buildd', sentence: 'Resolved.' }
      : { state: 'observing', owner: 'buildd', sentence: NOT_ASSESSED };
  }
  const summary = typeof r.verification.params?.summary === 'string' ? r.verification.params.summary : null;
  const sentence = r.state === 'needs_decision' && r.decision
    ? r.decision.question
    : r.state === 'recovered'
      ? summary ?? 'Recovered.'
      : r.nextAction?.label ?? NOT_ASSESSED;
  return { state: r.state, owner: r.owner, sentence };
}

/** Worst first (§3.1): the state a cause shows is its worst member's. */
export const STATE_ORDER: readonly OperatorRecoveryState[] = [
  'needs_decision', 'needs_operator', 'inconclusive', 'recovering', 'waiting', 'observing', 'recovered',
];

export function worstState(states: ReadonlyArray<OperatorRecoveryState>): OperatorRecoveryState {
  let best = STATE_ORDER.length - 1;
  for (const s of states) best = Math.min(best, STATE_ORDER.indexOf(s));
  return STATE_ORDER[best];
}
