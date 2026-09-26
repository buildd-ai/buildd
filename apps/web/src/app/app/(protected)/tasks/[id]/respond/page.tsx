import { db } from '@buildd/core/db';
import { tasks, workers, missionNotes } from '@buildd/core/db/schema';
import { eq, desc, and, asc } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import RespondForm from './RespondForm';
import { respondBackLink } from './respond-links';
import { taskPageHref } from '@/lib/mission-task-href';
import { linkQuestionNote, unifyWorkerQuestion } from '../question-hero';
import { findTaskRole } from '../role-lookup';
import { taskHeading } from '../task-header';
import type { WorkerWaitingFor } from '@buildd/core/db/schema';

// Focused landing page for the "Agent needs your input" push notification.
// Renders the question + options with no extra chrome, so the user can answer
// in one tap. Falls through to the full task page if there's nothing to answer.
export default async function RespondPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, id),
    with: {
      workspace: { columns: { id: true, name: true, teamId: true } },
      mission: { columns: { id: true, title: true } },
    },
  });
  if (!task) notFound();

  const access = await verifyWorkspaceAccess(user.id, task.workspaceId);
  if (!access) notFound();

  // Find the most recent worker that still has an unanswered question.
  // Status-agnostic on purpose — inputAsRetry leaves the worker in error.
  const taskWorkers = await db.query.workers.findMany({
    where: eq(workers.taskId, id),
    orderBy: desc(workers.createdAt),
  });
  const pending = taskWorkers.find(w => w.waitingFor);

  // Nothing to answer — bounce to the full task page so the user sees state.
  if (!pending) redirect(taskPageHref({ taskId: id, missionId: task.missionId }));

  const waitingFor = pending.waitingFor as WorkerWaitingFor;

  // The same ask may also be a question note: one question, one surface.
  const [openNotes, role] = await Promise.all([
    db
      .select({
        id: missionNotes.id,
        workerId: missionNotes.workerId,
        type: missionNotes.type,
        status: missionNotes.status,
        title: missionNotes.title,
        body: missionNotes.body,
        defaultChoice: missionNotes.defaultChoice,
      })
      .from(missionNotes)
      .where(and(eq(missionNotes.taskId, id), eq(missionNotes.type, 'question'), eq(missionNotes.status, 'open')))
      .orderBy(asc(missionNotes.createdAt)),
    findTaskRole({ workspaceId: task.workspaceId, teamId: (task.workspace as any)?.teamId, slug: task.roleSlug }),
  ]);
  const question = unifyWorkerQuestion(waitingFor, linkQuestionNote(openNotes, pending.id));
  const heading = taskHeading({ title: task.title, label: (task as { label?: string | null }).label ?? null }, null);
  const asker = `The ${(role?.name || 'agent').toLowerCase()} asks`;

  // A mission task returns to its row on the mission; the back link names the
  // mission, not the workspace (docs/design/mission-feed-mobile-continuity.md W6).
  const back = respondBackLink({ taskId: id, mission: task.mission, workspaceName: task.workspace.name });

  return (
    <div className="min-h-screen bg-surface-1 py-8 px-4 sm:px-6">
      <div className="max-w-2xl mx-auto">
        <Link
          href={back.href}
          data-testid="respond-back-link"
          className="font-mono text-[11px] md:text-[10px] uppercase tracking-[2.5px] text-text-muted hover:text-text-primary"
        >
          ← {back.label}
        </Link>

        <h1 className="mt-3 text-[20px] font-semibold text-text-primary leading-snug">
          {heading.eyebrow.length > 0 && (
            <span className="mr-2 font-mono text-[11px] uppercase tracking-[2px] text-text-muted align-middle">{heading.eyebrow.join(' · ')}</span>
          )}
          {heading.heading}
        </h1>

        <div className="mt-6">
          <RespondForm workerId={pending.id} taskId={id} missionId={task.missionId} question={question} askerLabel={asker} />
        </div>

        <div className="mt-6 text-center">
          <Link
            href={taskPageHref({ taskId: id, missionId: task.missionId })}
            className="text-sm text-text-muted hover:text-text-primary"
          >
            View full task →
          </Link>
        </div>
      </div>
    </div>
  );
}
