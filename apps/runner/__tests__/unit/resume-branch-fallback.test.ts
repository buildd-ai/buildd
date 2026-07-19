import { describe, it, expect } from 'bun:test';
import {
  resolveWorktreeBase,
  clearResumeContext,
  buildRetryContinuitySection,
  RESUME_CONTEXT_FIELDS,
} from '../../src/worktree-utils';

/**
 * Regression: re-running a FAILED task whose prior-attempt branch is gone from
 * the remote must NOT crash. Historically the runner:
 *   1. resolved the worktree base, detected the resumeBranch was missing on
 *      remote, and fell back to origin/<defaultBranch> (fresh worktree), but
 *   2. still built the "A previous agent attempt left commits on this branch"
 *      instructions from the stale context.resumeBranch — and that block
 *      referenced `defaultBranch`, which was not in the session-building scope,
 *      throwing `ReferenceError: defaultBranch is not defined` → worker failed
 *      and the worktree was torn down, so every re-run failed again.
 *
 * The fix: on fallback, clear the resume fields (fresh start) and build the
 * section from a pure helper that takes `defaultBranch` explicitly.
 */
describe('resume-branch fallback → fresh start', () => {
  describe('buildRetryContinuitySection', () => {
    it('returns null (fresh start) when no resumeBranch', () => {
      expect(
        buildRetryContinuitySection({ defaultBranch: 'dev' }),
      ).toBeNull();
    });

    it('returns null when resumeBranch is empty/non-string', () => {
      expect(buildRetryContinuitySection({ resumeBranch: '', defaultBranch: 'dev' })).toBeNull();
      expect(buildRetryContinuitySection({ resumeBranch: 123, defaultBranch: 'dev' })).toBeNull();
      expect(buildRetryContinuitySection({ resumeBranch: undefined, defaultBranch: 'dev' })).toBeNull();
    });

    it('does not throw and references defaultBranch + resumeBranch on the happy path', () => {
      let section: string | null = null;
      expect(() => {
        section = buildRetryContinuitySection({
          resumeBranch: 'buildd/0d590ace-recon',
          lastCommitSha: 'abc1234',
          defaultBranch: 'dev',
        });
      }).not.toThrow();
      expect(section).toContain('A previous agent attempt left commits on this branch');
      expect(section).toContain('origin/buildd/0d590ace-recon');
      // The historical crash was an out-of-scope `defaultBranch`; assert it is
      // rendered explicitly now.
      expect(section).toContain('git diff origin/dev...origin/buildd/0d590ace-recon');
      expect(section).toContain('abc1234');
    });

    it('includes the failure summary line when failureContext is provided', () => {
      const asString = buildRetryContinuitySection({
        resumeBranch: 'buildd/abc',
        failureContext: 'tests timed out',
        defaultBranch: 'main',
      });
      expect(asString).toContain('The prior attempt failed with: tests timed out');

      const asObject = buildRetryContinuitySection({
        resumeBranch: 'buildd/abc',
        failureContext: { summary: 'lint failed' },
        defaultBranch: 'main',
      });
      expect(asObject).toContain('The prior attempt failed with: lint failed');
    });
  });

  describe('clearResumeContext', () => {
    it('strips all resume fields in place', () => {
      const ctx: Record<string, unknown> = {
        resumeBranch: 'buildd/abc',
        lastCommitSha: 'deadbeef',
        failureContext: { summary: 'boom' },
        keepMe: 'preserved',
      };
      clearResumeContext(ctx);
      for (const field of RESUME_CONTEXT_FIELDS) {
        expect(field in ctx).toBe(false);
      }
      expect(ctx.keepMe).toBe('preserved');
    });

    it('is a no-op on null/undefined context', () => {
      expect(() => clearResumeContext(undefined)).not.toThrow();
      expect(() => clearResumeContext(null)).not.toThrow();
    });
  });

  describe('end-to-end: missing resume branch produces a fresh-start config', () => {
    it('resolveWorktreeBase fallback clears resume state so no resume instructions are built', async () => {
      // Simulate a re-run of a failed task: context carries prior-attempt state.
      const context: Record<string, unknown> = {
        resumeBranch: 'buildd/0d590ace-recon',
        lastCommitSha: 'abc1234',
        failureContext: { summary: 'prior attempt crashed' },
      };

      // The prior branch no longer exists on the remote → 'missing'.
      const base = await resolveWorktreeBase({
        defaultBranch: 'dev',
        context,
        fetchBranch: async () => 'missing',
        // This mirrors setupWorktree's wiring: clear resume state on fallback.
        onFallback: () => clearResumeContext(context),
      });

      // Fell back to the default base (fresh worktree).
      expect(base).toBe('origin/dev');

      // Resume state was cleared...
      expect(context.resumeBranch).toBeUndefined();
      expect(context.lastCommitSha).toBeUndefined();
      expect(context.failureContext).toBeUndefined();

      // ...so building the prompt section does NOT throw and yields a fresh
      // start (null → no "prior attempt" instructions appended).
      let section: string | null = 'unset';
      expect(() => {
        section = buildRetryContinuitySection({
          resumeBranch: (context as any).resumeBranch,
          lastCommitSha: (context as any).lastCommitSha,
          failureContext: (context as any).failureContext,
          defaultBranch: 'dev',
        });
      }).not.toThrow();
      expect(section).toBeNull();
    });

    it('happy path: resume branch present on remote keeps real resume instructions', async () => {
      const context: Record<string, unknown> = {
        resumeBranch: 'buildd/abc',
        lastCommitSha: 'abc1234',
      };
      const base = await resolveWorktreeBase({
        defaultBranch: 'dev',
        context,
        fetchBranch: async () => 'ok',
        onFallback: () => clearResumeContext(context),
      });
      expect(base).toBe('origin/buildd/abc');
      // Resume state preserved.
      expect(context.resumeBranch).toBe('buildd/abc');

      const section = buildRetryContinuitySection({
        resumeBranch: (context as any).resumeBranch,
        lastCommitSha: (context as any).lastCommitSha,
        failureContext: (context as any).failureContext,
        defaultBranch: 'dev',
      });
      expect(section).toContain('origin/buildd/abc');
    });
  });
});
