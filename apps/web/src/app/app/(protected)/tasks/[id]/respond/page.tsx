import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { eq, desc } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import RespondForm from './RespondForm';

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
    with: { workspace: { columns: { id: true, name: true } } },
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
  if (!pending) redirect(`/app/tasks/${id}`);

  const waitingFor = pending.waitingFor as {
    type: string;
    prompt: string;
    options?: Array<string | { label: string; description?: string; recommended?: boolean }>;
  };

  return (
    <div className="min-h-screen bg-surface-1 py-8 px-4 sm:px-6">
      <div className="max-w-xl mx-auto">
        <Link
          href={`/app/tasks/${id}`}
          className="font-mono text-[10px] uppercase tracking-[2.5px] text-text-muted hover:text-text-primary"
        >
          ← {task.workspace.name}
        </Link>

        <h1 className="mt-2 text-xl font-semibold text-text-primary leading-tight">
          {task.title}
        </h1>

        <div className="mt-6 border border-status-warning/30 bg-status-warning/5 rounded-lg p-5">
          <div className="flex items-center gap-2 mb-3">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-status-warning opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-status-warning" />
            </span>
            <span className="font-mono text-[10px] font-medium text-status-warning uppercase tracking-[2.5px]">
              Needs input
            </span>
          </div>

          <p className="text-[15px] text-text-primary leading-relaxed whitespace-pre-wrap">
            {waitingFor.prompt}
          </p>

          <RespondForm workerId={pending.id} options={waitingFor.options || []} />
        </div>

        <div className="mt-6 text-center">
          <Link
            href={`/app/tasks/${id}`}
            className="text-sm text-text-muted hover:text-text-primary"
          >
            View full task →
          </Link>
        </div>
      </div>
    </div>
  );
}
