import { describe, test, expect } from 'bun:test';
import { getArtifactPreview, buildCreateTaskUrl, getArtifactCollapsedPreview, isSummaryDuplicate, type ArtifactPreviewInput } from './artifact-helpers';

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

describe('getArtifactCollapsedPreview', () => {
  test('returns null for null input (AC-7)', () => {
    expect(getArtifactCollapsedPreview(null)).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(getArtifactCollapsedPreview('')).toBeNull();
  });

  test('strips ATX heading markers, keeps heading text', () => {
    expect(getArtifactCollapsedPreview('## My Heading')).toBe('My Heading');
  });

  test('strips bold and italic markers', () => {
    expect(getArtifactCollapsedPreview('This is **bold** and _italic_ text.')).toBe(
      'This is bold and italic text.'
    );
  });

  test('strips unordered list markers', () => {
    expect(getArtifactCollapsedPreview('- Item one\n- Item two')).toBe('Item one Item two');
  });

  test('strips ordered list markers', () => {
    expect(getArtifactCollapsedPreview('1. First\n2. Second')).toBe('First Second');
  });

  test('truncates to 160 chars at a word boundary and appends ellipsis', () => {
    // Build a string that exceeds 160 chars with words so word-boundary truncation is observable
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const result = getArtifactCollapsedPreview(words)!;
    expect(result.endsWith('…')).toBe(true);
    // Slice without the ellipsis must be ≤ 160 chars
    expect(result.slice(0, -1).length).toBeLessThanOrEqual(160);
    // Must end on a word boundary (no trailing partial word before the ellipsis)
    const withoutEllipsis = result.slice(0, -1);
    expect(withoutEllipsis.endsWith(' ')).toBe(false);
    expect(words.startsWith(withoutEllipsis)).toBe(true);
  });

  test('returns full string when ≤ 160 chars', () => {
    const short = 'Short content without any markdown.';
    expect(getArtifactCollapsedPreview(short)).toBe(short);
  });

  test('never throws on malformed markdown', () => {
    const malformed = '**unclosed bold *** _mixed__ `backtick ~~strike';
    expect(() => getArtifactCollapsedPreview(malformed)).not.toThrow();
  });
});

describe('isSummaryDuplicate', () => {
  test('returns false when artifactContent is null (AC-5)', () => {
    expect(isSummaryDuplicate(null, 'some summary')).toBe(false);
  });

  test('returns false when resultSummary is null', () => {
    expect(isSummaryDuplicate('some content', null)).toBe(false);
  });

  test('returns true for normalized-equal strings (AC-5)', () => {
    expect(isSummaryDuplicate('Hello world', 'Hello world')).toBe(true);
  });

  test('returns true when artifact content is a substring of summary', () => {
    expect(isSummaryDuplicate('short', 'This is a short summary')).toBe(true);
  });

  test('returns true when summary is a substring of artifact content', () => {
    expect(isSummaryDuplicate('This is a short summary', 'short')).toBe(true);
  });

  test('returns false for totally different strings', () => {
    expect(isSummaryDuplicate('apple pie recipe', 'quantum computing overview')).toBe(false);
  });

  test('returns true for strings that differ only by trailing newline', () => {
    expect(isSummaryDuplicate('Hello world\n', 'Hello world')).toBe(true);
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
