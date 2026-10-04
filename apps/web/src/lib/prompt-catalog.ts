/**
 * Every prompt id the server resolves (`registerPrompt`, `@buildd/core/prompts`):
 * the core catalog plus the modules in apps/web that register their own.
 * Used by the deploy seed, the export of public defaults and the fallback
 * alert, so all three agree on the ids. `prompt-catalog.test.ts` fails when a
 * module that registers a prompt is missing from here.
 */
import '@buildd/core/prompt-catalog';
import './chat/instructions';
import './chat/routing';
import './chat-retro/lesson';
import './default-roles';
import './endpoint-model-suggest';
import './goal-criteria-quality-decision';
import './goal-criteria-rubric';
import './heartbeat-helpers';
import './heartbeat-triage';
import './mission-criteria-eval';
import './mission-criteria-worker-eval';
import './mission-prompts';
import './reviewer';
import './strand-choice-decision';
import './surface-audit-advice';
import './task-category-decision';
import './task-role-decision';
import { listRegisteredPrompts, type RegisteredPrompt } from '@buildd/core/prompts';

export function listPromptCatalog(): RegisteredPrompt[] {
  return listRegisteredPrompts();
}
