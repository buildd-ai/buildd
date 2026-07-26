import { describe, expect, it } from 'bun:test';
import type { TaskSubjectAnchor } from '@buildd/shared';
import {
  DEFAULT_SUBJECT_POLICY,
  projectBackfilledSubjectAnchor,
  projectSubjectAnchor,
  resolveSubjectPolicy,
  subjectMatchPredicate,
  wouldBeSubjectOutcome,
} from '../subject-anchor-observe';

const fullSha = 'a'.repeat(40);

describe('subject anchor observe rollout', () => {
  it('resolves the safe tenant defaults', () => {
    expect(resolveSubjectPolicy()).toEqual(DEFAULT_SUBJECT_POLICY);
    expect(resolveSubjectPolicy({ mode: 'propose', proposalGraceHours: 48 })).toEqual({
      ...DEFAULT_SUBJECT_POLICY,
      mode: 'propose',
      proposalGraceHours: 48,
    });
  });

  it('projects the immutable anchor into indexed task columns', () => {
    const anchor: TaskSubjectAnchor = {
      version: 1,
      kind: 'pull_request',
      prNumber: 42,
      headSha: fullSha,
      branch: 'buildd/fix-ci',
      failingCheckNames: ['build', 'test'],
      source: 'system',
      confidence: 'exact',
    };

    expect(projectSubjectAnchor(anchor)).toEqual({
      subjectAnchor: anchor,
      subjectKind: 'pull_request',
      subjectPrNumber: 42,
      subjectHeadSha: fullSha,
      subjectBranch: 'buildd/fix-ci',
      subjectErrorSignature: null,
      subjectMissionId: null,
      subjectDedupeScope: 'active',
    });
  });

  it('uses generation matches for full SHAs and suggestion-only lineage for short SHAs', () => {
    expect(subjectMatchPredicate({
      version: 1,
      kind: 'pull_request',
      prNumber: 42,
      headSha: fullSha,
      source: 'system',
      confidence: 'exact',
    })).toEqual({ kind: 'pr_generation', prNumber: 42, headSha: fullSha });

    expect(subjectMatchPredicate({
      version: 1,
      kind: 'pull_request',
      prNumber: 42,
      headSha: 'abcdef0',
      source: 'context',
      confidence: 'derived',
    })).toEqual({ kind: 'pr_lineage', prNumber: 42 });

    expect(subjectMatchPredicate({
      version: 1,
      kind: 'pull_request',
      prNumber: 42,
      headSha: 'b'.repeat(64),
      source: 'system',
      confidence: 'exact',
    })).toMatchObject({ kind: 'pr_generation', prNumber: 42 });
  });

  it('matches errors by signature and explicit mission scope', () => {
    expect(subjectMatchPredicate({
      version: 1,
      kind: 'error',
      errorSignature: 'bwrap_namespace_denied',
      subjectMissionId: '11111111-1111-4111-8111-111111111111',
      source: 'system',
      confidence: 'exact',
    })).toEqual({
      kind: 'error',
      errorSignature: 'bwrap_namespace_denied',
      subjectMissionId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('reports suggestions for human origins and attachments for system origins', () => {
    expect(wouldBeSubjectOutcome('dashboard', DEFAULT_SUBJECT_POLICY)).toBe('suggest');
    expect(wouldBeSubjectOutcome('api', DEFAULT_SUBJECT_POLICY)).toBe('suggest');
    expect(wouldBeSubjectOutcome('mcp', DEFAULT_SUBJECT_POLICY)).toBe('attach');
    expect(wouldBeSubjectOutcome('organizer', DEFAULT_SUBJECT_POLICY)).toBe('attach');
    expect(wouldBeSubjectOutcome('watcher', DEFAULT_SUBJECT_POLICY)).toBe('attach');
    expect(wouldBeSubjectOutcome('webhook', DEFAULT_SUBJECT_POLICY)).toBe('attach');
  });

  it('requires confirmation for historic human PR URLs and disables terminal dedupe', () => {
    const urlAnchor: TaskSubjectAnchor = {
      version: 1,
      kind: 'pull_request',
      prNumber: 1473,
      source: 'url',
      confidence: 'derived',
    };
    expect(projectBackfilledSubjectAnchor(urlAnchor, {
      terminal: false,
      historicHumanProse: true,
    })).toMatchObject({
      subjectAnchor: { source: 'backfill', confidence: 'derived' },
      subjectDedupeScope: 'none',
      requiresConfirmation: true,
      reason: 'exact_same_repo_pr_url',
    });
    expect(projectBackfilledSubjectAnchor(urlAnchor, {
      terminal: true,
      historicHumanProse: false,
    }).subjectDedupeScope).toBe('none');
  });
});
