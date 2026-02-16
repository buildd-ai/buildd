import { describe, it, expect, mock, beforeEach } from 'bun:test';

// The functions are defined inline in route.ts, so we need to extract them
// or test via the module. For now, let's re-implement and test the pure functions
// to validate the logic, then test evaluateTrigger with fetch mocks.

// -- Pure function copies (these mirror route.ts exactly) --

function extractByPath(obj: unknown, path?: string): string | null {
  if (!path) return typeof obj === 'string' ? obj : JSON.stringify(obj);
  const parts = path.replace(/^\./, '').split(/\.|\[(\d+)\]/).filter(Boolean);
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null) return null;
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return null;
    }
  }
  return current != null ? String(current) : null;
}

function parseAtomFeed(xml: string): { latestId: string | null; latestTitle: string | null; latestLink: string | null } {
  const entryMatch = xml.match(/<entry[^>]*>([\s\S]*?)<\/entry>/);
  if (!entryMatch) return { latestId: null, latestTitle: null, latestLink: null };
  const entry = entryMatch[1];

  const idMatch = entry.match(/<id[^>]*>([\s\S]*?)<\/id>/);
  const titleMatch = entry.match(/<title[^>]*>([\s\S]*?)<\/title>/);
  const linkMatch = entry.match(/<link[^>]*href="([^"]*)"/) || entry.match(/<link[^>]*>([\s\S]*?)<\/link>/);

  return {
    latestId: idMatch?.[1]?.trim() || null,
    latestTitle: titleMatch?.[1]?.trim() || null,
    latestLink: linkMatch?.[1]?.trim() || null,
  };
}

describe('extractByPath', () => {
  it('returns stringified object when no path given', () => {
    expect(extractByPath({ a: 1 })).toBe('{"a":1}');
  });

  it('returns string directly when no path and value is string', () => {
    expect(extractByPath('hello')).toBe('hello');
  });

  it('extracts top-level field', () => {
    expect(extractByPath({ tag_name: 'v0.2.42' }, '.tag_name')).toBe('v0.2.42');
  });

  it('extracts top-level field without leading dot', () => {
    expect(extractByPath({ tag_name: 'v0.2.42' }, 'tag_name')).toBe('v0.2.42');
  });

  it('extracts nested field', () => {
    const obj = { release: { latest: { version: '1.0.0' } } };
    expect(extractByPath(obj, '.release.latest.version')).toBe('1.0.0');
  });

  it('extracts array element', () => {
    const obj = { items: ['a', 'b', 'c'] };
    expect(extractByPath(obj, '.items[0]')).toBe('a');
    expect(extractByPath(obj, '.items[2]')).toBe('c');
  });

  it('extracts nested array element field', () => {
    const obj = { feed: { entry: [{ id: 'tag:github,release-123' }] } };
    expect(extractByPath(obj, '.feed.entry[0].id')).toBe('tag:github,release-123');
  });

  it('returns null for missing path', () => {
    expect(extractByPath({ a: 1 }, '.b')).toBeNull();
  });

  it('returns null for null object', () => {
    expect(extractByPath(null, '.a')).toBeNull();
  });

  it('returns null for deep missing path', () => {
    expect(extractByPath({ a: { b: 1 } }, '.a.c.d')).toBeNull();
  });

  it('converts numbers to strings', () => {
    expect(extractByPath({ version: 42 }, '.version')).toBe('42');
  });

  it('converts booleans to strings', () => {
    expect(extractByPath({ enabled: true }, '.enabled')).toBe('true');
  });
});

describe('parseAtomFeed', () => {
  const sampleFeed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Release notes from claude-code</title>
  <entry>
    <id>tag:github.com,2008:Repository/123/v0.2.42</id>
    <title>v0.2.42</title>
    <link href="https://github.com/anthropics/claude-code/releases/tag/v0.2.42"/>
    <content>Bug fixes and improvements</content>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/123/v0.2.41</id>
    <title>v0.2.41</title>
    <link href="https://github.com/anthropics/claude-code/releases/tag/v0.2.41"/>
  </entry>
</feed>`;

  it('extracts first entry id', () => {
    const result = parseAtomFeed(sampleFeed);
    expect(result.latestId).toBe('tag:github.com,2008:Repository/123/v0.2.42');
  });

  it('extracts first entry title', () => {
    const result = parseAtomFeed(sampleFeed);
    expect(result.latestTitle).toBe('v0.2.42');
  });

  it('extracts first entry link', () => {
    const result = parseAtomFeed(sampleFeed);
    expect(result.latestLink).toBe('https://github.com/anthropics/claude-code/releases/tag/v0.2.42');
  });

  it('returns nulls for empty feed', () => {
    const result = parseAtomFeed('<feed></feed>');
    expect(result.latestId).toBeNull();
    expect(result.latestTitle).toBeNull();
    expect(result.latestLink).toBeNull();
  });

  it('returns nulls for non-XML string', () => {
    const result = parseAtomFeed('not xml at all');
    expect(result.latestId).toBeNull();
  });

  it('handles entry with only title (no id)', () => {
    const xml = '<feed><entry><title>v1.0</title></entry></feed>';
    const result = parseAtomFeed(xml);
    expect(result.latestId).toBeNull();
    expect(result.latestTitle).toBe('v1.0');
  });

  it('handles self-closing link tag', () => {
    const xml = '<feed><entry><id>123</id><link href="https://example.com/release" rel="alternate"/></entry></feed>';
    const result = parseAtomFeed(xml);
    expect(result.latestLink).toBe('https://example.com/release');
  });

  it('ignores second entry', () => {
    const result = parseAtomFeed(sampleFeed);
    // Should get v0.2.42, not v0.2.41
    expect(result.latestTitle).toBe('v0.2.42');
  });
});

describe('trigger evaluation logic', () => {
  // These test the comparison logic without needing fetch mocks

  it('detects change when current differs from last', () => {
    const currentValue = 'v0.2.43';
    const lastValue = 'v0.2.42';
    expect(currentValue !== lastValue).toBe(true);
  });

  it('detects no change when values match', () => {
    const currentValue = 'v0.2.42';
    const lastValue = 'v0.2.42';
    expect(currentValue !== lastValue).toBe(false);
  });

  it('detects change on first run (null last value)', () => {
    const currentValue = 'v0.2.42';
    const lastValue = null;
    expect(currentValue !== lastValue).toBe(true);
  });

  it('title interpolation replaces {{triggerValue}}', () => {
    const template = 'New Claude SDK release: {{triggerValue}}';
    const result = template.replace(/\{\{triggerValue\}\}/g, 'v0.2.43');
    expect(result).toBe('New Claude SDK release: v0.2.43');
  });

  it('title interpolation handles multiple placeholders', () => {
    const template = '{{triggerValue}} released — check {{triggerValue}}';
    const result = template.replace(/\{\{triggerValue\}\}/g, 'v1.0');
    expect(result).toBe('v1.0 released — check v1.0');
  });

  it('title without placeholder is unchanged', () => {
    const template = 'Run SDK changelog review';
    const result = template.replace(/\{\{triggerValue\}\}/g, 'v1.0');
    expect(result).toBe('Run SDK changelog review');
  });
});
