import { describe, it, expect } from 'bun:test';
import {
  docsOnlyUpstream,
  zeroManifestOverlap,
  terminalApproveGreenCi,
  evaluateEarlyReleaseRules,
  type ReviewVerdictGateInput,
} from './early-release-rules';

function reviewStatus(over: Partial<ReviewVerdictGateInput> = {}): ReviewVerdictGateInput {
  return {
    state: 'approved',
    merged: false,
    reviewTaskId: 'review-task',
    reviewHeadSha: 'a'.repeat(40),
    feedback: null,
    summary: null,
    escalationReason: null,
    reviewEquivalentHeadShas: [],
    ...over,
  };
}

describe('docsOnlyUpstream', () => {
  it('fires when every changed path is a nested docs/**/*.md file', () => {
    const verdict = docsOnlyUpstream(['docs/design/foo.md', 'docs/specs/bar.md']);
    expect(verdict).toEqual({ decision: 'start_now', reasonCode: 'docs_only' });
  });

  it('fires on a root-level *.md file', () => {
    expect(docsOnlyUpstream(['README.md'])).toEqual({ decision: 'start_now', reasonCode: 'docs_only' });
  });

  it('returns null when any changed path is not a doc path', () => {
    expect(docsOnlyUpstream(['docs/design/foo.md', 'apps/web/src/lib/foo.ts'])).toBeNull();
  });

  it('returns null for a nested non-docs markdown-looking directory', () => {
    expect(docsOnlyUpstream(['apps/web/README.md'])).toBeNull();
  });

  it('returns null on an empty changed-files list', () => {
    expect(docsOnlyUpstream([])).toBeNull();
  });
});

describe('zeroManifestOverlap', () => {
  it('fires when a concrete manifest shares no path with the upstream diff', () => {
    const verdict = zeroManifestOverlap(['apps/web/src/lib/a.ts'], ['apps/web/src/lib/b.ts']);
    expect(verdict).toEqual({ decision: 'start_now', reasonCode: 'zero_overlap' });
  });

  it('returns null when the manifest overlaps the upstream diff', () => {
    expect(zeroManifestOverlap(['apps/web/src/lib/a.ts'], ['apps/web/src/lib/a.ts'])).toBeNull();
  });

  it('returns null when the manifest overlaps via a directory prefix', () => {
    expect(zeroManifestOverlap(['apps/web/src/lib'], ['apps/web/src/lib/a.ts'])).toBeNull();
  });

  it('returns null for an empty manifest', () => {
    expect(zeroManifestOverlap([], ['apps/web/src/lib/b.ts'])).toBeNull();
  });

  it('returns null for a null manifest', () => {
    expect(zeroManifestOverlap(null, ['apps/web/src/lib/b.ts'])).toBeNull();
  });

  it('returns null for the repo-wide sentinel manifest', () => {
    expect(zeroManifestOverlap(['**'], ['apps/web/src/lib/b.ts'])).toBeNull();
  });

  it('returns null for a monorepo-root-wide manifest entry', () => {
    expect(zeroManifestOverlap(['apps/**'], ['apps/web/src/lib/b.ts'])).toBeNull();
  });
});

describe('terminalApproveGreenCi', () => {
  it('fires on a terminal approve at the current head with green checks', () => {
    const verdict = terminalApproveGreenCi(reviewStatus(), 'a'.repeat(40), true);
    expect(verdict).toEqual({ decision: 'start_now', reasonCode: 'terminal_approve' });
  });

  it('returns null when checks are not green', () => {
    expect(terminalApproveGreenCi(reviewStatus(), 'a'.repeat(40), false)).toBeNull();
  });

  it('returns null when the review state is not approved', () => {
    expect(terminalApproveGreenCi(reviewStatus({ state: 'reviewing' }), 'a'.repeat(40), true)).toBeNull();
  });

  it('returns null when the approval is stale against a later head', () => {
    const status = reviewStatus({ reviewHeadSha: 'a'.repeat(40) });
    expect(terminalApproveGreenCi(status, 'b'.repeat(40), true)).toBeNull();
  });

  it('fires when a later head is recorded as review-equivalent to the approved one', () => {
    const status = reviewStatus({ reviewHeadSha: 'a'.repeat(40), reviewEquivalentHeadShas: ['b'.repeat(40)] });
    expect(terminalApproveGreenCi(status, 'b'.repeat(40), true)).toEqual({
      decision: 'start_now',
      reasonCode: 'terminal_approve',
    });
  });
});

describe('evaluateEarlyReleaseRules', () => {
  it('returns null when no rule fires', () => {
    const result = evaluateEarlyReleaseRules({
      upstreamChangedFiles: ['apps/web/src/lib/b.ts'],
      dependentPathManifest: ['apps/web/src/lib/b.ts'],
      reviewStatus: reviewStatus({ state: 'reviewing' }),
      currentHeadSha: 'a'.repeat(40),
      requiredChecksGreen: false,
    });
    expect(result).toBeNull();
  });

  it('prefers docs_only over the other rules when the upstream diff is docs-only', () => {
    const result = evaluateEarlyReleaseRules({
      upstreamChangedFiles: ['docs/design/foo.md'],
      dependentPathManifest: ['docs/design/foo.md'],
      reviewStatus: reviewStatus({ state: 'reviewing' }),
      currentHeadSha: 'a'.repeat(40),
      requiredChecksGreen: false,
    });
    expect(result).toEqual({ decision: 'start_now', reasonCode: 'docs_only' });
  });

  it('falls through to zero_overlap when the upstream diff is not docs-only', () => {
    const result = evaluateEarlyReleaseRules({
      upstreamChangedFiles: ['apps/web/src/lib/a.ts'],
      dependentPathManifest: ['apps/web/src/lib/b.ts'],
      reviewStatus: reviewStatus({ state: 'reviewing' }),
      currentHeadSha: 'a'.repeat(40),
      requiredChecksGreen: false,
    });
    expect(result).toEqual({ decision: 'start_now', reasonCode: 'zero_overlap' });
  });

  it('falls through to terminal_approve when neither of the first two rules fires', () => {
    const result = evaluateEarlyReleaseRules({
      upstreamChangedFiles: ['apps/web/src/lib/a.ts'],
      dependentPathManifest: ['apps/web/src/lib/a.ts'],
      reviewStatus: reviewStatus(),
      currentHeadSha: 'a'.repeat(40),
      requiredChecksGreen: true,
    });
    expect(result).toEqual({ decision: 'start_now', reasonCode: 'terminal_approve' });
  });
});
