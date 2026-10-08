import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listRegisteredPrompts } from '@buildd/core/prompts';
import { listPromptCatalog } from './prompt-catalog';

const ROOT = join(import.meta.dir, '../../../..');

// The modules that define the registering helpers themselves; they register no id of their own.
const HELPERS = new Set(['packages/core/prompts.ts', 'packages/core/prompted-decision.ts', 'packages/core/decision-kinds.ts']);

const RESOLVE = /(^|[^.\w])(resolvePrompt|resolvePromptEntry|resolvePromptTemplate|resolvePromptTemplateEntry|resolvePromptValue|resolvePromptValueEntry|promptedQuestions|activePrompt)\(/m;
const REGISTER = /(^|[^.\w])(definePromptedDecision|defineBuilddDecisionKind|promptedDecisionKind|registerPrompt|registerTextPrompt|registerTemplatePrompt|registerValuePrompt|registerPromptedQuestions)\(/m;
const CALL = new RegExp(`${RESOLVE.source}|${REGISTER.source}`, 'm');

/** A module that resolves ids another module registers (it imports the ids and defaults from there). */
const REGISTERED_ELSEWHERE: Record<string, string> = {
  'apps/web/src/lib/mission-context.ts': 'apps/web/src/lib/mission-prompts.ts',
  // The eval's benchmark sets resolve the ids their decision modules register
  // (task-category-decision, heartbeat-triage, task-role-decision); one stands in.
  'apps/web/src/lib/prompt-evals/benchmark-sets.ts': 'apps/web/src/lib/task-category-decision.ts',
};
const IMPORTS_PROMPTS = /from ['"](@buildd\/core\/(prompts|prompted-decision|decision-kinds)|\.\/(prompts|prompted-decision|decision-kinds))['"]/;

/** Every source file that resolves or registers a prompt id. */
function promptBearingFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '*.ts'], { cwd: ROOT, encoding: 'utf8' });
  return out
    .split('\n')
    .filter(f => f && !f.endsWith('.test.ts') && !f.includes('__tests__/') && !HELPERS.has(f))
    .filter(f => {
      const src = readFileSync(join(ROOT, f), 'utf8');
      return CALL.test(src) && IMPORTS_PROMPTS.test(src);
    });
}

describe('prompt catalog', () => {
  it('every module that resolves a prompt registers it (or names the module that does)', () => {
    const unregistered = promptBearingFiles().filter(f => {
      const src = readFileSync(join(ROOT, f), 'utf8');
      if (!RESOLVE.test(src) || REGISTER.test(src)) return false;
      const owner = REGISTERED_ELSEWHERE[f];
      return !(owner && REGISTER.test(readFileSync(join(ROOT, owner), 'utf8')));
    });
    expect(unregistered).toEqual([]);
  });

  it('every registered public default passes its own check', () => {
    const bad = listPromptCatalog()
      .map(p => [p.id, p.validate(p.publicDefault)] as const)
      .filter(([, why]) => why !== null);
    expect(bad).toEqual([]);
  });

  it('names the chat prompt and the core decisions', () => {
    const ids = listPromptCatalog().map(p => p.id);
    expect(ids).toContain('buildd.chat_instructions');
    expect(ids).toContain('buildd.question_gate');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is complete: importing every prompt-bearing module registers no id the catalog lacks', async () => {
    const before = new Set(listPromptCatalog().map(p => p.id));
    const files = promptBearingFiles();
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) await import(join(ROOT, f));
    const missing = listRegisteredPrompts()
      .map(p => p.id)
      .filter(id => !before.has(id));
    expect(missing).toEqual([]);
  });
});
