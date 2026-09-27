import { describe, expect, it } from 'bun:test';
import { CHAT_INSTRUCTIONS } from './instructions';

describe('CHAT_INSTRUCTIONS', () => {
  // The model's text stays in the thread after the person confirms, so "I won't
  // file it until you confirm" read as a false claim next to the filed mission.
  // The card already says it needs their OK; the prose must not repeat it.
  it('tells the model not to promise in prose to wait for confirmation', () => {
    expect(CHAT_INSTRUCTIONS).toMatch(/don't say you'll wait for their OK/i);
  });
});
