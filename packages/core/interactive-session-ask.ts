/**
 * A question with an option the platform cannot carry out: "pause and request
 * an interactive session where OAuth can be completed".
 *
 * Nothing in buildd acts on that choice — no task is reassigned, nobody is
 * notified — so the question would sit until it expires. Usually the premise
 * is false too: the agent hit a login wall on a third-party link (a claude.ai
 * Design or artifact URL) for something buildd already holds. Design and
 * artifact references are read with `get_artifact` (a presigned URL the
 * worker's own task token can fetch), `manage_designs list` and
 * `list_artifact_links`, never through the original link.
 * The gate and `ask_human` refuse such a question and say so.
 */
const SESSION_WORDS = /\b(?:request|open|start|wait(?:ing)?\s+for|need|switch\s+to|hand\s*(?:off|over)\s+to|pause\s+(?:and|until|for))\b[^.?!\n]{0,60}\b(?:interactive|local|human|manual|live)\s+(?:claude\s+)?(?:session|run|login)\b/i;
const OAUTH_WORDS = /\b(?:oauth|sign[- ]?in|log[- ]?in|login|authenticat\w*|authoriz\w*)\b[^.?!\n]{0,60}\b(?:can|could|may)\s+be\s+(?:completed|done|finished)\b/i;

/** Pure. True when any text offers or asks for an interactive session buildd cannot provide. */
export function detectInteractiveSessionAsk(...texts: Array<string | undefined>): boolean {
  const text = texts.filter(Boolean).join('\n');
  return SESSION_WORDS.test(text) || OAUTH_WORDS.test(text);
}

export const INTERACTIVE_SESSION_REFUSAL_REASON =
  'This offers an option buildd cannot carry out: nothing acts on "request an interactive session", so the task would wait with no one assigned. '
  + 'If you are blocked fetching a design, artifact or spec attachment behind a login (claude.ai, Figma, ...), do not use that link: '
  + 'buildd already holds it. Read it with get_artifact (presigned URL, readable with your own task token), manage_designs action=list, or list_artifact_links. '
  + 'If you need access to a provider, use request_capability. Otherwise pick the best option you can do now (for example, work from what you can see) and say so in your result.';

/** The structured refusal `ask_human` returns instead of parking. */
export function interactiveSessionRefusal() {
  return {
    error: 'interactive_session_unavailable',
    reason: INTERACTIVE_SESSION_REFUSAL_REASON,
    nextSteps: [
      'Call get_artifact / manage_designs list / list_artifact_links for the reference.',
      'For provider access, call request_capability.',
      'Otherwise continue with what you can do and note the limit in complete_task.',
    ],
  };
}
