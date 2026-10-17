import { describe, it, expect } from 'bun:test';

import { isolationProblem } from '@/lib/runner-isolation-health';
import { RUNNER_ISOLATION_ROWS } from './runner-isolation-fixtures';

// The fixture the visual capture shoots must show what R-9 asks for, row by row.
describe('runner isolation fixture matrix', () => {
  for (const { runner, inProblems } of RUNNER_ISOLATION_ROWS) {
    it(`${runner.accountName}: ${inProblems ? 'in Problems' : 'runner detail only'}`, () => {
      expect(isolationProblem(runner, { protectedWorkPending: true }) !== null).toBe(inProblems);
    });
  }
});
