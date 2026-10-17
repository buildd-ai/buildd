import { describe, expect, it } from 'bun:test';
import { readIsolationRecord } from '@buildd/shared';

const none = { mechanism: 'none', scope: [], reason: 'bwrap_missing' };
const record = {
  platform: 'linux',
  evidence: ['process.platform=linux'],
  claude: none,
  codex: { 'read-only': none, 'workspace-write': none },
  probeAt: '2026-10-17T00:00:01.000Z',
  processStartedAt: '2026-10-17T00:00:00.000Z',
  runnerVersion: '1.0.0',
};

describe('readIsolationRecord', () => {
  it('returns the record a runner sent in environment.isolation', () => {
    expect(readIsolationRecord({ isolation: record })).toEqual(record as never);
  });

  it('is null for runner builds that send no record', () => {
    expect(readIsolationRecord(null)).toBeNull();
    expect(readIsolationRecord({})).toBeNull();
    expect(readIsolationRecord({ envKeys: [] })).toBeNull();
  });

  it('is null for a record whose shape Health would crash on', () => {
    expect(readIsolationRecord({ isolation: 'bwrap' })).toBeNull();
    expect(readIsolationRecord({ isolation: { ...record, claude: null } })).toBeNull();
    expect(readIsolationRecord({ isolation: { ...record, claude: { scope: [] } } })).toBeNull();
    expect(readIsolationRecord({ isolation: { ...record, codex: undefined } })).toBeNull();
    expect(readIsolationRecord({ isolation: { ...record, platform: 7 } })).toBeNull();
    expect(readIsolationRecord({ isolation: { ...record, probeAt: undefined } })).toBeNull();
  });
});
