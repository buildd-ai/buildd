/**
 * Does this AskUserQuestion tool input actually ask anything?
 *
 * Agents have been seen calling AskUserQuestion with an empty `questions`
 * array as a way to "yield" while their own background work (a background
 * Bash run, an Explore subagent) finishes. Treating that as a real question
 * parks the task on a blank "Awaiting input", aborts the session (killing the
 * background work it was waiting for) and notifies the owner about nothing.
 * Both the PreToolUse hook and the message handler gate on this.
 */
export function asksAQuestion(input: unknown): boolean {
  const questions = (input as { questions?: unknown } | null | undefined)?.questions;
  if (!Array.isArray(questions)) return false;
  return questions.some(
    (q) => typeof (q as { question?: unknown })?.question === 'string'
      && ((q as { question: string }).question.trim().length > 0),
  );
}

export const EMPTY_QUESTION_DENY_REASON =
  'AskUserQuestion needs at least one non-empty question — this call asked nothing, so it was not sent to the user. ' +
  'If you are waiting on your own background work (a background Bash command or a subagent), do not yield with AskUserQuestion: ' +
  'that would end the session and kill the background work. Instead poll it (read its output file, or run a bounded ' +
  '`sleep` then check again) and continue once it finishes.';
