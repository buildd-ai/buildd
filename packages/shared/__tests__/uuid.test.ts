import { describe, it, expect } from 'bun:test';
import { isUuid } from '../src/uuid';

describe('isUuid', () => {
  it('accepts canonical UUIDs in either case, any version or variant', () => {
    expect(isUuid('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(isUuid('ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF')).toBe(true);
    expect(isUuid('00000000-0000-0000-0000-000000000000')).toBe(true);
    expect(isUuid('ffffffff-ffff-ffff-ffff-ffffffffffff')).toBe(true);
  });

  it('rejects malformed strings', () => {
    for (const v of [
      'worker-1', '', '11111111',
      '11111111-1111-4111-8111-11111111111',
      '11111111-1111-4111-8111-1111111111111',
      ' 11111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111111\n',
      '11111111111141118111111111111111',
      'g1111111-1111-4111-8111-111111111111',
    ]) expect(isUuid(v)).toBe(false);
  });

  it('rejects non-strings', () => {
    for (const v of [undefined, null, 42, {}, []]) expect(isUuid(v)).toBe(false);
  });
});
