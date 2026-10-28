import { describe, expect, it } from 'bun:test';
import { syncAcceptanceEdit, type AcceptanceEditDeps } from './acceptance-edit-sync';
import type { AcceptanceEditFlag } from '@buildd/spec-contract/acceptance-edit';

const src = (body: string) => `it('queues', () => {\n${body}\n});\n`;

function harness(opts: { role?: string | null; files?: string[]; context?: unknown; missionId?: string | null; sources?: Record<string, { before: string | null; after: string | null }>; off?: boolean }) {
  const log = { saved: [] as Array<AcceptanceEditFlag | null>, notes: [] as string[], comments: [] as string[] };
  const deps: AcceptanceEditDeps = {
    taskOfPr: async () => ({ id: 't1', missionId: opts.missionId === undefined ? 'm1' : opts.missionId, roleSlug: opts.role === undefined ? 'builder' : opts.role, context: opts.context ?? {} }),
    changedFiles: async () => opts.files ?? [],
    saveFlag: async (_t, f) => { log.saved.push(f); },
    missionNote: async (_m, _t, title) => { log.notes.push(title); },
    prComment: async (b) => { log.comments.push(b); },
    now: () => '2026-10-19T00:00:00Z',
    ...(opts.sources ? { readSources: async (p: string) => opts.sources![p] ?? { before: null, after: null } } : {}),
    ...(opts.off ? { strictnessOn: async () => false } : {}),
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

  describe('strictness check', () => {
    const P = 'x-acceptance.test.ts';
    const files = [P];

    it('accepts a stricter edit itself, records the check as the one that accepted it, and stays quiet', async () => {
      const { deps, log } = harness({ files, sources: { [P]: { before: src('expect(a).toBe(1);'), after: src('expect(a).toBe(1);\nexpect(b).toBe(2);') } } });
      expect(await syncAcceptanceEdit(input, deps)).toBe('auto_accepted');
      const flag = log.saved[0]!;
      expect(flag.acceptedPaths).toEqual([P]);
      expect(flag.acceptedBy).toBe('check:acceptance-edit-strictness');
      expect(flag.checks?.[0]).toMatchObject({ path: P, verdict: 'stricter', autoAccepted: true, headSha: 'abc1234' });
      expect(log.notes).toHaveLength(0);
      expect(log.comments).toHaveLength(0);
    });

    it('accepts an equivalent edit', async () => {
      const { deps, log } = harness({ files, sources: { [P]: { before: src('expect(a).toBe(1);'), after: src('// note\nexpect( a ).toBe(1);') } } });
      expect(await syncAcceptanceEdit(input, deps)).toBe('auto_accepted');
      expect(log.saved[0]!.checks?.[0]?.verdict).toBe('equivalent');
    });

    it('holds a loosened edit and says which check got weaker', async () => {
      const { deps, log } = harness({ files, sources: { [P]: { before: src('expect(res.status).toBe(200);'), after: src('expect(res.status).toBeDefined();') } } });
      expect(await syncAcceptanceEdit(input, deps)).toBe('flagged');
      const flag = log.saved[0]!;
      expect(flag.acceptedPaths).toEqual([]);
      expect(flag.checks?.[0]).toMatchObject({ verdict: 'loosened', autoAccepted: false });
      expect(flag.checks?.[0]?.weakened[0]).toContain('res.status');
      expect(log.comments[0]).toContain('res.status');
    });

    it('holds an edit it cannot read', async () => {
      const { deps, log } = harness({ files, sources: { [P]: { before: src('expect(a).toBe(1);'), after: "it('x', () => {" } } });
      expect(await syncAcceptanceEdit(input, deps)).toBe('flagged');
      expect(log.saved[0]!.checks?.[0]).toMatchObject({ verdict: 'unparseable', autoAccepted: false });
    });

    it('holds everything when the sources cannot be read', async () => {
      const { deps, log } = harness({ files, sources: {} });
      deps.readSources = async () => { throw new Error('boom'); };
      expect(await syncAcceptanceEdit(input, deps)).toBe('flagged');
      expect(log.saved[0]!.acceptedPaths).toEqual([]);
    });

    it('holds a stricter edit when the workspace turned the check off', async () => {
      const { deps, log } = harness({ files, off: true, sources: { [P]: { before: src('expect(a).toBe(1);'), after: src('expect(a).toBe(1);\nexpect(b).toBe(2);') } } });
      expect(await syncAcceptanceEdit(input, deps)).toBe('flagged');
      expect(log.saved[0]!.checks).toBeUndefined();
    });

    it('checks again on a new head: an earlier automatic accept does not carry over', async () => {
      const prior = { paths: [P], headSha: 'old', flaggedAt: 't', acceptedPaths: [P], acceptedBy: 'check:acceptance-edit-strictness', checks: [{ path: P, verdict: 'stricter', headSha: 'old', autoAccepted: true, weakened: [], stricter: [] }] };
      const { deps, log } = harness({ files, context: { acceptanceEdit: prior }, sources: {} });
      deps.readSources = async () => ({ before: src('expect(a).toBe(1);'), after: src('expect(a).toContain(1);') });
      expect(await syncAcceptanceEdit(input, deps)).toBe('flagged');
      expect(log.saved[0]!.acceptedPaths).toEqual([]);
    });
  });
});
