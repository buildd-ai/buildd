import { beforeEach, describe, expect, it, mock } from 'bun:test';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const selection = { type: 'living_spec' as const, specId: 'spec', specRevisionId: 'revision', revision: 1, contentHash: 'approved-hash' };
const mission = { id: 'mission', workspaceId: 'workspace', workingBranch: 'mission/x', integrationBranchEnabled: true, goalCriteria: [selection] };
let pinnedBody = 'approved body';
let readOk = true;
let rows: unknown[] = [];
let writes: any[] = [];
let inspectedBodies: string[] = [];
const chain = () => {
  // Awaited straight after where(): the mission's tasks, none with unaccepted acceptance edits.
  const query = { from: () => query, where: () => Object.assign(Promise.resolve([]), query), orderBy: async () => rows };
  return query;
};
mock.module('@buildd/core/db', () => ({ db: {
  query: { missions: { findFirst: async () => mission },
    workspaces: { findFirst: async () => ({ githubRepoId: 'repo', gitConfig: {} }) },
    githubRepos: { findFirst: async () => ({ fullName: 'example/repo', defaultBranch: 'dev', installation: { installationId: 1 } }) } },
  select: chain,
  insert: () => ({ values: (value: unknown) => { writes.push(value); return { returning: async () => [{ id: 'verdict' }] }; } }),
} }));
mock.module('@/lib/github', () => ({ githubApi: async () => null }));
mock.module('@/lib/mission-repo-workspace', () => ({ resolveMissionRepoWorkspaceId: async () => ({ workspaceId: 'workspace' }) }));
mock.module('./mission-integration-target', () => ({ integrationTarget: async () => ({ kind: 'integration', headSha: HEAD, branch: 'mission/x' }) }));
mock.module('./selected-scope', () => ({ livingSpecCriteriaOf: () => [selection], selectedScope: async () => ({ ok: true, criteria: [{ id: 'R-1', text: 'Clear cards' }], title: 'UI policy' }) }));
mock.module('./pin', () => ({ readPinnedSpecRevision: async (pin: unknown) => {
  expect(pin).toMatchObject({ specId: 'spec', specRevisionId: 'revision', contentHash: 'approved-hash' });
  return readOk ? { ok: true, body: pinnedBody } : { ok: false, reason: 'missing approved body' };
} }));
const actualBindings = { ...(await import('@buildd/spec-contract/verification-bindings')) };
mock.module('@buildd/spec-contract/verification-bindings', () => ({ ...actualBindings, criterionVerifications: (body: string) => {
  inspectedBodies.push(body);
  return [{ criterionId: 'R-1', binding: { id: body === 'action body' ? 'ui.actions_match_state' : 'ui.card_clarity', version: 1, profile: 'buildd.enterprise@1', mode: 'required' }, fingerprint: body === 'approved body' ? 'approved-binding' : body === 'action body' ? 'action-binding' : 'replacement-binding' }];
} }));
mock.module('./criteria', () => ({ revisionCriterionHashes: async () => new Map([['R-1', 'wording-hash']]) }));
mock.module('./store', () => ({ fail: (status: number, error: string) => ({ ok: false, status, error }), reach: async () => true }));
mock.module('./verdict-source', () => ({ settleVerdictSource: async () => {} }));
const { readMissionSpecStanding, recordMissionVerdictServer } = await import('./mission-outcome');

const evidenceRow = (fingerprint: string, headSha = HEAD) => ({ id: 'verdict', criterionId: 'R-1', verdict: 'pass', headSha,
  at: '2026-10-21T12:00:00Z', textHash: 'wording-hash', evidence: { recordedBy: 'registered:ui.card_clarity', bindingFingerprint: fingerprint } });
const input = (evidence: Record<string, unknown> = { bindingFingerprint: 'approved-binding' }) => ({ specRevisionId: 'revision', criterionId: 'R-1', verdict: 'pass' as const, headSha: HEAD, recordedBy: 'registered:ui.card_clarity', evidence: { method: 'model', ...evidence } });

beforeEach(() => { pinnedBody = 'approved body'; readOk = true; rows = []; writes = []; inspectedBodies = []; });

describe('mission registered evidence authority', () => {
  it('AC-4: folds required bindings from the pinned body with current evidence, retaining model review source', async () => {
    rows = [evidenceRow('approved-binding')];
    const result = await readMissionSpecStanding(mission, selection as never);
    expect(result.verdict).toBe('pass');
    expect(result.standings[0].source).toBe('review');
    expect(inspectedBodies).toContain('approved body');
  });

  it('AC-4: changing the approved binding does not reuse an older fingerprint', async () => {
    pinnedBody = 'replacement body'; rows = [evidenceRow('approved-binding')];
    expect((await readMissionSpecStanding(mission, selection as never)).verdict).toBe('UNVERIFIED');
  });

  it('refuses registered server evidence without the approved matching fingerprint', async () => {
    for (const fingerprint of [undefined, 'old-binding', 42]) {
      const result = await recordMissionVerdictServer('mission', input({ ...(fingerprint === undefined ? {} : { bindingFingerprint: fingerprint }) }));
      expect(result.ok).toBe(false);
    }
    expect(writes).toEqual([]);
  });

  it('accepts matching registered evidence and preserves the server model author', async () => {
    expect((await recordMissionVerdictServer('mission', input())).ok).toBe(true);
    expect(writes[0].evidence).toMatchObject({ bindingFingerprint: 'approved-binding', recordedBy: 'registered:ui.card_clarity' });
  });

  it('refuses mismatched verifier authors and unreserved authors claiming registered fingerprints', async () => {
    for (const recordedBy of ['registered:ui.actions_match_state', 'check:registered:ui.actions_match_state', 'check:command-task', 'visual-audit']) {
      expect((await recordMissionVerdictServer('mission', { ...input(), recordedBy })).ok).toBe(false);
    }
    expect((await recordMissionVerdictServer('mission', { ...input({}), recordedBy: 'check:registered:ui.card_clarity' })).ok).toBe(false);
    expect(writes).toEqual([]);
  });

  it('never stamps model/fallback evidence as a test or treats clarity judgement as deterministic', async () => {
    for (const method of ['model', 'fallback', 'deterministic', undefined]) {
      expect((await recordMissionVerdictServer('mission', { ...input({ bindingFingerprint: 'approved-binding', method }), recordedBy: 'check:registered:ui.card_clarity' })).ok).toBe(false);
    }
    pinnedBody = 'action body';
    // A deterministic registered result is a review too (its method is kept); the old test-source author is refused for new rows.
    expect((await recordMissionVerdictServer('mission', { ...input({ bindingFingerprint: 'action-binding', method: 'deterministic' }), recordedBy: 'check:registered:ui.actions_match_state' })).ok).toBe(false);
    expect((await recordMissionVerdictServer('mission', { ...input({ bindingFingerprint: 'action-binding', method: 'deterministic' }), recordedBy: 'registered:ui.actions_match_state' })).ok).toBe(true);
    expect(writes).toHaveLength(1);
  });

  it('refuses a missing immutable body and old target without inserting evidence', async () => {
    readOk = false;
    expect((await recordMissionVerdictServer('mission', input())).ok).toBe(false);
    readOk = true;
    expect((await recordMissionVerdictServer('mission', { ...input(), headSha: OLD })).ok).toBe(false);
    expect(writes).toEqual([]);
  });

  it('preserves server command and visual evidence without a new binding', async () => {
    expect((await recordMissionVerdictServer('mission', { ...input({}), recordedBy: 'check:command-task' })).ok).toBe(true);
    expect((await recordMissionVerdictServer('mission', { ...input({}), recordedBy: 'visual-audit' })).ok).toBe(true);
  });
});
