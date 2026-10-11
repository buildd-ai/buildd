import { describe, it, expect } from 'bun:test';
import { renderArtifactManifest, ARTIFACT_MANIFEST_MAX, type ArtifactManifestEntry } from './context-injection';

const entry = (i: number, over: Partial<ArtifactManifestEntry> = {}): ArtifactManifestEntry => ({
  artifactId: `id-${i}`, title: `Doc ${i}`, type: 'content', relation: 'context', revision: 2, pinned: false,
  sizeBytes: 1200, contentHash: 'a'.repeat(64), via: 'task', ...over,
});

describe('renderArtifactManifest', () => {
  it('renders nothing for no links', () => {
    expect(renderArtifactManifest([])).toBeNull();
  });

  it('names each artifact by id, relation, size, revision and short hash', () => {
    const block = renderArtifactManifest([entry(1, { relation: 'normative_reference', pinned: true, revision: 4 })])!;
    expect(block).toContain('## Linked artifacts');
    expect(block).toContain('- Doc 1 — normative_reference (task), content, 1200 bytes, rev 4 pinned, sha256 aaaaaaaaaaaa. id: id-1');
    expect(block).toContain('get_artifact');
  });

  it('caps the list and counts the rest', () => {
    const block = renderArtifactManifest(Array.from({ length: ARTIFACT_MANIFEST_MAX + 3 }, (_, i) => entry(i)))!;
    expect(block.split('\n').filter((l) => l.startsWith('- Doc'))).toHaveLength(ARTIFACT_MANIFEST_MAX);
    expect(block).toContain('…and 3 more');
  });

  it('says current when a floating link has no revision yet', () => {
    expect(renderArtifactManifest([entry(1, { revision: null, sizeBytes: null, contentHash: null })])).toContain('content, current. id: id-1');
  });
});
