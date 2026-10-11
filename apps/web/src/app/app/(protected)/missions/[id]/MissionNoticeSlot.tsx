import { Children, type ReactNode } from 'react';
import type { MissionDisplayState } from '@/lib/mission-helpers';
import type { WaitingOnDescriptor } from '@/lib/mission-state-view';

/**
 * What a mission can wait on that Buildd cannot clear by itself. Everything
 * else (a CI repair, a dependency, a self-resolving wait, a deferred claim,
 * an unverified criterion) is in progress, not a decision.
 */
const NEEDS_PERSON: ReadonlySet<WaitingOnDescriptor['kind']> = new Set([
  'human_decision', 'merge', 'pr_closed_unmerged', 'criterion_failing', 'task_failed',
]);

export function noticeNeedsPerson({ displayState, budgetExhausted, focusKind }: {
  displayState: MissionDisplayState | string;
  budgetExhausted: boolean;
  focusKind: WaitingOnDescriptor['kind'] | null;
}): boolean {
  if (displayState === 'waiting_decision' || budgetExhausted) return true;
  return focusKind != null && NEEDS_PERSON.has(focusKind);
}

/**
 * The mission page's one notice slot, above the strip. Whatever the mission
 * is waiting on (its situation, a decision gate, the budget, the mission PR,
 * the review summary) renders here, in rank order, separated by hairlines,
 * every action kept. It is an L3 decision card only when a person has to act;
 * otherwise a quiet L1 block, because Buildd is handling it.
 */
export default function MissionNoticeSlot({ needsYou, children }: { needsYou: boolean; children: ReactNode }) {
  const items = Children.toArray(children).filter(Boolean);
  if (items.length === 0) return null;
  return (
    <section
      data-testid="mission-notice"
      data-level={needsYou ? '3' : '1'}
      aria-label={needsYou ? 'Needs you' : 'Status'}
      className={`flex flex-col gap-3 [&>*+*]:border-t [&>*+*]:border-[var(--line-soft)] [&>*+*]:pt-3 ${
        needsYou ? 'card-decision p-4' : 'border-t border-border-default pt-3'
      }`}
    >
      {items}
    </section>
  );
}
