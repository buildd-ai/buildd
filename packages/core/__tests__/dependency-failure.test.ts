import { describe, expect, it } from 'bun:test';
import { DEPENDENCY_FAILED_ERROR_TYPE, dependencyFailedResult, dependencyFailureOf } from '../dependency-failure';

const ID = '0a1b2c3d-4e5f-4061-8728-394a5b6c7d8e';

describe('dependencyFailureOf', () => {
  it('reads what the cascade writes', () => {
    const r = dependencyFailedResult({ id: ID, title: 'Build "the" thing' });
    expect(r.errorType).toBe(DEPENDENCY_FAILED_ERROR_TYPE);
    expect(dependencyFailureOf(r)).toEqual({ taskId: ID, title: 'Build "the" thing' });
  });

  it('reads the text rows written before errorType existed, quotes in the title included', () => {
    expect(dependencyFailureOf({ error: `Blocked: dependency "Make "it" truthful" (${ID}) failed` }))
      .toEqual({ taskId: ID, title: 'Make "it" truthful' });
  });

  it('reads the text when a digest kept errorType and error but not blockedBy', () => {
    expect(dependencyFailureOf({ errorType: 'dependency_failed', error: `Blocked: dependency "B" (${ID}) failed` })).toEqual({ taskId: ID, title: 'B' });
  });

  it('is null for every other failure and for no result', () => {
    for (const r of [null, undefined, 'x', [], {}, { errorType: 'max_turns', error: 'Ran out of turns' }, { error: 'Blocked: dependency PR not merged' }]) {
      expect(dependencyFailureOf(r)).toBeNull();
    }
  });
});
