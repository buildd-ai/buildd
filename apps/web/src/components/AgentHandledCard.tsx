import Link from 'next/link';
import Spinner from './Spinner';
import { ActionCardContextLine } from './ActionCardContextLine';
import type { ActionQueueItem } from '@/lib/action-queue';
import { actionCardTaskLink } from '@/lib/action-card-context';

/**
 * Informational card for work an agent already owns — a live CI fix, or a check
 * suite still running. It stays in the queue so a stuck agent is visible, but
 * carries no merge affordance and no count: nothing here is waiting on a human.
 */
export function AgentHandledCard({ item }: { item: ActionQueueItem }) {
  const gate = item.ciGate;
  const label = gate && gate.kind !== 'blocked' ? gate.label : 'Agent working';
  const fixTaskId = gate?.kind === 'fixing' ? gate.taskId : null;
  const spinning = gate?.kind === 'fixing';

  return (
    <div className="border-l-2 border-text-muted bg-surface-2 rounded-r-[10px] px-4 py-3">
      <div className="flex items-center gap-2 mb-0.5 flex-wrap">
        <span className="inline-flex items-center gap-1 text-[11px] font-mono font-medium text-text-muted tracking-wide uppercase">
          {spinning && <Spinner size="xs" aria-label="In progress" />}
          {label}
        </span>
      </div>

      {item.taskTitle && (
        <div className="text-[13px] font-medium text-text-primary line-clamp-2 [overflow-wrap:anywhere]">
          {item.taskId ? (
            <Link href={actionCardTaskLink(item)} className="hover:underline">
              {item.taskTitle}
            </Link>
          ) : item.taskTitle}
        </div>
      )}

      <div className="flex items-center gap-3 mt-0.5 flex-wrap">
        {fixTaskId && (
          <Link href={actionCardTaskLink(item, { taskId: fixTaskId, page: true })} className="inline-flex items-center min-h-11 md:min-h-0 text-[11px] font-medium text-accent-text hover:underline">
            View fix attempt
          </Link>
        )}
        {item.prUrl && (
          <a
            href={item.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center min-h-11 md:min-h-0 text-[11px] text-text-muted hover:underline"
          >
            PR #{item.prNumber} ↗
          </a>
        )}
      </div>

      <ActionCardContextLine item={item} className="mt-0.5" />
    </div>
  );
}
