import { describe, expect, it } from 'bun:test';
import { isUnitTestFile } from './run-unit-tests';

describe('isUnitTestFile', () => {
  it('includes the three unit-suite roots', () => {
    expect(isUnitTestFile('apps/web/src/lib/team-access.test.ts')).toBe(true);
    expect(isUnitTestFile('apps/runner/__tests__/unit/workers.test.ts')).toBe(true);
    expect(isUnitTestFile('packages/core/__tests__/knowledge-store.test.ts')).toBe(true);
  });

  it('excludes integration and e2e tests', () => {
    expect(isUnitTestFile('apps/web/tests/integration/tasks.test.ts')).toBe(false);
    expect(isUnitTestFile('tests/e2e/dashboard.test.ts')).toBe(false);
  });
});
