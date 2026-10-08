import { describe, test, expect } from 'bun:test';
import { execSync } from 'child_process';
import { DEFAULT_TOOLS, probeTool } from '../../src/env-scan';

const hasMergiraf = (() => {
  try { return !!execSync('command -v mergiraf', { stdio: 'pipe', shell: '/bin/sh' }).toString().trim(); } catch { return false; }
})();

describe('runner env check: tools', () => {
  test('mergiraf is among the probed tools', () => {
    expect(DEFAULT_TOOLS).toContain('mergiraf');
  });

  test('a missing tool is not reported', () => {
    expect(probeTool('buildd-no-such-tool-xyz')).toBeNull();
  });

  test('git is found through command -v, with its version', () => {
    expect(probeTool('git')).toMatchObject({ name: 'git', version: expect.stringMatching(/^\d+\.\d+/) });
  });

  test.skipIf(!hasMergiraf)('an installed mergiraf is reported with its version', () => {
    expect(probeTool('mergiraf')).toMatchObject({ name: 'mergiraf', version: expect.stringMatching(/^\d+\.\d+/) });
  });
});
