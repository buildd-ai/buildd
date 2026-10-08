import { describe, expect, it } from 'bun:test';
import { applyChatRetroPatch, chatRetroGloballyEnabled, CHAT_RETRO_DEFAULT, effectiveChatRetroSettings, readChatRetroSettings } from './settings';

describe('chat retro settings: opt-in, default off', () => {
  it('reads NULL, empty, malformed and truthy-but-not-true values as off', () => {
    for (const raw of [null, undefined, {}, [], 'on', 1, { lessons: 'true' }, { lessons: 1 }, { proposals: true }]) {
      expect(readChatRetroSettings(raw)).toEqual({ lessons: false, proposals: false });
    }
    expect(CHAT_RETRO_DEFAULT).toEqual({ lessons: false, proposals: false });
  });

  it('proposals never read as on without lessons', () => {
    expect(readChatRetroSettings({ lessons: false, proposals: true })).toEqual({ lessons: false, proposals: false });
    expect(readChatRetroSettings({ lessons: true, proposals: true })).toEqual({ lessons: true, proposals: true });
    expect(readChatRetroSettings({ lessons: true })).toEqual({ lessons: true, proposals: false });
  });
});

describe('applyChatRetroPatch', () => {
  const off = { lessons: false, proposals: false };
  const on = { lessons: true, proposals: true };

  it('turns lessons on without touching proposals', () => {
    expect(applyChatRetroPatch(off, { lessons: true })).toEqual({ ok: true, next: { lessons: true, proposals: false }, deleteLessons: false });
  });

  it('refuses proposals without lessons', () => {
    const r = applyChatRetroPatch(off, { proposals: true });
    expect(r.ok).toBe(false);
    expect(applyChatRetroPatch(off, { lessons: false, proposals: true }).ok).toBe(false);
    expect(applyChatRetroPatch(off, { lessons: true, proposals: true })).toMatchObject({ ok: true, next: on });
  });

  it('turning lessons off turns proposals off and deletes lessons', () => {
    expect(applyChatRetroPatch(on, { lessons: false })).toEqual({ ok: true, next: off, deleteLessons: true });
  });

  it('turning only proposals off keeps lessons and deletes nothing', () => {
    expect(applyChatRetroPatch(on, { proposals: false })).toEqual({ ok: true, next: { lessons: true, proposals: false }, deleteLessons: false });
  });

  it('rejects unknown keys, non-booleans, empty bodies and non-objects', () => {
    for (const body of [null, [], 'x', {}, { lesson: true }, { lessons: 'yes' }, { proposals: 1 }]) {
      expect(applyChatRetroPatch(off, body).ok).toBe(false);
    }
  });
});

describe('account dogfood: effective lessons + proposals, and no per-team off', () => {
  const off = { lessons: false, proposals: false };
  const on = { lessons: true, proposals: true };

  it('a team with a dogfood owner is effectively fully on whatever is stored; any other team reads its stored value', () => {
    expect(effectiveChatRetroSettings(off, true)).toEqual(on);
    expect(effectiveChatRetroSettings(off, false)).toEqual(off);
    expect(effectiveChatRetroSettings({ lessons: true, proposals: false }, false)).toEqual({ lessons: true, proposals: false });
  });

  it('turning lessons or proposals off is refused, locked, and deletes nothing', () => {
    for (const body of [{ lessons: false }, { proposals: false }, { lessons: false, proposals: false }, { lessons: true, proposals: false }]) {
      const r = applyChatRetroPatch(on, body, { dogfood: true });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.locked).toBe(true);
        expect(r.error).toContain('enabled by account dogfood');
      }
    }
  });

  it('a patch that keeps everything on is accepted as a no-op', () => {
    expect(applyChatRetroPatch(on, { lessons: true }, { dogfood: true })).toEqual({ ok: true, next: on, deleteLessons: false });
  });

  it('without dogfood the same patch still turns things off', () => {
    expect(applyChatRetroPatch(on, { lessons: false }, { dogfood: false })).toEqual({ ok: true, next: off, deleteLessons: true });
  });
});

describe('global kill switch CHAT_RETRO_ENABLED', () => {
  it('unset or any other value leaves opted-in teams running', () => {
    expect(chatRetroGloballyEnabled({})).toBe(true);
    expect(chatRetroGloballyEnabled({ CHAT_RETRO_ENABLED: '1' })).toBe(true);
    expect(chatRetroGloballyEnabled({ CHAT_RETRO_ENABLED: '' })).toBe(true);
  });
  it('0 is off everywhere', () => {
    expect(chatRetroGloballyEnabled({ CHAT_RETRO_ENABLED: '0' })).toBe(false);
    expect(chatRetroGloballyEnabled({ CHAT_RETRO_ENABLED: ' 0 ' })).toBe(false);
  });
});
