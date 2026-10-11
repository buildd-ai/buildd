import { describe, test, expect } from 'bun:test';
import { GATE_SLUGS } from '@buildd/core/gate-slugs';
import { derivedMergeGateEvent } from './derived-merge-gate';

const ctx = { workspaceId: 'ws', missionId: null, taskId: 'task', workerId: 'worker' };

describe('derivedMergeGateEvent', () => {
  test('a completed retry the runner finished is an accepted base_refresh row', () => {
    const event = derivedMergeGateEvent('completed', {
      baseRef: 'origin/dev',
      regenerated: ['bun install'],
      verification: 'bun run test',
      headSha: 'abc123',
    }, ctx);
    expect(event).toEqual({
      gate: GATE_SLUGS.BASE_REFRESH,
      surface: 'runner derived-file merge',
      outcome: 'accepted',
      reason: 'conflict_retry_finished_without_agent',
      workspaceId: 'ws',
      missionId: null,
      taskId: 'task',
      workerId: 'worker',
      callerOrigin: 'worker',
      detail: {
        stage: 'derived_merge',
        baseRef: 'origin/dev',
        regenerated: ['bun install'],
        verification: 'bun run test',
        headSha: 'abc123',
      },
    });
  });

  test('nothing for any other status, or a missing or malformed report', () => {
    const report = { baseRef: 'origin/dev', regenerated: [], verification: null };
    expect(derivedMergeGateEvent('failed', report, ctx)).toBeNull();
    expect(derivedMergeGateEvent('completed', undefined, ctx)).toBeNull();
    expect(derivedMergeGateEvent('completed', 'yes', ctx)).toBeNull();
    expect(derivedMergeGateEvent('completed', { regenerated: [] }, ctx)).toBeNull();
  });

  test('drops non-string commands and bounds the list', () => {
    const event = derivedMergeGateEvent('completed', {
      baseRef: 'origin/dev',
      regenerated: ['a', 3, null, ...Array.from({ length: 30 }, (_, i) => `cmd ${i}`)],
      verification: 7,
    }, ctx);
    const detail = event?.detail as { regenerated: string[]; verification: string | null; headSha: string | null };
    expect(detail.regenerated[0]).toBe('a');
    expect(detail.regenerated.length).toBe(20);
    expect(detail.verification).toBeNull();
    expect(detail.headSha).toBeNull();
  });
});
