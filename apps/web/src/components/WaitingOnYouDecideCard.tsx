import Link from 'next/link';
import { AgentRecommendation } from './AgentRecommendation';
import type { ActionQueueItem } from '@/lib/action-queue';

interface WaitingOnYouDecideCardProps {
  item: ActionQueueItem;
}

/**
 * DECIDE card for Home. Home stays a router: this card names the mission and
 * the blocking question, surfaces the failure-pattern reading as a
 * recommendation (never a preselected exit), and offers exactly one filled
 * CTA — the actual three exits (file the work / fix the criterion / waive)
 * live on the mission-detail decision sheet, not here.
 */
export function WaitingOnYouDecideCard({ item }: WaitingOnYouDecideCardProps) {
  return (
    <div className="border-l-2 border-status-warning bg-status-warning/5 rounded-r-[10px] px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[10px] font-mono font-medium text-status-warning tracking-wide uppercase">
              Decide
            </span>
          </div>
          <div className="text-[13px] font-medium text-text-primary truncate mb-0.5">
            {item.missionTitle ?? 'Mission'}
          </div>
          {item.noteTitle && (
            <div className="text-[12px] font-medium text-text-primary mb-1 line-clamp-1">
              {item.noteTitle}
            </div>
          )}
          <AgentRecommendation recommendation={item.recommendation} />
        </div>
        <Link
          href={`/app/missions/${item.missionId}`}
          className="shrink-0 text-[12px] font-medium text-white bg-status-warning hover:bg-status-warning/90 transition-colors rounded-md px-2.5 py-1 whitespace-nowrap"
        >
          Decide →
        </Link>
      </div>
    </div>
  );
}
