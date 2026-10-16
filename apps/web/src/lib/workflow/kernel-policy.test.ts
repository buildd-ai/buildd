/**
 * buildd's `Policy` adapter (kernel-policy.ts): the kill switch, the landing
 * lane and the conflict budget, read from the workspace row once per ask.
 */
import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { builddPolicy, policyFromGitConfig, workspacePolicySql } from './kernel-policy';
import type { Exec } from './kernel';

const render = (q: SQL) => new PgDialect().sqlToQuery(q);

describe('kernel policy', () => {
  test('one read of the workspace row, by id', () => {
    const { sql: text, params } = render(workspacePolicySql('w1'));
    expect(text).toContain('SELECT git_config FROM workspaces WHERE id = $1::uuid');
    expect(params).toEqual(['w1']);
  });

  test('the switch reads as authority.ts reads it: absent or true is on, anything else is off', () => {
    expect(policyFromGitConfig(null).kernelEnabled).toBe(true);
    expect(policyFromGitConfig({ workflowKernel: true }).kernelEnabled).toBe(true);
    expect(policyFromGitConfig({ workflowKernel: 'on' }).kernelEnabled).toBe(true);
    expect(policyFromGitConfig({ workflowKernel: false }).kernelEnabled).toBe(false);
    expect(policyFromGitConfig({ workflowKernel: 'no' }).kernelEnabled).toBe(false);
  });

  test('the landing lane and conflict budget come from the same row', () => {
    expect(policyFromGitConfig({ landingLane: 'enforce' }).landingLane).toBe('enforce');
    expect(policyFromGitConfig(null)).toMatchObject({ landingLane: 'off', maxRounds: 3, maxConflictIterations: 3 });
  });

  test('a workspace with no row reads as the defaults, kernel on', async () => {
    const none: Exec = async () => ({ rows: [] });
    expect((await builddPolicy(none).forWorkspace('w1')).kernelEnabled).toBe(true);
    const off: Exec = async () => ({ rows: [{ git_config: { workflowKernel: false } }] });
    expect((await builddPolicy(off).forWorkspace('w1')).kernelEnabled).toBe(false);
  });
});
