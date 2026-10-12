'use client';

/**
 * `?state=task-page&case=<case>`: the task page's head for each regression
 * case in docs/specs/task-page.md, laid out like the page's main column.
 * Illustrative data only (task-page-fixtures.ts).
 */
import { useEffect, useState } from 'react';
import Lifecycle from '@/components/ui/Lifecycle';
import TaskVerdictBlock from '../../(protected)/tasks/[id]/TaskVerdictBlock';
import TaskChecks from '../../(protected)/tasks/[id]/TaskChecks';
import TaskSubjectLink from '../../(protected)/tasks/[id]/TaskSubjectLink';
import TaskTitle from '../../(protected)/tasks/[id]/TaskTitle';
import { HeaderStatusPill } from '../../(protected)/tasks/[id]/TaskSidePanel';
import { ASK_ABOUT_CLASS } from '@/components/chat/ChatEntry';
import { TaskShippedBody, TaskShippedDetails, TaskShippedTitle } from '../../(protected)/tasks/[id]/TaskShippedHeader';
import { TASK_PAGE_CASES, parseTaskPageCase, taskPageFixture, type TaskPageCase } from './task-page-fixtures';
import { TASK_PAGE_FIXTURE_STATE } from './visual-review-fixtures';

export function TaskPageFixture() {
  const [c, setC] = useState<TaskPageCase | null>(null);
  useEffect(() => { setC(parseTaskPageCase(new URLSearchParams(window.location.search).get('case'))); }, []);
  if (!c) return <div className="min-h-screen bg-surface-1" />;
  const f = taskPageFixture(c);
  return (
    <div className="min-h-screen bg-surface-1 p-4 md:p-8" data-testid="task-page-fixture" data-case={c}>
      <div className="max-w-[1000px]">
        <nav aria-label="Fixture cases" className="mb-6 flex flex-wrap gap-2 font-mono text-meta">
          {TASK_PAGE_CASES.map(k => (
            <a key={k} href={`?state=${TASK_PAGE_FIXTURE_STATE}&case=${k}`} className={`flex min-h-11 items-center border px-3 md:min-h-8 ${c === k ? 'border-accent text-accent-text' : 'border-border-default text-text-secondary'}`}>{k}</a>
          ))}
        </nav>
        {/* The page's header grid (tasks/[id]/page.tsx): full-width title on a
            phone, the pill and actions on the compact row under it. */}
        <nav aria-label="Breadcrumb" className="text-sm text-text-secondary -mt-2 mb-1 md:mt-0 md:mb-2">
          <a href="#" className="inline-flex min-h-11 items-center hover:text-text-primary">‹ Activity</a>
        </nav>
        <div className="mb-4 md:mb-6" data-testid="task-header">
          <div className={`grid items-start gap-x-3 gap-y-2 md:gap-x-4 ${!f.shipped && !f.verdict ? 'grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_auto_auto]' : 'grid-cols-[minmax(0,1fr)_auto]'}`}>
            <div className="min-w-0 col-span-2 row-start-1 md:col-span-1 md:col-start-1">
              {f.shipped ? <TaskShippedTitle view={f.shipped} title={f.title} /> : <TaskTitle title={f.title} />}
            </div>
            {!f.shipped && !f.verdict && (
              <span data-testid="task-header-status" className="col-start-1 row-start-2 self-center md:col-start-2 md:row-start-1 md:mt-0.5">
                <HeaderStatusPill status={f.taskStatus} merged={false} delivery={{ headline: f.view.headline, owner: f.view.owner, needsYou: f.view.needsYou, stage: f.view.stage, detail: f.view.detail, prState: f.view.prState, state: f.view.state }} />
              </span>
            )}
            <div data-testid="task-header-actions" className={`flex items-center justify-end gap-2 col-start-2 row-start-2 md:row-start-1 md:mt-0.5 ${!f.shipped && !f.verdict ? 'md:col-start-3' : ''}`}>
              <a href="#" aria-label="Ask about this task" className={ASK_ABOUT_CLASS}><span aria-hidden="true" className="text-accent-text">↳</span><span aria-hidden="true">Ask</span></a>
              <button type="button" aria-label="More actions" className="-mr-2.5 flex h-11 w-11 shrink-0 items-center justify-center text-text-secondary">⋯</button>
            </div>
          </div>
          <div data-testid="task-subline" className="mt-2 flex flex-wrap items-center gap-x-2 text-[12px] font-mono text-text-muted">
            <span>{f.subjectLink ? 'Reviewer' : 'fix · Builder'} · example</span>
            <a href="#" className="font-medium text-accent-text hover:underline">PR #1234 ↗</a>
          </div>
          {f.subjectLink && <TaskSubjectLink kind="review" href="#" prNumber={f.view.prNumber} title={f.subjectLink} />}
          {f.track && <Lifecycle state={f.track.state} phrase={f.track.phrase} className="mt-3" />}
        </div>
        {f.verdict && <TaskVerdictBlock verdict={f.verdict} displayStatus="completed" />}
        <TaskChecks
          checks={f.checks}
          prNumber={f.view.prNumber}
          prUrl={f.view.prNumber != null ? 'https://github.com/example/app/pull/1234' : null}
          headSha={f.view.headSha}
          findings={f.findings}
          currentTaskId={f.currentTaskId}
        />
        {f.shipped && <TaskShippedBody view={f.shipped} />}
        {f.shipped && <TaskShippedDetails view={f.shipped} runDetails={[{ label: 'Runner', value: 'example-runner' }, { label: 'Turns', value: '42' }]} />}
      </div>
    </div>
  );
}
