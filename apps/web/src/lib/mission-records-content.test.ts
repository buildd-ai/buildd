import { describe, expect, it } from 'bun:test';
import { RECORDS_CONTENT_MAX_IDS, fetchRecordsContent, parseContentIds, recordsContentUrl } from './mission-records-content';

// Illustrative ids only.
const id = (n: number) => `55555555-5555-4555-8555-${String(n).padStart(12, '0')}`;

describe('parseContentIds', () => {
  it('keeps distinct well-formed ids, in order', () => {
    expect(parseContentIds(`${id(1)}, ${id(2)},${id(1)},nope,`)).toEqual([id(1), id(2)]);
  });

  it('empty or missing → none', () => {
    expect(parseContentIds(null)).toEqual([]);
    expect(parseContentIds('')).toEqual([]);
  });

  it('caps at RECORDS_CONTENT_MAX_IDS', () => {
    const raw = Array.from({ length: RECORDS_CONTENT_MAX_IDS + 5 }, (_, i) => id(i)).join(',');
    expect(parseContentIds(raw)).toHaveLength(RECORDS_CONTENT_MAX_IDS);
  });
});

describe('fetchRecordsContent', () => {
  it('chunks by the cap and merges the answers', async () => {
    const urls: string[] = [];
    const fetcher = (async (url: string) => {
      urls.push(url);
      const ids = new URL(url, 'http://x').searchParams.get('ids')!.split(',');
      return new Response(JSON.stringify({ contents: Object.fromEntries(ids.map(i => [i, `body ${i.slice(-2)}`])) }));
    }) as unknown as typeof fetch;
    const ids = Array.from({ length: RECORDS_CONTENT_MAX_IDS + 1 }, (_, i) => id(i));
    const out = await fetchRecordsContent('m1', ids, fetcher);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe(recordsContentUrl('m1', ids.slice(0, RECORDS_CONTENT_MAX_IDS)));
    expect(Object.keys(out)).toHaveLength(ids.length);
  });

  it('rejects on a non-2xx answer', async () => {
    const fetcher = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
    await expect(fetchRecordsContent('m1', [id(1)], fetcher)).rejects.toThrow('500');
  });
});
