import { describe, it, expect } from 'bun:test';
import { isUuid } from './uuid';

describe('isUuid', () => {
  it('accepts a canonical UUID in either case', () => {
    expect(isUuid('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(isUuid('ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF')).toBe(true);
  });

  it('rejects the shapes Postgres would refuse for a uuid column', () => {
    for (const v of ['worker-1', '', '11111111', '11111111-1111-4111-8111-11111111111', ' 11111111-1111-4111-8111-111111111111', undefined, null, 42]) {
      expect(isUuid(v)).toBe(false);
    }
  });
});
