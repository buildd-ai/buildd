import { describe, expect, it } from 'bun:test';
import type { WorkspaceReleaseConfig } from '../db/schema';
import {
  candidatePatternError,
  classifyReleasePr,
  hasReleasePrShape,
  matchesCandidatePattern,
  parseReleaseCandidateMeta,
  releaseCandidateConfigError,
  releaseCandidatePolicy,
  releaseConstituentBase,
  type ReleasePrFacts,
} from '../release-candidate';
import { isReleaseBranchPr } from '../release-strategy';
// The engine that writes the metadata; pinned so the two can never drift.
import { renderCandidateBody, type CandidateMeta } from '../../../scripts/release-candidate';

const CANDIDATE_SHA = 'c'.repeat(40);
const SOURCE_SHA = 'a'.repeat(40);

const config: WorkspaceReleaseConfig = {
  enabled: true,
  strategy: 'workflow_dispatch',
  workflowFile: 'release.yml',
  ref: 'dev',
  prodBranch: 'main',
  candidate: { branches: ['release/v*'], sourceBranch: 'dev', authors: ['github-actions[bot]'] },
};

function meta(over: Partial<CandidateMeta> = {}): CandidateMeta {
  return {
    schema: 1,
    version: '1.2.3',
    branch: 'release/v1.2.3',
    sourceRef: 'dev',
    sourceSha: SOURCE_SHA,
    candidateSha: CANDIDATE_SHA,
    baseRef: 'main',
    baseSha: 'b'.repeat(40),
    previousTag: 'v1.2.2',
    bump: 'patch',
    amendment: 0,
    previousCandidateSha: null,
    supersedes: null,
    cutAt: '2026-10-01T00:00:00Z',
    ...over,
  };
}

function pr(over: Partial<ReleasePrFacts> = {}, m: CandidateMeta = meta()): ReleasePrFacts {
  return {
    headRef: 'release/v1.2.3',
    baseRef: 'main',
    headSha: CANDIDATE_SHA,
    author: 'github-actions[bot]',
    headRepoFullName: 'acme/app',
    baseRepoFullName: 'acme/app',
    body: renderCandidateBody(m, [{ sha: SOURCE_SHA, subject: 'feat: x (#10)' }], [], 'acme/app'),
    ...over,
  };
}

describe('parseReleaseCandidateMeta', () => {
  it('reads the metadata the release engine renders', () => {
    const parsed = parseReleaseCandidateMeta(pr().body);
    expect(parsed?.candidateSha).toBe(CANDIDATE_SHA);
    expect(parsed?.sourceRef).toBe('dev');
    expect(parsed?.version).toBe('1.2.3');
  });

  it('returns null for a body with no marker, bad JSON or another schema', () => {
    expect(parseReleaseCandidateMeta('Release v1.2.3')).toBeNull();
    expect(parseReleaseCandidateMeta('<!-- release-candidate {nope} -->')).toBeNull();
    expect(parseReleaseCandidateMeta(`<!-- release-candidate ${JSON.stringify({ ...meta(), schema: 2 })} -->`)).toBeNull();
    expect(parseReleaseCandidateMeta(`<!-- release-candidate ${JSON.stringify({ ...meta(), candidateSha: '' })} -->`)).toBeNull();
  });
});

describe('candidate branch patterns', () => {
  it('matches an exact ref or a path prefix ending in *', () => {
    expect(matchesCandidatePattern('release/v*', 'release/v1.2.3')).toBe(true);
    expect(matchesCandidatePattern('release/v*', 'release/v')).toBe(false);
    expect(matchesCandidatePattern('release/v*', 'releases/v1.2.3')).toBe(false);
    expect(matchesCandidatePattern('release/next', 'release/next')).toBe(true);
    expect(matchesCandidatePattern('release/next', 'release/next2')).toBe(false);
  });

  it('refuses patterns that could match ordinary branches', () => {
    expect(candidatePatternError('*')).not.toBeNull();
    expect(candidatePatternError('release*')).not.toBeNull();
    expect(candidatePatternError('release/*/v*')).not.toBeNull();
    expect(candidatePatternError('release/v*')).toBeNull();
    expect(matchesCandidatePattern('*', 'dev')).toBe(false);
  });
});

describe('releaseCandidatePolicy', () => {
  it('has no defaults: no candidate block, no policy', () => {
    const { candidate: _c, ...plain } = config;
    expect(releaseCandidatePolicy(plain)).toBeNull();
  });

  it('is off when releases are disabled, authors are empty, or a pattern would match trunk', () => {
    expect(releaseCandidatePolicy({ ...config, enabled: false })).toBeNull();
    expect(releaseCandidatePolicy({ ...config, candidate: { ...config.candidate!, authors: [] } })).toBeNull();
    expect(releaseCandidatePolicy({ ...config, candidate: { ...config.candidate!, branches: ['dev'] } })).toBeNull();
    expect(releaseCandidatePolicy({ ...config, candidate: { ...config.candidate!, sourceBranch: 'main' } })).toBeNull();
  });

  it('keeps workflow_dispatch ref as the dispatcher only: the source comes from candidate.sourceBranch', () => {
    const p = releaseCandidatePolicy({ ...config, ref: 'release-runner', candidate: { ...config.candidate!, sourceBranch: 'dev' } });
    expect(p?.sourceBranch).toBe('dev');
  });

  it('config validation names what is wrong', () => {
    expect(releaseCandidateConfigError(config)).toBeNull();
    expect(releaseCandidateConfigError({ ...config, candidate: { ...config.candidate!, branches: ['*'] } })).toMatch(/branches/);
    expect(releaseCandidateConfigError({ ...config, candidate: { ...config.candidate!, authors: [' '] } })).toMatch(/authors/);
    expect(releaseCandidateConfigError({ ...config, prodBranch: undefined })).toMatch(/prodBranch/);
  });
});

describe('classifyReleasePr', () => {
  it('recognises a trusted release/v1.2.3 → main candidate', () => {
    const cls = classifyReleasePr(config, pr());
    expect(cls.kind).toBe('candidate');
    if (cls.kind !== 'candidate') return;
    expect(cls.version).toBe('1.2.3');
    expect(cls.meta.sourceSha).toBe(SOURCE_SHA);
    // Constituents merged into dev, not into the candidate branch.
    expect(releaseConstituentBase(cls)).toBe('dev');
  });

  it('keeps the old dev → main release PR working (releaseBranch, no metadata needed)', () => {
    const legacy: WorkspaceReleaseConfig = { enabled: true, strategy: 'branch_merge', prodBranch: 'main', releaseBranch: 'dev' };
    const cls = classifyReleasePr(legacy, { headRef: 'dev', baseRef: 'main' });
    expect(cls.kind).toBe('legacy');
    expect(releaseConstituentBase(cls)).toBe('dev');
    expect(isReleaseBranchPr(legacy, { headRef: 'dev', baseRef: 'main' })).toBe(true);
  });

  it('does not treat a candidate branch as the legacy release PR', () => {
    expect(isReleaseBranchPr(config, { headRef: 'release/v1.2.3', baseRef: 'main' })).toBe(false);
  });

  it('rejects a spoofed candidate opened by someone other than the release workflow', () => {
    expect(classifyReleasePr(config, pr({ author: 'mallory' }))).toEqual({ kind: 'none', reason: 'author_not_trusted' });
    expect(classifyReleasePr(config, pr({ author: null }))).toEqual({ kind: 'none', reason: 'author_not_trusted' });
  });

  it('rejects a candidate-shaped PR from a fork', () => {
    expect(classifyReleasePr(config, pr({ headRepoFullName: 'mallory/app' }))).toEqual({ kind: 'none', reason: 'cross_repository' });
  });

  it('rejects a candidate with no metadata, or metadata for another branch/base/source', () => {
    expect(classifyReleasePr(config, pr({ body: 'Release v1.2.3' }))).toEqual({ kind: 'none', reason: 'metadata_missing' });
    expect(classifyReleasePr(config, pr({}, meta({ branch: 'release/v9.9.9' })))).toEqual({ kind: 'none', reason: 'metadata_mismatch' });
    expect(classifyReleasePr(config, pr({}, meta({ sourceRef: 'feature' })))).toEqual({ kind: 'none', reason: 'metadata_mismatch' });
    expect(classifyReleasePr(config, pr({}, meta({ baseRef: 'staging' })))).toEqual({ kind: 'none', reason: 'metadata_mismatch' });
  });

  it('invalidates a candidate whose head moved off the recorded candidate SHA', () => {
    expect(classifyReleasePr(config, pr({ headSha: 'd'.repeat(40) }))).toEqual({ kind: 'none', reason: 'candidate_sha_moved' });
    expect(classifyReleasePr(config, pr({ headSha: null }))).toEqual({ kind: 'none', reason: 'candidate_sha_moved' });
  });

  it('accepts an explicit amendment, which rewrites the metadata to the new head', () => {
    const amended = meta({ candidateSha: 'e'.repeat(40), amendment: 1, previousCandidateSha: CANDIDATE_SHA });
    expect(classifyReleasePr(config, pr({ headSha: 'e'.repeat(40) }, amended)).kind).toBe('candidate');
  });

  it('never treats an arbitrary PR into main as a release', () => {
    expect(classifyReleasePr(config, pr({ headRef: 'feature/x' }))).toEqual({ kind: 'none', reason: 'not_release_shape' });
    expect(classifyReleasePr(config, pr({ baseRef: 'dev' }))).toEqual({ kind: 'none', reason: 'not_release_shape' });
    expect(classifyReleasePr(config, pr({ headRef: 'dev' }))).toEqual({ kind: 'none', reason: 'not_release_shape' });
  });
});

describe('hasReleasePrShape', () => {
  it('matches refs only, for harmless uses', () => {
    expect(hasReleasePrShape(config, { headRef: 'release/v2.0.0', baseRef: 'main' })).toBe(true);
    expect(hasReleasePrShape(config, { headRef: 'release/v2.0.0', baseRef: 'dev' })).toBe(false);
    expect(hasReleasePrShape(config, { headRef: 'dev', baseRef: 'main' })).toBe(false);
  });
});
