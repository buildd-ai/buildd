'use client';

/**
 * A pull request as an object: one row inline (several PRs in one answer stack
 * as a list), and the task page's PR card in the pane.
 */
import Link from 'next/link';
import { PR_PILL } from '@/lib/pr-presentation';
import PrCard from '@/components/task/PrCard';
import { taskPageHref } from '@/lib/mission-task-href';
import type { BuilddObjectRef } from '../chat-contract';
import { useChatActions } from '../ChatActions';
import type { PrObjectView } from './object-views';
import { Eyebrow, OpenButton } from './parts';

// Wording comes from the one PR map (PR_PILL); only the inline text tone is local.
const TONE: Record<PrObjectView['state'], string> = {
  merged: 'text-status-success',
  ci_passed: 'text-status-success',
  ci_running: 'text-accent-text',
  ci_failed: 'text-status-error',
  conflict: 'text-status-warning',
  open: 'text-text-secondary',
  closed: 'text-text-muted',
};

export function PrRow({ objRef, view, flush = false }: { objRef: BuilddObjectRef; view: PrObjectView; flush?: boolean }) {
  const actions = useChatActions();
  const st = { text: PR_PILL[view.state].label.toLowerCase(), cls: TONE[view.state] };
  const inPane = actions.paneRef?.kind === 'pr' && actions.paneRef.id === objRef.id;
  const merged = view.state === 'merged';
  return (
    <div
      data-testid="object-card"
      data-kind="pr"
      data-state={view.state}
      className={`flex min-h-11 min-w-0 items-center gap-3 px-4 py-2 font-mono text-[13px] ${flush ? '' : 'border-2 border-border-strong bg-card'} ${merged ? 'bg-[color-mix(in_srgb,var(--status-success)_7%,var(--card))]' : 'bg-card'}`}
    >
      {view.url
        ? <a href={view.url} target="_blank" rel="noreferrer" className={`shrink-0 font-semibold ${merged ? 'text-status-success' : 'text-text-primary'} hover:underline`}>{`#${view.number}`}</a>
        : <span className="shrink-0 font-semibold text-text-primary">{`#${view.number}`}</span>}
      <span className="min-w-0 flex-1 truncate text-text-primary">{view.title}</span>
      {!merged && <span className={`hidden shrink-0 text-[11px] font-bold uppercase tracking-[1.2px] sm:inline ${st.cls}`}>{st.text}</span>}
      {(view.linesAdded != null || view.linesRemoved != null) && (
        <span className="shrink-0 tabular-nums">
          <span className="text-status-success">{`+${view.linesAdded ?? 0}`}</span>{' '}
          <span className="text-status-error">{`−${view.linesRemoved ?? 0}`}</span>
        </span>
      )}
      {!flush && <OpenButton inPane={inPane} onOpen={() => actions.openObject(objRef)} label="▸" />}
    </div>
  );
}

export function PrPane({ view, variant = 'pane' }: { view: PrObjectView; variant?: 'pane' | 'sheet' }) {
  return (
    <div data-testid="object-pane" data-kind="pr" className={variant === 'pane' ? 'px-6 pb-10 pt-5' : 'pb-6'}>
      <Eyebrow className="text-text-muted">Pull request</Eyebrow>
      <h2 className="mt-2 font-mono text-[20px] font-semibold text-text-primary [overflow-wrap:anywhere]">{`#${view.number} ${view.title}`}</h2>
      <div className="mt-4">
        {view.url ? (
          <PrCard
            prUrl={view.url}
            prNumber={view.number}
            prState={view.state}
            linesAdded={view.linesAdded}
            linesRemoved={view.linesRemoved}
            ciChecks={null}
            reviews={null}
            mergeable={null}
            mergeableState={null}
          />
        ) : (
          <p className="font-mono text-[12.5px] text-text-muted">No link recorded for this PR.</p>
        )}
      </div>
      {view.taskId && (
        <Link href={taskPageHref({ taskId: view.taskId, missionId: view.missionId })} className="mt-5 inline-flex min-h-10 items-center border-2 border-border-strong bg-surface-3 px-4 font-mono text-[13px] font-semibold text-text-primary hover:bg-surface-4">
          Open task →
        </Link>
      )}
    </div>
  );
}
