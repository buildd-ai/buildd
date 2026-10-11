import { describe, expect, it } from 'bun:test';
import { pauseUntilPhrase } from './workspace-pause-view';

const NOW = new Date(2030, 0, 15, 14, 30);

describe('pauseUntilPhrase', () => {
  it('today reads as a time, another day names the day', () => {
    expect(pauseUntilPhrase(new Date(2030, 0, 15, 18, 0).toISOString(), NOW)).toMatch(/^until \d/);
    expect(pauseUntilPhrase(new Date(2030, 0, 16, 9, 0).toISOString(), NOW)).toMatch(/^until [A-Z][a-z]{2}/);
  });
});
