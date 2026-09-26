/**
 * Answer a waiting agent: the one path the respond page and the chat feed's
 * question card share. Posts to `/api/workers/[id]/respond` (which resumes or
 * continues the session) and marks the same ask's question note answered.
 */
export interface SubmitAnswerInput {
  workerId: string;
  taskId: string;
  noteId: string | null;
  message: string;
}

export interface SubmitAnswerResult {
  /** Where the work now is: the same task on a resume, a new one on a cold continuation. */
  taskId: string | null;
  message: string | null;
}

export async function submitAnswer(
  { workerId, taskId, noteId, message }: SubmitAnswerInput,
  fetchImpl: typeof fetch = fetch,
): Promise<SubmitAnswerResult> {
  const res = await fetchImpl(`/api/workers/${workerId}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  const data = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'Failed to send answer');
  if (noteId) {
    await fetchImpl(`/api/tasks/${taskId}/notes/${noteId}/reply`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: message }),
    }).catch(() => {});
  }
  return {
    taskId: typeof data?.taskId === 'string' ? data.taskId : null,
    message: typeof data?.message === 'string' ? data.message : null,
  };
}
