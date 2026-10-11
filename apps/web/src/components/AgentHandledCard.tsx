import Link from 'next/link';
import Spinner from './Spinner';
import { ActionCardContextLine } from './ActionCardContextLine';
import { describePendingGates, type ActionQueueItem } from '@/lib/action-queue';
import { actionCardTaskLink } from '@/lib/action-card-context';
import { deliveryReading } from '@/lib/workflow/delivery-display';

/**
 * Informational card for work an agent already owns — a live CI fix, a check
 * suite still running, a reviewer checking the latest commit, or a PR the
 * platform will merge by itself on green. It stays in the queue so a stuck agent is visible, but
 * carries no merge affordance and no count: nothing here is waiting on a human.
 */
export function AgentHandledCard({ item }: { item: ActionQueueItem }) {
  const gate = item.ciGate;
  // A pending CI/review wait names exactly what is pending ("CI passed ·
  // reviewer checking the latest commit"), never a generic "still running".
  // A kernel-owned delivery states its own reading (workflow-state-kernel
  // §17.5): the headline, then the evidence below the title.
  const delivery = item.delivery ?? null;
  const deliveryReads = delivery
    ? deliveryReading({ stage: delivery.stage, state: delivery.state, headline: delivery.headline, owner: delivery.owner })
    : null;
  const label = delivery && deliveryReads
    ? deliveryReads.label
    : delivery
    ? delivery.headline
    : item.pendingGates
    ? describePendingGates(item.pendingGates)
    : gate && gate.kind !== 'blocked'
    ? gate.label
    : item.chip === 'AUTO_MERGE' ? (item.escalationReason ?? 'Auto-merges when CI passes') : 'Agent working';
  const fixTaskId = gate?.kind === 'fixing' ? gate.taskId : null;
  const fixTaskTitle = gate?.kind === 'fixing' ? gate.taskTitle : null;
  const spinning = gate?.kind === 'fixing' || item.pendingGates?.review === 'reviewing';

  return (
    <div className="border-l-2 border-text-muted bg-surface-2 px-4 py-3">
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

      {delivery?.detail && (
        <p data-testid="agent-handled-delivery-detail" className="mt-0.5 text-[12px] text-text-secondary [overflow-wrap:anywhere]">{delivery.detail}</p>
      )}

      <div className="flex items-center gap-3 mt-0.5 flex-wrap">
        {delivery?.cta?.action === 'repair_remediation' && (
          <Link
            data-testid="agent-handled-repair-cta"
            href={actionCardTaskLink(item, { taskId: delivery.cta.taskId, page: true })}
            className="inline-flex items-center min-h-11 md:min-h-0 text-[11px] font-semibold text-accent-text hover:underline"
          >
            {delivery.cta.label}
          </Link>
        )}
        {fixTaskId && (
          <Link href={actionCardTaskLink(item, { taskId: fixTaskId, page: true })} className="inline-flex items-center min-h-11 md:min-h-0 text-[11px] font-medium text-accent-text hover:underline">
            {fixTaskTitle ?? 'View fix attempt'}
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
