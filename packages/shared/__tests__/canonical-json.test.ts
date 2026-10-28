import { describe, test, expect } from 'bun:test';
import { createHash } from 'crypto';
import { canonicalJson } from '../src/canonical-json';

// Golden values recorded from the pre-dedup implementations. Stored approval
// hashes depend on them: never edit an expected value to make a change pass.
const sha = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');

const GOLDEN: [string, unknown, string, string][] = [
  ['key order', { b: 1, a: 2, c: { z: 1, y: [3, { b: 1, a: 2 }] } },
    '{"a":2,"b":1,"c":{"y":[3,{"a":2,"b":1}],"z":1}}',
    '941090f3b411aec8a94ddde289f03a1cc21c0dcb6b8ca8889d0a6dbcc876f74f'],
  ['nested arrays', [3, [2, [1, { b: [], a: {} }]], null],
    '[3,[2,[1,{"a":{},"b":[]}]],null]',
    '508a4b529ebbb41e978d1bc5eb8b31c033e65f9885da9954cc94294d006afaf9'],
  ['unicode', { 'é': 'ü', '日本': '語', '😀': 'a\u2028b\n"q"\\', a: '\u0000' },
    '{"a":"\\u0000","é":"ü","日本":"語","😀":"a\u2028b\\n\\"q\\"\\\\"}',
    '39b5bbd60cadca14538bc8ef723f4a5e5f67eb3433bac53c5fef67c08a852017'],
  ['undefined / null', { a: undefined, b: null, c: [undefined, null], d: { e: undefined } },
    '{"b":null,"c":[null,null],"d":{}}',
    '3f5c4ca3f472c7b5f83e30b082c1e519f7a97a493a3b801615ae75eeb1df934f'],
  ['numbers', { i: 1, f: 1.5, n: -0, e: 1e21, s: 1e-7, big: 12345678901234567890, nan: NaN, inf: Infinity, neg: -3 },
    '{"big":12345678901234567000,"e":1e+21,"f":1.5,"i":1,"inf":null,"n":0,"nan":null,"neg":-3,"s":1e-7}',
    '0a37f9f465aef06100831d2a37d649a7b92e831be211eb05b618aeb74194312f'],
  ['scalars', ['x', 7, true, null], '["x",7,true,null]',
    'e39c3a1ac90f7c41af5be060ea6a0e73b6800794c91205e80d11d6e41ce03d6d'],
  ['top-level undefined', undefined, 'null',
    '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b'],
];

describe('canonicalJson golden output', () => {
  for (const [name, input, str, hash] of GOLDEN) {
    test(name, () => {
      expect(canonicalJson(input)).toBe(str);
      expect(sha(input)).toBe(hash);
    });
  }
});
