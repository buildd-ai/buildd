import { describe, expect, it } from 'bun:test';
import { upsertedContent } from './artifact-upsert-content';

describe('upsertedContent', () => {
  it('keeps the stored body when the re-create sends no content', () => {
    expect(upsertedContent('original body', undefined)).toBe('original body');
    expect(upsertedContent(null, undefined)).toBeNull();
  });

  it('replaces it with the content sent', () => {
    expect(upsertedContent('old', 'new')).toBe('new');
  });

  it('clears it on an explicit null or empty string', () => {
    expect(upsertedContent('old', null)).toBeNull();
    expect(upsertedContent('old', '')).toBeNull();
  });
});
