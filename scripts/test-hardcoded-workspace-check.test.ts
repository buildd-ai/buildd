/**
 * Guard test that fails if any runner unit test files contain hardcoded
 * `/tmp/test-workspace` paths.
 *
 * This prevents regression where tests might revert to using the shared
 * directory, which causes test interference in parallel CI runs.
 *
 * Run: bun test scripts/test-hardcoded-workspace-check.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

describe('test workspace path safety', () => {
  test('no runner unit test files use hardcoded /tmp/test-workspace', () => {
    const testDir = 'apps/runner/__tests__/unit';
    const files = readdirSync(testDir)
      .filter(f => f.endsWith('.test.ts'))
      .map(f => join(testDir, f));

    const violations: string[] = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      // Look for the hardcoded path - should use getTestWorkspace() instead
      if (/'\/tmp\/test-workspace'/.test(content) ||
          /"\/tmp\/test-workspace"/.test(content)) {
        violations.push(file);
      }
    }

    if (violations.length > 0) {
      const message = `${violations.length} test file(s) contain hardcoded '/tmp/test-workspace' paths:\n` +
        violations.map(v => `  - ${v}`).join('\n') +
        '\n\nThese paths cause test interference in parallel CI runs. ' +
        'Use initTestWorkspace() and getTestWorkspace() instead.';
      throw new Error(message);
    }

    expect(violations.length).toBe(0);
  });

  test('runner unit test files import test-workspace helpers', () => {
    const testDir = 'apps/runner/__tests__/unit';
    const files = readdirSync(testDir)
      .filter(f => f.endsWith('.test.ts'))
      .map(f => join(testDir, f));

    const missingImports: string[] = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      // Skip files that don't use the workspace resolver (unlikely but possible)
      if (!content.includes('createWorkspaceResolver')) {
        continue;
      }

      if (!content.includes('from \'../test-workspace\'')) {
        missingImports.push(file);
      }
    }

    if (missingImports.length > 0) {
      const message = `${missingImports.length} test file(s) don't import test-workspace helpers:\n` +
        missingImports.map(v => `  - ${v}`).join('\n') +
        '\n\nAdd: import { initTestWorkspace, getTestWorkspace, cleanupTestWorkspace } from \'../test-workspace\';';
      throw new Error(message);
    }

    expect(missingImports.length).toBe(0);
  });

  test('runner unit test files call cleanupTestWorkspace', () => {
    const testDir = 'apps/runner/__tests__/unit';
    const files = readdirSync(testDir)
      .filter(f => f.endsWith('.test.ts'))
      .map(f => join(testDir, f));

    const missingCleanup: string[] = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      // Skip files that don't use the workspace resolver
      if (!content.includes('createWorkspaceResolver')) {
        continue;
      }

      if (!content.includes('cleanupTestWorkspace()')) {
        missingCleanup.push(file);
      }
    }

    if (missingCleanup.length > 0) {
      const message = `${missingCleanup.length} test file(s) don't call cleanupTestWorkspace():\n` +
        missingCleanup.map(v => `  - ${v}`).join('\n') +
        '\n\nAdd to describe block afterAll: afterAll(() => { cleanupTestWorkspace(); });';
      throw new Error(message);
    }

    expect(missingCleanup.length).toBe(0);
  });
});
