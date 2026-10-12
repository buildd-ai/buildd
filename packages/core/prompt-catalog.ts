/**
 * Every `@buildd/core` module that registers a prompt id (`registerPrompt` in
 * `prompts.ts`), imported for that side effect, so `listRegisteredPrompts()`
 * after importing this file names every core prompt. apps/web adds its own in
 * `apps/web/src/lib/prompt-catalog.ts`.
 *
 * A new prompt-bearing module must be imported here (or in the web catalog);
 * `apps/web/src/lib/prompt-catalog.test.ts` fails otherwise.
 */
import './memory-decisions';
import './orchestration-claim-decision';
import './orchestration-overlap-decision';
import './question-gate-decision';
import './escalation-gate-decision';
import './task-size-bucket-decision';
import './decision-kind-post-session-triage';
import './decision-kind-scout-probe-selection';
import './decision-kind-failure-incident-triage';
import './manifest-prediction';

export { listRegisteredPrompts, type RegisteredPrompt } from './prompts';
