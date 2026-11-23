import { describe, expect, it } from 'bun:test';
import type { RunnerIsolationRecord } from '@buildd/shared';
import { isolationFixableByPolicy } from './connect-repo';

const none = { mechanism: 'none', scope: [], reason: 'opt_out' } as never;
const bwrap = { mechanism: 'bwrap', scope: ['write', 'network', 'env'] } as never;

const record = (claude: unknown, over: Partial<RunnerIsolationRecord> = {}): RunnerIsolationRecord => ({
  platform: 'linux-container',
  evidence: [],
  claude: claude as never,
  codex: { 'read-only': claude as never, 'workspace-write': claude as never },
  probeAt: '2026-10-17T00:00:01.000Z',
  processStartedAt: '2026-10-17T00:00:00.000Z',
  runnerVersion: '1.0.0',
  ...over,
});

describe('isolationFixableByPolicy (connect-repo)', () => {
  const shared = { workspacePolicy: undefined, accessMode: 'open', teamMemberCount: 3 };

  it('flags a protected workspace on a runner that cannot confine but opted in to reduced isolation', () => {
    expect(isolationFixableByPolicy({ ...shared, record: record(none, { reducedOptIn: true }) })).toBe(true);
  });

  it('says nothing when the runner confines', () => {
    expect(isolationFixableByPolicy({ ...shared, record: record(bwrap) })).toBe(false);
  });

  it('says nothing when the workspace is already trusted local', () => {
    expect(isolationFixableByPolicy({ ...shared, workspacePolicy: 'trusted_local', record: record(none, { reducedOptIn: true }) })).toBe(false);
  });

  it('says nothing when trusting the workspace would not help: the runner operator has not opted in', () => {
    expect(isolationFixableByPolicy({ ...shared, record: record(none) })).toBe(false);
  });

  it('says nothing for a lone-member team, which already resolves to trusted local, open or not', () => {
    expect(isolationFixableByPolicy({ ...shared, teamMemberCount: 1, record: record(none, { reducedOptIn: true }) })).toBe(false);
  });

  it('says nothing when the runner has reported no probe', () => {
    expect(isolationFixableByPolicy({ ...shared, record: null })).toBe(false);
  });
});
