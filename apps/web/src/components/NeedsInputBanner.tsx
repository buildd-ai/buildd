'use client';

import Link from 'next/link';
import { useNeedsInput } from './NeedsInputProvider';
import { taskAnswerHref } from '@/lib/mission-task-href';
import { bannerTasks, useBannerHidden, useHiddenNeedsInput, usePhoneBannerHidden } from '@/lib/needs-input-hidden';
import { taskHeading } from '@/app/app/(protected)/tasks/[id]/task-header';

/**
 * A waiting task opens on its own page, answer focused: the page is the full
 * answering experience (the question, each option and what it leads to, the
 * own-words box). A mission task keeps its way back to the mission.
 */
export function needsInputTaskHref(task: { id: string; missionId?: string | null }): string {
  return taskAnswerHref({ taskId: task.id, missionId: task.missionId ?? null });
}

export default function NeedsInputBanner() {
  const { tasks: waiting, alertPermission, enableAlerts } = useNeedsInput();
  // A question whose own sheet or pane is open is answered right there; the
  // banner naming it on top of that sheet only repeats it.
  const shown = bannerTasks(waiting, useHiddenNeedsInput());
  // An answered question is not waiting on anyone but the agent.
  const tasks = shown.filter(t => !t.answerSent);
  const sent = shown.filter(t => t.answerSent);
  const count = tasks.length;
  // The phone chat canvas in needs-you mood already says it (needs-input-hidden.ts).
  const phoneHidden = usePhoneBannerHidden();
  // The summoned chat canvas is up: the banner would sit bright above its scrim.
  const hidden = useBannerHidden();

  if (hidden) return null;
  if (count === 0) return sent.length > 0 ? <AnswerSentBanner task={sent[0]} phoneHidden={phoneHidden} /> : null;

  const firstTask = tasks[0];
  // The sentence every page shows, not the raw "feat(scope): …" title.
  const firstName = taskHeading(firstTask, null).heading;
  const firstQuestion = firstTask.waitingFor?.prompt?.trim() || null;

  return (
    <div
      data-testid="global-needs-input-banner"
      className={`${phoneHidden ? 'hidden md:block ' : ''}bg-status-warning/10 border-b border-status-warning/20 px-4 py-2`}
    >
      <div className="flex items-center justify-center gap-2 text-sm">
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-status-warning opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-status-warning" />
        </span>
        <span className="min-w-0 truncate text-status-warning font-medium">
          {count === 1 ? (
            firstQuestion ? (
              // The question itself leads; the task it is about follows, quiet.
              <>
                <Link
                  href={needsInputTaskHref(firstTask)}
                  className="underline underline-offset-2 hover:text-status-warning/80"
                >
                  {firstQuestion}
                </Link>
                <span className="text-status-warning/70">{` · ${firstName}`}</span>
              </>
            ) : (
              <>
                <Link
                  href={needsInputTaskHref(firstTask)}
                  className="underline underline-offset-2 hover:text-status-warning/80"
                >
                  {firstName}
                </Link>
                {' '}is waiting for your answer
              </>
            )
          ) : (
            <>
              {count} questions for you
              {': '}
              <Link
                href={needsInputTaskHref(firstTask)}
                className="underline underline-offset-2 hover:text-status-warning/80"
              >
                {firstName}
              </Link>
              {count > 2 && (
                <span className="text-status-warning/70">
                  {' '}and {count - 1} more
                </span>
              )}
              {count === 2 && (
                <span className="text-status-warning/70">
                  {' '}and{' '}
                  <Link
                    href={needsInputTaskHref(tasks[1])}
                    className="underline underline-offset-2 hover:text-status-warning/80"
                  >
                    1 more
                  </Link>
                </span>
              )}
            </>
          )}
        </span>
        {alertPermission === 'default' && (
          <button
            type="button"
            onClick={enableAlerts}
            data-testid="needs-input-enable-alerts"
            className="text-xs text-status-warning/80 underline underline-offset-2 hover:text-status-warning"
          >
            Enable alerts
          </button>
        )}
      </div>
    </div>
  );
}

/** Quiet, no ping: nothing is asked of the person any more, the agent is next. */
function AnswerSentBanner({ task, phoneHidden }: { task: { id: string; title: string; missionId?: string | null }; phoneHidden: boolean }) {
  return (
    <div
      data-testid="global-answer-sent-banner"
      className={`${phoneHidden ? 'hidden md:block ' : ''}bg-surface-2 border-b border-border-default px-4 py-2`}
    >
      <div className="flex items-center justify-center gap-2 text-sm text-text-secondary">
        <span className="text-status-success" aria-hidden="true">✓</span>
        <span>
          <Link href={needsInputTaskHref(task)} className="underline underline-offset-2 hover:text-text-primary">
            {taskHeading(task, null).heading}
          </Link>
          {': Answer sent, waiting for the agent'}
        </span>
      </div>
    </div>
  );
}
