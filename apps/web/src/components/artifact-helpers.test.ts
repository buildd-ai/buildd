import { describe, test, expect } from 'bun:test';
import { getArtifactPreview, buildCreateTaskUrl, type ArtifactPreviewInput } from './artifact-helpers';

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

// Regression: create-task-from-artifact action — must render on all viewports including mobile
// See: apps/web/src/components/ArtifactList.tsx and apps/web/src/app/app/(protected)/artifacts/[id]/page.tsx
describe('buildCreateTaskUrl', () => {
  test('produces a valid /app/tasks/new URL with required params', () => {
    const url = buildCreateTaskUrl({ id: 'abc-123', title: 'My Report', content: 'Some content' });
    expect(url).toContain('/app/tasks/new');
    expect(url).toContain('artifactId=abc-123');
    expect(url).toContain('artifactTitle=');
    expect(url).toContain('title=');
    expect(url).toContain('description=');
  });

  test('encodes special characters in title and content', () => {
    const url = buildCreateTaskUrl({ id: 'id-1', title: 'Fix: auth & login', content: 'Do <this>' });
    expect(url).toContain('artifactId=id-1');
    // Encoded special chars must be present (no raw & or < in the URL param values)
    const parsed = new URL(`https://example.com${url}`);
    expect(parsed.searchParams.get('artifactId')).toBe('id-1');
    expect(parsed.searchParams.get('artifactTitle')).toBe('Fix: auth & login');
  });

  test('handles null title gracefully', () => {
    const url = buildCreateTaskUrl({ id: 'xyz', title: null, content: null });
    expect(url).toContain('artifactId=xyz');
    const parsed = new URL(`https://example.com${url}`);
    expect(parsed.searchParams.get('artifactTitle')).toBe('Untitled');
    expect(parsed.searchParams.get('title')).toBe('Implement: Untitled');
  });

  test('truncates long content to 500 chars in the description param', () => {
    const longContent = 'x'.repeat(1000);
    const url = buildCreateTaskUrl({ id: 'id-2', title: 'Title', content: longContent });
    const parsed = new URL(`https://example.com${url}`);
    const description = parsed.searchParams.get('description') ?? '';
    // description = 'Based on artifact "Title":\n\n' + 500 chars + '...'
    const contentPart = description.split('\n\n')[1] ?? '';
    expect(contentPart.length).toBeLessThanOrEqual(504); // 500 chars + '...'
  });
});
