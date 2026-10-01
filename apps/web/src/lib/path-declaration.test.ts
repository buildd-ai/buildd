import { describe, it, expect } from 'bun:test';
import { conformanceManifest } from './path-declaration';

describe('conformanceManifest', () => {
  it('a narrowed manifest still expects what was declared', () => {
    expect(conformanceManifest({
      pathManifest: ['a.ts'],
      pathDeclaration: { declared: ['a.ts', 'b.ts'], source: 'creation', snapshotAt: 'x' },
    })).toEqual(['a.ts', 'b.ts']);
  });

  it('keeps paths declared at runtime after the snapshot', () => {
    expect(conformanceManifest({
      pathManifest: ['a.ts', 'c.ts'],
      pathDeclaration: { declared: ['a.ts'], source: 'creation', snapshotAt: 'x' },
    })).toEqual(['a.ts', 'c.ts']);
  });

  it('falls back to the manifest without a snapshot, and to null without either', () => {
    expect(conformanceManifest({ pathManifest: ['a.ts'], pathDeclaration: null })).toEqual(['a.ts']);
    expect(conformanceManifest({ pathManifest: null, pathDeclaration: null })).toBeNull();
    expect(conformanceManifest(null)).toBeNull();
  });
});
