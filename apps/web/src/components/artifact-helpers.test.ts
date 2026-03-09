import { describe, test, expect } from 'bun:test';
import { getArtifactPreview, type ArtifactPreviewInput } from './artifact-helpers';

describe('getArtifactPreview', () => {
  test('returns URL for link artifacts from metadata', () => {
    const artifact: ArtifactPreviewInput = {
      type: 'link',
      content: null,
      metadata: { url: 'https://example.com/report' },
    };
    expect(getArtifactPreview(artifact)).toBe('https://example.com/report');
  });

  test('returns null for link artifacts without URL', () => {
    const artifact: ArtifactPreviewInput = {
      type: 'link',
      content: null,
      metadata: {},
    };
    expect(getArtifactPreview(artifact)).toBeNull();
  });

  test('returns null when content is null', () => {
    const artifact: ArtifactPreviewInput = {
      type: 'content',
      content: null,
      metadata: {},
    };
    expect(getArtifactPreview(artifact)).toBeNull();
  });

  test('pretty-prints JSON for data artifacts', () => {
    const data = { key: 'value', nested: { a: 1 } };
    const artifact: ArtifactPreviewInput = {
      type: 'data',
      content: JSON.stringify(data),
      metadata: {},
    };
    const preview = getArtifactPreview(artifact)!;
    expect(preview).toContain('"key": "value"');
    expect(preview).toContain('"nested"');
  });

  test('truncates data artifacts to 300 chars', () => {
    const largeData = { items: Array.from({ length: 100 }, (_, i) => ({ id: i, name: `Item ${i}` })) };
    const artifact: ArtifactPreviewInput = {
      type: 'data',
      content: JSON.stringify(largeData),
      metadata: {},
    };
    const preview = getArtifactPreview(artifact)!;
    expect(preview.length).toBeLessThanOrEqual(300);
  });

  test('falls back to raw content for invalid JSON data', () => {
    const artifact: ArtifactPreviewInput = {
      type: 'data',
      content: 'not valid json {{{',
      metadata: {},
    };
    expect(getArtifactPreview(artifact)).toBe('not valid json {{{');
  });

  test('truncates content/report/summary to 500 chars', () => {
    const longContent = 'x'.repeat(1000);
    for (const type of ['content', 'report', 'summary']) {
      const artifact: ArtifactPreviewInput = { type, content: longContent, metadata: {} };
      const preview = getArtifactPreview(artifact)!;
      expect(preview.length).toBe(500);
    }
  });

  test('returns full content when under 500 chars', () => {
    const artifact: ArtifactPreviewInput = {
      type: 'content',
      content: '# Report\n\nSome markdown content with **bold** text.',
      metadata: {},
    };
    expect(getArtifactPreview(artifact)).toBe('# Report\n\nSome markdown content with **bold** text.');
  });
});
