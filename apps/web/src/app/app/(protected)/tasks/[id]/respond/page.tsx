import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { loadQuestionContext } from '@/lib/chat-objects/load-question-object';
import RespondForm from './RespondForm';
import RespondHeading from './RespondHeading';
import { respondBackLink } from './respond-links';
import { taskPageHref } from '@/lib/mission-task-href';
import { taskHeading } from '../task-header';
import { getChatAvailability } from '@/lib/chat-availability';
import { ownConversationForMission, questionFocusHref } from '@/lib/chat/conversations';

// Focused landing page for the "Agent needs your input" push notification.
// Renders the question + options with no extra chrome, so the user can answer
// in one tap. Falls through to the full task page if there's nothing to answer.
// The question comes from the same loader the chat feed's question card reads
// (lib/chat-objects/load-question-object.ts), so both show one question alike.
export default async function RespondPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  // Null for a missing task or one outside the user's workspaces.
  const ctx = await loadQuestionContext(id, user.id);
  if (!ctx) notFound();
  const { task, view } = ctx;

  // Nothing to answer — bounce to the full task page so the user sees state.
  if (!view.open || !view.workerId) redirect(taskPageHref({ taskId: id, missionId: task.missionId }));

  // The question folds into the chat (docs/design/agent-chat.md, "The respond
  // page folds in"): when this mission was filed from the reader's own
  // conversation and chat is on for them, the deep link opens that
  // conversation with the question card in focus. Otherwise, this page.
  if (task.missionId) {
    const conversationId = await ownConversationForMission(task.missionId, user.id).catch(() => null);
    if (conversationId && (await getChatAvailability(user.id, task.teamId ?? null)).available) {
      redirect(questionFocusHref(conversationId, { workerId: view.workerId, taskId: id }));
    }
  }

  const heading = taskHeading({ title: task.title, label: task.label }, null);

  // A mission task returns to its row on the mission; the back link names the
  // mission, not the workspace (docs/design/mission-feed-mobile-continuity.md W6).
  const back = respondBackLink({ taskId: id, mission: task.mission, workspaceName: task.workspaceName });

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

        <RespondHeading eyebrow={heading.eyebrow} heading={heading.heading} />

        <div className="mt-6">
          <RespondForm workerId={view.workerId} taskId={id} missionId={task.missionId} question={view.question} askerLabel={view.askerLabel} />
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
