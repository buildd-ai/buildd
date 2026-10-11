import { describe, expect, it } from 'bun:test';
import { clampedKeysNotice } from './clamped-keys-notice';

describe('clampedKeysNotice', () => {
  it('says nothing when no key changed, or the count is missing or malformed', () => {
    for (const v of [0, undefined, null, -1, 1.5, '2']) expect(clampedKeysNotice(v, 'they')).toBe('');
  });

  it('names the count, singular and plural', () => {
    expect(clampedKeysNotice(1, 'they')).toBe('1 API key they created was lowered to what their new role allows.');
    expect(clampedKeysNotice(3, 'you')).toBe('3 API keys you created were lowered to what your new role allows.');
  });
});
