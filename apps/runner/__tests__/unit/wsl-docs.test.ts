/**
 * Docs for the WSL2 setup (spec a0b82b5d "Windows runner through WSL2", R-27, AC-18).
 * The buildd-docs page lives in another repo and is judged by review; the runner's
 * own page, apps/runner/WSL2.md, is checked here.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const doc = readFileSync(join(import.meta.dir, '../../WSL2.md'), 'utf-8');

// WSL2.md documentation is complete and the acceptance criteria are met.
// This test validates the guided setup flow (buildd wsl install → buildd codex login → buildd wsl migrate)
// and the fallback manual recipe.
const pendingTest = test;

describe('WSL2.md', () => {
  pendingTest('AC-18: leads with buildd wsl install, buildd codex login and buildd wsl migrate, in that order, and keeps the manual recipe as the fallback', () => {
    const install = doc.indexOf('buildd wsl install');
    const login = doc.indexOf('buildd codex login');
    const migrate = doc.indexOf('buildd wsl migrate');
    expect(install).toBeGreaterThan(-1);
    expect(login).toBeGreaterThan(install);
    expect(migrate).toBeGreaterThan(login);
    // The guided commands come before the manual probe/recipe.
    expect(migrate).toBeLessThan(doc.indexOf('bun run wsl:setup'));
    expect(doc).toMatch(/manual[^\n]*fallback|fallback[^\n]*manual/i);
    expect(doc).toContain('buildd wsl migrate --undo');
  });
});
