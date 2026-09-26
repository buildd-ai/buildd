/**
 * One Waiting-on-You action card (MERGE · REVIEW · QUESTION · DECIDE ·
 * DISCREPANCY · RECONNECT · APPROVE · RESOLVING · FIXING_CI · CI_RUNNING ·
 * AUTO_MERGE · BLOCKED · STALE),
 * moved verbatim out of home/page.tsx so the page composes sections instead
 * of spelling every card. Selection and ordering stay in lib/action-queue.ts.
 */
import Link from 'next/link';
import Spinner from '@/components/Spinner';
import { SwipeableRow } from '@/components/SwipeableRow';
import { WaitingOnYouMergeCard } from '@/components/WaitingOnYouMergeCard';
import { WaitingOnYouReviewCard } from '@/components/WaitingOnYouReviewCard';
import { WaitingOnYouDecideCard } from '@/components/WaitingOnYouDecideCard';
import { WaitingOnYouDiscrepancyCard } from '@/components/WaitingOnYouDiscrepancyCard';
import { AgentHandledCard } from '@/components/AgentHandledCard';
import { FixCiButton } from '@/components/FixCiButton';
import { AgentRecommendation } from '@/components/AgentRecommendation';
import { actionCardTaskLink, resolveActionCardContext } from '@/lib/action-card-context';
import type { ActionQueueItem } from '@/lib/action-queue';

export function ActionQueueCard({ item }: { item: ActionQueueItem }) {
    const arc = resolveActionCardContext(item);
    if (item.chip === 'MERGE') {
      return (
        <SwipeableRow
          key={item.subjectKey}
          cardType="gate-card"
          taskTitle={item.taskTitle ?? `PR #${item.prNumber}`}
          prUrl={item.prUrl}
          subjectKey={item.subjectKey}
        >
          <WaitingOnYouMergeCard item={item} />
        </SwipeableRow>
      );
    }
    if (item.chip === 'REVIEW') {
      return (
        <SwipeableRow
          key={item.subjectKey}
          cardType="gate-card"
          taskTitle={item.taskTitle ?? `PR #${item.prNumber}`}
          prUrl={item.prUrl}
          subjectKey={item.subjectKey}
        >
          <WaitingOnYouReviewCard item={item} />
        </SwipeableRow>
      );
    }
    if (item.chip === 'QUESTION') {
      return (
        <Link
          key={item.subjectKey}
          href={actionCardTaskLink(item)}
          className="block border-l-2 border-status-warning bg-status-warning/5 rounded-r-[10px] px-4 py-3 hover:bg-status-warning/10 transition-colors"
        >
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[11px] font-mono font-medium text-status-warning tracking-wide uppercase">
              Question
            </span>
            {arc && arc.kind !== 'workspace' && (
              <span className="text-[11px] text-text-muted">{arc.label}</span>
            )}
          </div>
          <div className="text-[13px] font-medium text-text-primary line-clamp-2 [overflow-wrap:anywhere] mb-0.5">
            {item.taskTitle}
          </div>
          <p className="text-[12px] text-text-secondary line-clamp-2">{item.question}</p>
        </Link>
      );
    }
    if (item.chip === 'DECIDE') {
      return <WaitingOnYouDecideCard key={item.subjectKey} item={item} />;
    }
    if (item.chip === 'DISCREPANCY' || item.chip === 'FIXING_SPEC') {
      // Same card either way: FIXING_SPEC is the same finding
      // with a doc fix already dispatched against it, so it
      // renders the link instead of the CTA set rather than
      // becoming a different-looking row.
      return <WaitingOnYouDiscrepancyCard key={item.subjectKey} item={item} />;
    }
    if (item.chip === 'RECONNECT') {
      return (
        <Link
          key={item.subjectKey}
          href="/app/connections"
          className="block border-l-2 border-status-error bg-status-error/5 rounded-r-[10px] px-4 py-3 hover:bg-status-error/10 transition-colors"
        >
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[11px] font-mono font-medium tracking-wide uppercase text-status-error">
              Reconnect
            </span>
            <span className="text-[11px] text-text-muted">Connection</span>
          </div>
          <div className="text-[13px] font-medium text-text-primary truncate">
            {item.connectorName}
            <span className="font-normal text-text-secondary"> needs re-authorising</span>
          </div>
        </Link>
      );
    }
    if (item.chip === 'APPROVE') {
      return (
        <Link
          key={item.subjectKey}
          href={actionCardTaskLink(item, { page: true })}
          className="block border-l-2 border-accent bg-accent/5 rounded-r-[10px] px-4 py-3 hover:bg-accent/10 transition-colors"
        >
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[11px] font-mono font-medium text-accent-text tracking-wide uppercase">
              Approve Plan
            </span>
            {arc && arc.kind !== 'workspace' && (
              <span className="text-[11px] text-text-muted">{arc.label}</span>
            )}
          </div>
          <div className="text-[13px] font-medium text-text-primary line-clamp-2 [overflow-wrap:anywhere]">
            {item.taskTitle}
          </div>
        </Link>
      );
    }
    if (item.chip === 'RESOLVING') {
      return (
        <div
          key={item.subjectKey}
          className="border-l-2 border-text-muted bg-surface-2 rounded-r-[10px] px-4 py-3"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                <span className="inline-flex items-center gap-1 text-[11px] font-mono font-medium text-text-muted tracking-wide uppercase">
                  <Spinner size="xs" aria-label="Resolving conflicts" />
                  Resolving Conflicts
                  {item.conflictRetryIteration != null && ` · attempt ${item.conflictRetryIteration}`}
                </span>
              </div>
              {item.taskTitle && (
                <div className="text-[13px] font-medium text-text-primary line-clamp-2 [overflow-wrap:anywhere] mt-0.5">
                  {item.conflictRetryTaskId ? (
                    <Link href={actionCardTaskLink(item, { taskId: item.conflictRetryTaskId, page: true })} className="hover:underline">
                      {item.taskTitle}
                    </Link>
                  ) : item.taskId ? (
                    <Link href={actionCardTaskLink(item)} className="hover:underline">
                      {item.taskTitle}
                    </Link>
                  ) : item.taskTitle}
                </div>
              )}
              {item.prUrl && (
                <a
                  href={item.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center min-h-11 md:min-h-0 text-[11px] text-text-muted hover:underline mt-0.5"
                >
                  PR #{item.prNumber} ↗
                </a>
              )}
            </div>
          </div>
        </div>
      );
    }
    if (item.chip === 'FIXING_CI' || item.chip === 'CI_RUNNING' || item.chip === 'AUTO_MERGE') {
      return <AgentHandledCard key={item.subjectKey} item={item} />;
    }
    if (item.chip === 'BLOCKED') {
      return (
        <div
          key={item.subjectKey}
          className="border-l-2 border-status-error bg-status-error/5 rounded-r-[10px] px-4 py-3"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                <span className="text-[11px] font-mono font-medium text-status-error tracking-wide uppercase">
                  Blocked
                </span>
                {arc && (
                  <span className="text-[11px] text-text-muted">{arc.label}</span>
                )}
              </div>
              {item.taskTitle && (
                <div className="text-[13px] font-medium text-text-primary line-clamp-2 [overflow-wrap:anywhere] mt-0.5">
                  {item.taskId ? (
                    <Link href={actionCardTaskLink(item)} className="hover:underline">
                      {item.taskTitle}
                    </Link>
                  ) : item.taskTitle}
                </div>
              )}
              <p className="text-[12px] text-text-secondary mt-0.5">
                {item.escalationReason ?? 'Agents ran out of conflict-resolution retries. Resolve the conflict yourself.'}
              </p>
              {/* The human is being asked to decide something an
                  agent already failed at — lead with what that
                  agent said to do next, not with a merge button. */}
              <AgentRecommendation
                recommendation={item.recommendation}
                expected={item.ciGate?.kind === 'blocked'}
                tone="error"
              />
              {item.prUrl && (
                <a
                  href={item.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center min-h-11 md:min-h-0 text-[11px] text-text-muted hover:underline mt-0.5"
                >
                  PR #{item.prNumber} ↗
                </a>
              )}
            </div>
            {item.deadZoneLastRetryTaskId && (
              <Link
                href={actionCardTaskLink(item, { taskId: item.deadZoneLastRetryTaskId, page: true })}
                className="shrink-0 inline-flex items-center min-h-11 md:min-h-0 text-[12px] font-medium text-text-secondary hover:text-text-primary border border-border rounded-md px-2.5 py-1 whitespace-nowrap"
              >
                Last attempt
              </Link>
            )}
            {/* Only a genuine CI block gets a fix action — a
                conflict dead-zone needs a merge decision, not
                a CI retry. */}
            {item.ciGate?.kind === 'blocked' && (
              <FixCiButton prNumber={item.prNumber} workspaceId={item.workspaceId} />
            )}
          </div>
        </div>
      );
    }
    // STALE — the shape #1790 established for BLOCKED, applied to
    // a different failure: we either cannot vouch for this PR's
    // current state, or we can and it is old enough that merging
    // it blind is the wrong ask. Either way it is a decision, not
    // a tap, so there is no merge button.
    if (item.chip === 'STALE') {
      const ageLabel = item.cardAgeHours == null
        ? null
        : item.cardAgeHours < 48
          ? `${item.cardAgeHours}h old`
          : `${Math.floor(item.cardAgeHours / 24)}d old`;
      return (
        <div
          key={item.subjectKey}
          className="border-l-2 border-border bg-surface-raised/40 rounded-r-[10px] px-4 py-3"
        >
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
            <span className="text-[11px] font-mono font-medium text-text-muted tracking-wide uppercase">
              Stale
            </span>
            {ageLabel && (
              <span className="text-[11px] font-mono text-text-muted">{ageLabel}</span>
            )}
            {arc && (
              <span className="text-[11px] text-text-muted">{arc.label}</span>
            )}
          </div>
          {item.taskTitle && (
            <div className="text-[13px] font-medium text-text-secondary line-clamp-2 [overflow-wrap:anywhere] mt-0.5">
              {item.taskId ? (
                <Link href={actionCardTaskLink(item)} className="hover:underline">
                  {item.taskTitle}
                </Link>
              ) : item.taskTitle}
            </div>
          )}
          <p className="text-[12px] text-text-muted mt-0.5">
            {item.staleGate?.reason ?? item.escalationReason}
          </p>
          {item.prUrl && (
            <a
              href={item.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center min-h-11 md:min-h-0 text-[11px] text-text-muted hover:underline mt-0.5"
            >
              Check PR #{item.prNumber} on GitHub ↗
            </a>
          )}
        </div>
      );
    }
    return null;
}
