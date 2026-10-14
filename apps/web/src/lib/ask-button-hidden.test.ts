import { describe, expect, it } from 'bun:test';
import { askButtonHiddenSnapshot, hideAskButton } from './ask-button-hidden';

describe('ask-button-hidden', () => {
  it('hides while any hold is live, and a release counts once', () => {
    expect(askButtonHiddenSnapshot()).toBe(false);
    const a = hideAskButton();
    const b = hideAskButton();
    expect(askButtonHiddenSnapshot()).toBe(true);
    a();
    a();
    expect(askButtonHiddenSnapshot()).toBe(true);
    b();
    expect(askButtonHiddenSnapshot()).toBe(false);
  });
});
