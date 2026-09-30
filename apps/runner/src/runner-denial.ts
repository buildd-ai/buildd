/**
 * Wording for every tool call the runner itself refuses.
 *
 * A denial reaches the agent as the tool result, and the agent reads it as if
 * it came from the person it is working for. Claude Code's own fallback text
 * for a refused or cancelled call is "The user doesn't want to take this
 * action right now. STOP what you are doing and wait for the user to tell you
 * how to proceed." An autonomous worker that sees that stops, says "I've
 * stopped, as you asked", never calls complete_task, and is failed for
 * shipping nothing, although nobody declined anything.
 *
 * So every runner-side denial says three things: the runner refused this,
 * not a person; only this one call is refused; and the task continues (with
 * an alternative when there is one). `runnerDenial` is the only way hook
 * code builds a deny reason. runner-denials.test.ts enforces that.
 */

/** Present in every runner denial. The test suite keys on it. */
export const RUNNER_DENIAL_MARKER = 'Refused by the buildd runner\'s automatic policy, not by a person';

const CONTINUE =
  'Only this one call was refused. Nobody asked you to stop, and there is no one to wait for. ' +
  'Carry on with the task without this call and finish it as normal, including complete_task.';

/**
 * @param what        what was refused and why, e.g. "writes to .env files are blocked".
 * @param alternative what to do instead, when there is a clear substitute.
 */
export function runnerDenial(what: string, alternative?: string): string {
  const body = what.trim().replace(/[.\s]+$/, '');
  const instead = alternative?.trim() ? ` Instead: ${alternative.trim().replace(/[.\s]+$/, '')}.` : '';
  return `${RUNNER_DENIAL_MARKER}: ${body}.${instead} ${CONTINUE}`;
}

/**
 * Deny reason for a call a person refused from the runner UI. That is a real
 * human decision, but it refuses one call, not the task, so say that too.
 */
export const HUMAN_UI_DENIAL =
  'A person watching this run in the buildd runner UI denied this one tool call. ' +
  'That refuses this call only. It is not an instruction to stop the task. ' +
  'Continue without it (use another approach if one exists) and finish the task as normal, including complete_task.';
