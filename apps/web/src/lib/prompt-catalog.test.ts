import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listRegisteredPrompts } from '@buildd/core/prompts';
import { listPromptCatalog } from './prompt-catalog';

const ROOT = join(import.meta.dir, '../../../..');

// The modules that define the registering helpers themselves; they register no id of their own.
const HELPERS = new Set(['packages/core/prompts.ts', 'packages/core/prompted-decision.ts', 'packages/core/decision-kinds.ts']);

const CALL = /(^|[^.\w])(definePromptedDecision|defineBuilddDecisionKind|promptedDecisionKind|resolvePrompt|resolvePromptEntry|activePrompt|registerPrompt)\(/m;
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
