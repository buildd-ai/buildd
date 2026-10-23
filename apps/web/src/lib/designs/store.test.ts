import { describe, expect, it } from 'bun:test';
import { planStore, resolveRevision, specPinnedArtifact } from './store';

const SCREENS = [{ id: 'a', name: 'A', viewport: '390x844' }];

describe('planStore', () => {
  it('a first export is revision 1, attached where asked', () => {
    expect(planStore({ screens: SCREENS, attachTo: { kind: 'mission', id: 'm1' }, bytes: 10 }))
      .toEqual({ revision: 1, screens: SCREENS, attachedTo: { kind: 'mission', id: 'm1' }, bytes: 10 });
  });
  it('a new export of an existing design is its next revision', () => {
    expect(planStore({ existing: { id: 'D', currentRevision: 1 }, screens: SCREENS })).toMatchObject({ id: 'D', revision: 2, attachedTo: null });
  });
  it('attaches to a mission, task or spec', () => {
    for (const kind of ['mission', 'task', 'spec'] as const) expect(planStore({ screens: SCREENS, attachTo: { kind, id: 'x' } }).attachedTo).toEqual({ kind, id: 'x' });
  });
});

describe('resolveRevision', () => {
  it('a pin stays, a following link moves', () => {
    expect(resolveRevision({ currentRevision: 2, pinned: 1 })).toBe(1);
    expect(resolveRevision({ currentRevision: 2, follows: true })).toBe(2);
    expect(resolveRevision({ currentRevision: 2 })).toBe(2);
  });
});

describe('specPinnedArtifact', () => {
  it('reads the artifact and revision a spec revision pins', () => {
    expect(specPinnedArtifact({ kind: 'artifact', ref: 'A', version: '2' })).toEqual({ artifactId: 'A', revision: 2 });
  });
  it('a URL, a design-tool file, no pin or a bad version is not a stored design', () => {
    expect(specPinnedArtifact({ kind: 'url', ref: 'https://x', version: '1' })).toBeNull();
    expect(specPinnedArtifact({ kind: 'figma', ref: 'f', version: '1' })).toBeNull();
    expect(specPinnedArtifact(null)).toBeNull();
    expect(specPinnedArtifact({ kind: 'artifact', ref: 'A', version: 'x' })).toBeNull();
  });
});
