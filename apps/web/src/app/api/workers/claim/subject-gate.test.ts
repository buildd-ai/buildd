import { describe, it, expect } from 'bun:test';

// We mock drizzle-orm and schema so that subjectLivenessCondition() is testable
// purely as a SQL fragment builder without a real DB.
import { subjectStillLive } from './subject-gate';

// ─── subjectStillLive unit tests ─────────────────────────────────────────────

describe('subjectStillLive', () => {
  it('returns true for tasks with no subject anchor (backwards compat)', () => {
    expect(subjectStillLive({ subjectKind: null, subjectPrNumber: null, subjectResolution: null })).toBe(true);
    expect(subjectStillLive({ subjectKind: undefined, subjectPrNumber: undefined, subjectResolution: undefined })).toBe(true);
    expect(subjectStillLive({})).toBe(true);
  });

  it('returns true when subject kind is not pull_request', () => {
    expect(subjectStillLive({ subjectKind: 'error', subjectPrNumber: null, subjectResolution: null })).toBe(true);
    expect(subjectStillLive({ subjectKind: 'mission', subjectPrNumber: null, subjectResolution: null })).toBe(true);
    expect(subjectStillLive({ subjectKind: 'branch', subjectPrNumber: null, subjectResolution: null })).toBe(true);
  });

  it('returns true for pull_request subject with no PR number', () => {
    expect(subjectStillLive({ subjectKind: 'pull_request', subjectPrNumber: null, subjectResolution: null })).toBe(true);
  });

  it('returns true for pull_request with PR number and no resolution (live)', () => {
    expect(subjectStillLive({ subjectKind: 'pull_request', subjectPrNumber: 42, subjectResolution: null })).toBe(true);
  });

  it('returns true for pull_request with PR number and attached resolution (still live)', () => {
    expect(subjectStillLive({ subjectKind: 'pull_request', subjectPrNumber: 42, subjectResolution: 'attached' })).toBe(true);
  });

  it('returns true for pull_request with superseded resolution', () => {
    expect(subjectStillLive({ subjectKind: 'pull_request', subjectPrNumber: 42, subjectResolution: 'superseded' })).toBe(true);
  });

  it('returns true for pull_request with filed_anyway resolution', () => {
    expect(subjectStillLive({ subjectKind: 'pull_request', subjectPrNumber: 42, subjectResolution: 'filed_anyway' })).toBe(true);
  });

  it('returns false when subject is pull_request with prNumber and reconciled resolution (dead PR)', () => {
    expect(subjectStillLive({
      subjectKind: 'pull_request',
      subjectPrNumber: 42,
      subjectResolution: 'reconciled',
    })).toBe(false);
  });

  it('returns false for reconciled PR regardless of PR number value', () => {
    expect(subjectStillLive({
      subjectKind: 'pull_request',
      subjectPrNumber: 1337,
      subjectResolution: 'reconciled',
    })).toBe(false);
  });

  it('non-PR subjects are never blocked by reconciled resolution', () => {
    // Even if someone set resolution=reconciled on an error subject, the gate shouldn't block it
    expect(subjectStillLive({
      subjectKind: 'error',
      subjectPrNumber: null,
      subjectResolution: 'reconciled',
    })).toBe(true);
  });
});
