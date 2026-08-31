import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as modelAliases from '../model-aliases';

const SOURCE = readFileSync(join(import.meta.dir, '../model-aliases.ts'), 'utf8');

/**
 * The alias module used to ship two resolvers with no reachable callers
 * (`resolveModelName` — only ever called by the equally-unreachable
 * task-classifier — and `resolveModelNameSync` — zero callers) plus docstrings
 * claiming the runner refreshed the cache, which it never did. These tests pin
 * the surface that actually has callers and keep the docs honest.
 */
describe('model-aliases surface', () => {
  it('keeps the exports that have real callers', () => {
    // POST /api/admin/refresh-model-aliases
    expect(typeof modelAliases.updateModelAliases).toBe('function');
    expect(modelAliases.DEFAULT_ALIASES.haiku).toBeTruthy();
    // apps/runner thinking guard
    expect(typeof modelAliases.requiresThinkingEnabled).toBe('function');
    expect(typeof modelAliases.resolveEffectiveThinking).toBe('function');
  });

  it('no longer exports the unreachable alias resolvers', () => {
    expect((modelAliases as Record<string, unknown>).resolveModelName).toBeUndefined();
    expect((modelAliases as Record<string, unknown>).resolveModelNameSync).toBeUndefined();
  });

  it('does not claim the runner or workers populate the alias cache', () => {
    expect(SOURCE).not.toContain('populated by runner');
    expect(SOURCE).not.toContain('Called by the runner');
    expect(SOURCE).not.toContain('refreshed\n * automatically by workers');
  });
});
