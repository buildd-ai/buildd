import { describe, expect, it } from 'bun:test';
import type { SpecPublicationDecision, SpecRepoCopyState } from '@buildd/core/db/schema';

const { repoCopyLine } = await import('./repo-copy');

const at = '2026-10-01T00:00:00Z';
const decision = (over: Partial<SpecPublicationDecision>): SpecPublicationDecision => ({
  publish: false, source: 'fallback', reasonCode: 'below_bar', policyVersion: null, revision: 1, decidedAt: at,
  reason: 'Not published: the policy check has not been measured well enough to publish on its own yet, so a person decides.', ...over,
});
const kept = (p: SpecPublicationDecision, extra: Partial<SpecRepoCopyState> = {}): SpecRepoCopyState => ({ state: 'private', publication: p, updatedAt: at, ...extra });
const EXPLAINS = /Not published|Not in the repo|policy|measured|decision model|on its own|Source: buildd/i;

describe('repoCopyLine: words only where the person has something to do', () => {
  it('a kept-private spec shows no sentence, only Add to repo where it is allowed', () => {
    for (const reasonCode of ['below_bar', 'model_unsure_line_none', 'rule_too_long', 'fallback_error', 'model_keep_private_line_2']) {
      const line = repoCopyLine(true, kept(decision({ reasonCode })), true)!;
      expect(line).toMatchObject({ source: null, copy: null, behind: false, publishAnyway: true });
    }
  });

  it('a private mark or a missing policy shows nothing at all', () => {
    for (const reasonCode of ['rule_marked_private', 'rule_no_policy']) {
      expect(repoCopyLine(true, kept(decision({ source: 'rule', reasonCode })), true)).toMatchObject({ copy: null, publishAnyway: false });
    }
  });

  it('never shows the stored sentence, old or new', () => {
    const line = repoCopyLine(true, kept(decision({})), true)!;
    expect(JSON.stringify(line)).not.toMatch(EXPLAINS);
  });

  it('a production-data hit names the hit and the fix, from an old decision too', () => {
    const old = decision({ source: 'rule', reasonCode: 'rule_prod_data', reason: 'Not published: the text has what looks like production data (line 3: a UUID). Take it out in a new revision.' });
    expect(repoCopyLine(true, kept(old), true)).toMatchObject({ copy: 'Looks like production data (line 3: a UUID). Remove it in a new revision.', behind: true, publishAnyway: false });
    expect(repoCopyLine(true, kept(decision({ reasonCode: 'rule_prod_data', hit: 'line 9: a token', reason: 'x' })), true)!.copy).toBe('Looks like production data (line 9: a token). Remove it in a new revision.');
  });

  it('a landed copy is its path, an open one is nothing', () => {
    expect(repoCopyLine(true, { state: 'merged', path: 'docs/specs/checkout.md', revision: 2, updatedAt: at }, true)).toEqual({ source: null, copy: null, behind: false, path: 'docs/specs/checkout.md' });
    expect(repoCopyLine(true, { state: 'open', path: 'docs/specs/checkout.md', revision: 2, prNumber: 9, updatedAt: at }, true)).toBeNull();
    expect(repoCopyLine(true, null, true)).toBeNull();
  });

  it('a red or refused copy PR names the PR and what to do', () => {
    expect(repoCopyLine(true, { state: 'behind', prNumber: 9, failingCheck: 'Lint specs', updatedAt: at }, true)!.copy).toBe('PR #9 failed Lint specs. Fix it in a new revision.');
    expect(repoCopyLine(true, { state: 'refused', prNumber: 9, updatedAt: at }, true)!.copy).toBe("PR #9 has a commit buildd didn't write. Review it before it lands.");
  });

  it('an unconfirmed import names its file, tersely', () => {
    expect(repoCopyLine(false, null, false, { state: 'imported', path: 'docs/specs/a.md', commitSha: 'abcdef1234567890' } as never)).toEqual({ source: 'Imported from docs/specs/a.md@abcdef1', copy: null, behind: false });
  });
});
