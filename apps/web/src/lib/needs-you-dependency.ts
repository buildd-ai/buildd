/**
 * A task that waits on a dependency whose PR only a person can move is itself
 * waiting on a person: `explain` says so (needsYou + a "needs you" cause)
 * instead of an ordinary dependency wait. Spec: docs/specs/acp-bridge.md (thread notes).
 */
import type { ExplainAnswer } from '@/lib/explain-types';
import { needsYouNote, type OwnerDelivery } from '@/lib/task-thread-target';

export function withDependencyNeedsYou(answer: ExplainAnswer, deps: ReadonlyArray<OwnerDelivery | null | undefined>): ExplainAnswer {
  for (const d of deps) {
    const n = d ? needsYouNote({ delivery: null, prUrl: null, dependency: { delivery: d, prUrl: null } }) : null;
    if (!n) continue;
    return { ...answer, presentation: { ...answer.presentation, needsYou: true, cause: 'human_approval', causeText: n.text } };
  }
  return answer;
}

/** Ids of the dependencies this viewer may see; a hidden one must not lend its PR to the answer. */
export function visibleDependencyIds(waitingOn: ReadonlyArray<{ id: string; hidden?: boolean }>): string[] {
  return waitingOn.filter(w => !w.hidden).map(w => w.id);
}
