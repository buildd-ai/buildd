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
        <div className="mb-5 md:mb-6" data-testid="task-header">
          {f.shipped
            ? <TaskShippedTitle view={f.shipped} title={f.title} />
            : <h1 className="text-[22px] md:text-[24px] font-semibold leading-snug tracking-[-0.2px] break-words max-w-[760px]">{f.title}</h1>}
          <div className="mt-2 flex flex-wrap items-center gap-x-2 text-[12px] font-mono text-text-muted">
            <span>{f.subjectLink ? 'Reviewer' : 'fix · Builder'} · example</span>
            <a href="#" className="font-medium text-accent-text hover:underline">PR #1234 ↗</a>
          </div>
          {f.subjectLink && (
            <p data-testid="task-subject-link" className="mt-2 text-meta text-text-secondary">
              Review of <a href="#" className="text-accent-text hover:underline">{f.subjectLink} ›</a>
            </p>
          )}
          {f.track && <Lifecycle state={f.track.state} phrase={f.track.phrase} className="mt-3" />}
        </div>
        <TaskVerdictBlock verdict={f.verdict} displayStatus="completed" />
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
