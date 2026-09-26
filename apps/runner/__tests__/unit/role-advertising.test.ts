import { describe, expect, test } from 'bun:test';
import type { WorkerEnvironment } from '@buildd/shared';
import { advertisedRoleSlugs } from '../../src/role-advertising';

function env(envKeys: string[]): WorkerEnvironment {
  return { tools: [], envKeys, mcp: [] } as unknown as WorkerEnvironment;
}

describe('advertisedRoleSlugs', () => {
  test("advertises 'visual-auditor' when env-scan found a browser", () => {
    expect(advertisedRoleSlugs(env(['GITHUB_TOKEN', 'browser']))).toEqual(['visual-auditor']);
  });

  test('advertises nothing (legacy claim-anything) without a browser', () => {
    // An empty list would still be sent as "no availableSkills", but undefined
    // keeps the request body byte-identical to today's runner.
    expect(advertisedRoleSlugs(env(['GITHUB_TOKEN']))).toBeUndefined();
  });

  test('advertises nothing before the first env scan', () => {
    expect(advertisedRoleSlugs(undefined)).toBeUndefined();
  });
});
