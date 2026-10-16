/**
 * The checks list from its JSON-safe section (lib/task-sections.ts
 * `taskDeliverySections`), so the task page and the mission sheet render it
 * from the same props.
 */
import TaskChecks from '@/app/app/(protected)/tasks/[id]/TaskChecks';
import type { TaskChecksSection as Section } from '@/lib/task-sections';

export default function TaskChecksSection({ section, currentTaskId }: { section: Section; currentTaskId: string }) {
  return (
    <TaskChecks
      checks={section.checks}
      prNumber={section.prNumber}
      prUrl={section.prUrl}
      headSha={section.headSha}
      findings={new Map(Object.entries(section.findings))}
      findingsUnavailable={section.findingsUnavailable}
      currentTaskId={currentTaskId}
    />
  );
}
