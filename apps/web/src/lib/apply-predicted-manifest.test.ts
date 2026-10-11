import { describe, it, expect, mock } from 'bun:test';
import { applyPredictedManifest, type PredictedManifestTask } from './apply-predicted-manifest';
import { MANIFEST_CANDIDATE_POLICY_VERSION, MANIFEST_DECISION_ID } from '@buildd/core/manifest-prediction';

const TASK = '00000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-09-10T00:00:00Z');

const pick = (path: string | null, confidence: number, applied = true) => ({
  step: 0, fingerprint: `fp-${path ?? 'done'}`, decisionVersion: 1, offered: [0], suggested: path ? 'c0' : 'DONE',
  path, confidence, status: applied ? 'applied' : 'suggested', reason: applied ? null : 'shadow', applied,
});

const row = (over: Record<string, unknown> = {}) => ({
  teamId: 't', workspaceId: 'w', taskId: TASK,
  decisionId: MANIFEST_DECISION_ID, promptVersion: 'p', candidatePolicyVersion: MANIFEST_CANDIDATE_POLICY_VERSION,
  mode: 'gated', taskCreatedAt: NOW, candidates: ['a.ts', 'b.ts'], candidateSources: {}, candidateCount: 2,
  candidateTruncated: false, candidateOmitted: 0, coverage: {},
  picks: [pick('a.ts', 0.95), pick(null, 0.97)], selected: ['a.ts'], stopReason: 'done',
  complete: true, unknownScope: false, allApplied: true, pickCap: 8, regexPaths: [], neighbourUnionPaths: [],
  setConfidence: 0.9, expectedSize: null, latencyMs: 10, ...over,
}) as any;

const task = (over: Partial<PredictedManifestTask> = {}): PredictedManifestTask => ({
  status: 'pending', pathManifest: ['**'], pathDeclaration: null, pathClaimRevision: 3, gitConfig: null, ...over,
});

function run(over: { task?: PredictedManifestTask | null; row?: any; threshold?: number; writeOk?: boolean } = {}) {
  const write = mock(async (_a: any) => over.writeOk ?? true);
  const p = applyPredictedManifest(
    { taskId: TASK, row: over.row ?? row(), threshold: over.threshold ?? 0.9 },
    { loadTask: async () => (over.task === undefined ? task() : over.task), write, now: () => NOW },
  );
  return { p, write };
}

describe('applyPredictedManifest', () => {
  it('a complete, applied, confident prediction becomes the scope, with provenance and the filer\'s declaration kept', async () => {
    const { p, write } = run();
    expect(await p).toEqual({ applied: true, manifest: ['a.ts'] });
    const args = (write.mock.calls[0] as any)[0];
    expect(args).toMatchObject({ taskId: TASK, revision: 3, pathManifest: ['a.ts'] });
    expect(args.pathDeclaration.declared).toEqual(['**']);
    expect(args.pathDeclaration.predicted).toMatchObject({ source: 'orchestration_manifest', decisionId: MANIFEST_DECISION_ID, threshold: 0.9, at: NOW.toISOString() });
  });

  it('adds namespace anchors from the workspace config', async () => {
    const gitConfig = { sequenceNamespaces: [{ dir: 'db/migrations', anchorFile: 'db/migrations/_journal.json' }] } as any;
    const { p } = run({ task: task({ gitConfig }), row: row({ selected: ['db/migrations/0001.sql'], picks: [pick('db/migrations/0001.sql', 0.95), pick(null, 0.95)] }) });
    expect(await p).toEqual({ applied: true, manifest: ['db/migrations/0001.sql', 'db/migrations/_journal.json'] });
  });

  it('leaves a claimed task alone', async () => {
    const { p, write } = run({ task: task({ status: 'assigned' }) });
    expect(await p).toEqual({ applied: false, reason: 'not_pending' });
    expect(write).not.toHaveBeenCalled();
  });

  it('never replaces a concrete scope the filer gave', async () => {
    const { p, write } = run({ task: task({ pathManifest: ['src/x.ts'] }) });
    expect(await p).toEqual({ applied: false, reason: 'caller_declared' });
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses an incomplete, unknown-coverage, unapplied or low-confidence prediction', async () => {
    expect(await run({ row: row({ complete: false }) }).p).toMatchObject({ applied: false, reason: 'incomplete' });
    expect(await run({ row: row({ unknownScope: true }) }).p).toMatchObject({ applied: false, reason: 'unknown_scope' });
    expect(await run({ row: row({ allApplied: false }) }).p).toMatchObject({ applied: false, reason: 'not_applied' });
    expect(await run({ row: row({ picks: [pick('a.ts', 0.6), pick(null, 0.95)] }) }).p).toMatchObject({ applied: false, reason: 'below_threshold' });
  });

  it('reports a lost compare-and-swap instead of claiming success', async () => {
    expect(await run({ writeOk: false }).p).toEqual({ applied: false, reason: 'changed_meanwhile' });
  });

  it('never throws', async () => {
    const r = await applyPredictedManifest({ taskId: TASK, row: row(), threshold: 0.9 }, { loadTask: async () => { throw new Error('db down'); } });
    expect(r).toEqual({ applied: false, reason: 'error' });
  });
});
