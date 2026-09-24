'use client';

/**
 * MissionContextBar: the sticky mission header on the full task page
 * (docs/design/mission-feed-mobile-continuity.md W6). It is the `micro`
 * masthead — the same object the task sheet opens with — so a task reads the
 * same whether it was opened over the mission or cold from a link:
 *
 * - `‹ <mission>` goes to `/app/missions/X#t-<task>`, landing on the row;
 * - the context pulse rings this task (an attempt rings its parent);
 * - `n / N · PHASE` and ‹ › step to the sibling task pages in pulse order,
 *   with `router.replace` so stepping never piles up history.
 *
 * Sticky at the top of the task page's own scroller; bleeds to its edges.
 */
import { useRouter } from 'next/navigation';
import MissionMasthead from '@/components/missions/MissionMasthead';
import type { MissionContextBarData } from './mission-context-bar';

export function MissionContextBarView({
  bar,
  onStep,
}: {
  bar: MissionContextBarData;
  onStep?: (href: string) => void;
}) {
  const { position } = bar;
  return (
    <div
      data-testid="mission-context-bar"
      className="sticky top-0 z-20 -mx-4 -mt-4 mb-4 border-b-2 border-border-strong bg-surface-1 px-4 pt-1 md:-mx-8 md:-mt-8 md:px-8 md:pt-2"
    >
      <MissionMasthead
        size="micro"
        title={bar.title}
        chip={bar.chip}
        segments={bar.segments}
        href={bar.upHref}
        selectedTaskId={bar.selectedTaskId}
        position={position}
        onStep={
          onStep && position
            ? dir => {
                const href = dir === 'prev' ? position.prevHref : position.nextHref;
                if (href) onStep(href);
              }
            : undefined
        }
      />
    </div>
  );
}

export default function MissionContextBar({ bar }: { bar: MissionContextBarData }) {
  const router = useRouter();
  return <MissionContextBarView bar={bar} onStep={href => router.replace(href)} />;
}
