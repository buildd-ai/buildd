import { describe, expect, it } from 'bun:test';
import { listPromptCatalog } from '../prompt-catalog';
import { CHAT_INSTRUCTIONS_PROMPT_ID } from '../chat/instructions';
import { CHAT_ROUTING_PROMPT_ID, TITLE_TOPIC_PROMPT_ID } from '../chat/routing';
import { CHAT_RETRO_PROMPT_ID } from '../chat-retro/lesson';
import { STRAND_CHOICE_PROMPT_ID } from '../strand-choice-decision';
import { SURFACE_AUDIT_ADVICE_PROMPT_ID } from '../surface-audit-advice';
import { GOAL_QUALITY_PROMPT_ID } from '../goal-criteria-quality-decision';
import { ENDPOINT_MODEL_SUGGEST_PROMPT_ID } from '../endpoint-model-suggest';
import { TASK_CATEGORY_PROMPT_ID } from '../task-category-decision';
import { TASK_ROLE_PROMPT_ID } from '../task-role-decision';
import { CHAT_PROMPT_IDS, DECISION_PROMPT_IDS, promptSurface } from './surfaces';

describe('promptSurface', () => {
  it('the literal ids are the modules\' own constants', () => {
    expect([...CHAT_PROMPT_IDS]).toEqual([CHAT_INSTRUCTIONS_PROMPT_ID]);
    expect([...DECISION_PROMPT_IDS].sort()).toEqual([
      CHAT_ROUTING_PROMPT_ID,
      TITLE_TOPIC_PROMPT_ID,
      CHAT_RETRO_PROMPT_ID,
      STRAND_CHOICE_PROMPT_ID,
      SURFACE_AUDIT_ADVICE_PROMPT_ID,
      GOAL_QUALITY_PROMPT_ID,
      ENDPOINT_MODEL_SUGGEST_PROMPT_ID,
    ].sort());
  });

  it('every listed id is a registered prompt', () => {
    const ids = new Set(listPromptCatalog().map(p => p.id));
    for (const id of [...CHAT_PROMPT_IDS, ...DECISION_PROMPT_IDS]) expect(ids.has(id)).toBe(true);
  });

  it('a benchmarked prompt is a decision prompt (every set calls decisionCall)', () => {
    for (const id of [TASK_CATEGORY_PROMPT_ID, TASK_ROLE_PROMPT_ID]) expect(promptSurface(id)).toBe('decision');
  });

  it('the chat system prompt is a chat prompt; agent-side text is neither', () => {
    expect(promptSurface(CHAT_INSTRUCTIONS_PROMPT_ID)).toBe('chat');
    expect(promptSurface(CHAT_ROUTING_PROMPT_ID)).toBe('decision');
    expect(promptSurface('buildd.role.builder')).toBe('other');
  });
});
