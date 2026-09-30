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

describe('CHAT_INSTRUCTIONS: visual review', () => {
  it('leads with issues and unsure screens by route, and never claims to have seen a screenshot', () => {
    expect(CHAT_INSTRUCTIONS).toMatch(/get_visual_review/);
    expect(CHAT_INSTRUCTIONS).toMatch(/issues and the unsure screens, by route/);
    expect(CHAT_INSTRUCTIONS).toMatch(/never claim to have looked at one/);
  });
});

describe('CHAT_INSTRUCTIONS: one write per intent', () => {
  // A turn fired "auto-dismiss sender" and "mute sender" for one request; the
  // cap refused the twin, and the model then treated it like a discard.
  it('forbids a twin write for the same intent and separates a cap refusal from a discard', () => {
    expect(CHAT_INSTRUCTIONS).toMatch(/one intent gets one call/);
    expect(CHAT_INSTRUCTIONS).toMatch(/not shown to the person/);
    expect(CHAT_INSTRUCTIONS).toMatch(/don't call it discarded or done/);
  });
});
