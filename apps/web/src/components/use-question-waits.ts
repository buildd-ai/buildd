'use client';

/**
 * The projection's "what waits on this" for a task's open question (Living
 * Spec 1b257609), read on the client from GET /api/tasks/[id]/question-waits,
 * which runs `loadQuestionWaits`: the decision card on Home and the question
 * on the task page read it here, never from a list of their own. `initial`
 * (from a server read) skips the fetch. `key` refetches when the question
 * changes. A failed read leaves it null: the card shows the agent's own lines.
 */
import { useEffect, useState } from 'react';
import type { QuestionWaits } from '@buildd/core/question-waits';

export function useQuestionWaits(taskId: string | null | undefined, key: string, initial?: QuestionWaits | null): QuestionWaits | null {
  const [waits, setWaits] = useState<QuestionWaits | null>(initial ?? null);
  useEffect(() => {
    if (initial !== undefined || !taskId) return;
    let live = true;
    fetch(`/api/tasks/${encodeURIComponent(taskId)}/question-waits`, { credentials: 'include' })
      .then(r => (r.ok ? r.json() : null))
      .then((body: { waits?: QuestionWaits } | null) => { if (live) setWaits(body?.waits ?? null); })
      .catch(() => { if (live) setWaits(null); });
    return () => { live = false; };
  }, [taskId, key, initial]);
  return initial ?? waits;
}
