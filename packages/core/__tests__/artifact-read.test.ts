import { describe, expect, it } from 'bun:test';
import {
  ArtifactReadError, AUTO_FULL_MAX_CHARS, MAX_SLICE_CHARS, outlineOf, parseReadSelector, readArtifactBody, returnedChars,
} from '../artifact-read';

/** A 200-page reference: 40 chapters × 5 sections, ~3,000 characters a page. */
function manual(): string {
  const parts: string[] = ['# Operations manual\n'];
  for (let c = 1; c <= 40; c++) {
    parts.push(`## Chapter ${c}: ${c === 17 ? 'Rotating credentials' : `Topic ${c}`}\n`);
    for (let s = 1; s <= 5; s++) {
      parts.push(`### ${c}.${s} Procedure\n`);
      const marker = c === 17 && s === 3 ? 'To rotate a signing key, revoke the old key only after every verifier has the new one.\n' : '';
      parts.push(marker + `Line ${c}.${s} of filler text that stands in for a page. `.repeat(60) + '\n');
    }
  }
  parts.push('```\n# not a heading inside a fence\n```\n');
  return parts.join('');
}

const q = (o: Record<string, string>) => new URLSearchParams(o);

describe('outlineOf', () => {
  it('lists headings with offsets that read back exactly their section, ignoring fenced code', () => {
    const body = '# A\nintro\n## B\nb text\n```\n## not\n```\n## C\nc\n';
    const o = outlineOf(body);
    expect(o.map((s) => [s.id, s.level, s.title])).toEqual([['s1', 1, 'A'], ['s2', 2, 'B'], ['s3', 2, 'C']]);
    expect(body.slice(o[1].start, o[1].end)).toBe('## B\nb text\n```\n## not\n```\n');
    expect(o[0].end).toBe(body.length); // a level-1 section runs to the end
  });
});

describe('a 200-page reference read selectively', () => {
  const body = manual();

  it('is really that long', () => {
    expect(body.length).toBeGreaterThan(200 * 3_000);
  });

  it('outline, then a search, then three sections return a few percent of the bytes, and name exactly what was read', () => {
    const outline = readArtifactBody(body, parseReadSelector(q({ view: 'outline' }), body)!);
    if (outline.view !== 'outline') throw new Error('expected outline');
    const chapter = outline.sections.find((s) => s.title.includes('Rotating credentials'))!;

    const hits = readArtifactBody(body, parseReadSelector(q({ view: 'grep', grep: 'signing key' }), body)!);
    if (hits.view !== 'grep') throw new Error('expected grep');
    expect(hits.matches).toHaveLength(1);
    const hitOffset = hits.matches[0].offset;
    const inSection = outline.sections.filter((s) => s.level === 3 && s.start <= hitOffset && hitOffset < s.end)[0];

    const reads = [inSection.id, outline.sections[outline.sections.indexOf(inSection) - 1].id, outline.sections[outline.sections.indexOf(inSection) + 1].id]
      .map((id) => readArtifactBody(body, parseReadSelector(q({ view: 'section', section: id }), body)!));
    expect(reads[0].view === 'section' && reads[0].text).toContain('revoke the old key only after');
    expect(chapter.start).toBeLessThan(inSection.start);

    const outlineBytes = JSON.stringify(outline.sections).length;
    const returned = outlineBytes + returnedChars(hits) + reads.reduce((n, r) => n + returnedChars(r), 0);
    expect(returned / body.length).toBeLessThan(0.05);
  });

  it('the full read is still byte-identical on explicit request', () => {
    const full = readArtifactBody(body, parseReadSelector(q({ view: 'full' }), body)!);
    expect(full.view === 'full' && full.text).toBe(body);
  });

  it('auto gives the outline for a long body and the body for a short one', () => {
    expect(parseReadSelector(q({ view: 'auto' }), body)).toEqual({ view: 'outline' });
    expect(parseReadSelector(q({ view: 'auto' }), 'x'.repeat(AUTO_FULL_MAX_CHARS))).toEqual({ view: 'full' });
  });
});

describe('bounds and refusals', () => {
  it('caps a range and says it was cut', () => {
    const r = readArtifactBody('y'.repeat(50_000), { view: 'range', offset: 10, length: 40_000 });
    expect(r.view === 'range' && [r.text.length, r.truncated]).toEqual([MAX_SLICE_CHARS, true]);
  });

  it('grep is literal (no regex), case-insensitive and capped', () => {
    const body = Array.from({ length: 80 }, (_, i) => `row ${i} a.b`).join('\n');
    const r = readArtifactBody(body, { view: 'grep', pattern: 'A.B' });
    expect(r.view === 'grep' && [r.matches.length, r.truncated]).toEqual([50, true]);
    const none = readArtifactBody('aXb', { view: 'grep', pattern: 'a.b' });
    expect(none.view === 'grep' && none.matches).toEqual([]);
  });

  it('refuses unknown views, missing selectors and an unknown section', () => {
    expect(() => parseReadSelector(q({ view: 'everything' }), '')).toThrow(ArtifactReadError);
    expect(() => parseReadSelector(q({ view: 'section' }), '')).toThrow(ArtifactReadError);
    expect(() => parseReadSelector(q({ view: 'grep' }), '')).toThrow(ArtifactReadError);
    expect(() => parseReadSelector(q({ view: 'range', offset: '-1' }), '')).toThrow(ArtifactReadError);
    expect(() => readArtifactBody('# a\n', { view: 'section', section: 's9' })).toThrow(ArtifactReadError);
    expect(parseReadSelector(q({}), 'x')).toBeNull();
  });
});
