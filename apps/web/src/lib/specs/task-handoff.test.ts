/**
 * Specify → Build handoff (living-specs.md §20, R-81 to R-84): the spec a
 * task drafted reaches the task that builds it, a provisional pin tells the
 * builder to build rather than ask, and the approver is asked once.
 * The real-Postgres path is tests/db/spec-specify-to-build.test.ts.
 */
import { describe, expect, it } from 'bun:test';
import {
  SPEC_APPROVAL_ASKED_KEY, SPEC_AUTHORED_KEY,
  authoredSpecFrom, inheritableSpec, shouldAskApproval, specPinBrief,
} from './task-handoff';

const SPEC = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const REV = '33333333-3333-4333-8333-333333333333';

describe('authoredSpecFrom', () => {
  it('reads the spec a task wrote from its context', () => {
    expect(authoredSpecFrom({ [SPEC_AUTHORED_KEY]: { specId: SPEC, revision: 2 } })).toEqual({ specId: SPEC, revision: 2 });
  });
  it('ignores anything that is not a spec id', () => {
    expect(authoredSpecFrom({ [SPEC_AUTHORED_KEY]: { specId: 'nope', revision: 2 } })).toBeNull();
    expect(authoredSpecFrom(null)).toBeNull();
    expect(authoredSpecFrom({})).toBeNull();
  });
});

describe('inheritableSpec (R-81)', () => {
  const dep = (id: string, specId?: string) => ({ id, context: specId ? { [SPEC_AUTHORED_KEY]: { specId, revision: 1 } } : {} });

  it('a build task with no spec inherits the one spec its dependency drafted', () => {
    expect(inheritableSpec({ context: {} }, [dep('a', SPEC), dep('b')])).toEqual({ specId: SPEC, inheritedFrom: 'a' });
  });

  it('a task that already names a spec keeps it', () => {
    expect(inheritableSpec({ context: { specSource: { specId: OTHER } } }, [dep('a', SPEC)])).toBeNull();
  });

  it('a repo-doc specSource (specPath only) gains the spec id, nothing else is touched', () => {
    expect(inheritableSpec({ context: { specSource: { specPath: 'docs/specs/x.md' } } }, [dep('a', SPEC)])).toEqual({ specId: SPEC, inheritedFrom: 'a' });
  });

  it('two dependencies that drafted different specs are ambiguous: no pin is guessed', () => {
    expect(inheritableSpec({ context: {} }, [dep('a', SPEC), dep('b', OTHER)])).toBeNull();
  });

  it('two dependencies on the same spec are one spec', () => {
    expect(inheritableSpec({ context: {} }, [dep('a', SPEC), dep('b', SPEC)])).toEqual({ specId: SPEC, inheritedFrom: 'a' });
  });

  it('no dependency drafted a spec: nothing', () => {
    expect(inheritableSpec({ context: {} }, [dep('a')])).toBeNull();
    expect(inheritableSpec({ context: {} }, [])).toBeNull();
  });
});

describe('specPinBrief (R-82)', () => {
  it('a provisional pin tells the agent to build against it and not to ask for approval', () => {
    const text = specPinBrief({ specId: SPEC, specRevisionId: REV, revision: 2, contentHash: 'h', provisional: true }, 'Checkout')!;
    expect(text).toContain('revision 2');
    expect(text).toContain('Checkout');
    expect(text).toContain('Built ahead of approval, against revision 2');
    expect(text).toMatch(/do not ask/i);
    expect(text).toContain(`revision: 2`);
  });

  it('an approved pin names the revision in force', () => {
    const text = specPinBrief({ specId: SPEC, specRevisionId: REV, revision: 3, contentHash: 'h' }, 'Checkout')!;
    expect(text).toContain('approved revision 3');
    expect(text).not.toContain('Built ahead of approval');
  });

  it('a repo-doc source or an unpinned id gets no brief', () => {
    expect(specPinBrief({ specPath: 'docs/specs/x.md' }, null)).toBeNull();
    expect(specPinBrief({ specId: SPEC }, null)).toBeNull();
    expect(specPinBrief(null, null)).toBeNull();
  });
});

describe('shouldAskApproval (R-83)', () => {
  const pin = { specId: SPEC, specRevisionId: REV, revision: 2, contentHash: 'h', provisional: true };

  it('the first claim of a provisional pin asks once', () => {
    expect(shouldAskApproval({ specSource: pin })).toBe(true);
  });

  it('a task that already asked for this revision does not ask again', () => {
    expect(shouldAskApproval({ specSource: pin, [SPEC_APPROVAL_ASKED_KEY]: { specId: SPEC, revision: 2 } })).toBe(false);
  });

  it('a new revision of the same spec, still unapproved, asks again', () => {
    expect(shouldAskApproval({ specSource: { ...pin, revision: 3 }, [SPEC_APPROVAL_ASKED_KEY]: { specId: SPEC, revision: 2 } })).toBe(true);
  });

  it('an approved pin needs no approval', () => {
    expect(shouldAskApproval({ specSource: { ...pin, provisional: undefined } })).toBe(false);
  });
});
