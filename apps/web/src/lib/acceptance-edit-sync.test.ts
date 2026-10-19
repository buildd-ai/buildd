import { describe, expect, it } from 'bun:test';
import { syncAcceptanceEdit, type AcceptanceEditDeps } from './acceptance-edit-sync';
import type { AcceptanceEditFlag } from '@buildd/spec-contract/acceptance-edit';

function harness(opts: { role?: string | null; files?: string[]; context?: unknown; missionId?: string | null }) {
  const log = { saved: [] as Array<AcceptanceEditFlag | null>, notes: [] as string[], comments: [] as string[] };
  const deps: AcceptanceEditDeps = {
    taskOfPr: async () => ({ id: 't1', missionId: opts.missionId === undefined ? 'm1' : opts.missionId, roleSlug: opts.role === undefined ? 'builder' : opts.role, context: opts.context ?? {} }),
    changedFiles: async () => opts.files ?? [],
    saveFlag: async (_t, f) => { log.saved.push(f); },
    missionNote: async (_m, _t, title) => { log.notes.push(title); },
    prComment: async (b) => { log.comments.push(b); },
    now: () => '2026-10-19T00:00:00Z',
  };
  return { deps, log };
}
const input = { prNumber: 7, headSha: 'abc1234' };

describe('syncAcceptanceEdit', () => {
  it('flags a builder PR that edits an acceptance test on the PR and the mission page', async () => {
    const { deps, log } = harness({ files: ['apps/web/tests/x-acceptance.test.ts', 'a.ts'] });
    expect(await syncAcceptanceEdit(input, deps)).toBe('flagged');
    expect(log.saved[0]?.paths).toEqual(['apps/web/tests/x-acceptance.test.ts']);
    expect(log.notes).toHaveLength(1);
    expect(log.comments[0]).toContain('x-acceptance.test.ts');
  });

  it('does not repeat the flag for a path already flagged', async () => {
    const { deps, log } = harness({ files: ['x-acceptance.test.ts'], context: { acceptanceEdit: { paths: ['x-acceptance.test.ts'], headSha: 'old', flaggedAt: 't', acceptedPaths: [] } } });
    expect(await syncAcceptanceEdit(input, deps)).toBe('unchanged');
    expect(log.notes).toHaveLength(0);
    expect(log.comments).toHaveLength(0);
  });

  it('leaves non-builder tasks alone', async () => {
    const { deps, log } = harness({ role: 'organizer', files: ['x-acceptance.test.ts'] });
    expect(await syncAcceptanceEdit(input, deps)).toBe('not_building');
    expect(log.saved).toHaveLength(0);
  });

  it('clears the flag once the PR stops editing acceptance tests', async () => {
    const { deps, log } = harness({ files: ['a.ts'], context: { acceptanceEdit: { paths: ['x-acceptance.test.ts'], headSha: 'old', flaggedAt: 't', acceptedPaths: [] } } });
    expect(await syncAcceptanceEdit(input, deps)).toBe('cleared');
    expect(log.saved).toEqual([null]);
  });

  it('keeps the flag when the file list cannot be read', async () => {
    const { deps, log } = harness({});
    deps.changedFiles = async () => { throw new Error('boom'); };
    expect(await syncAcceptanceEdit(input, deps)).toBe('read_failed');
    expect(log.saved).toHaveLength(0);
  });
});
