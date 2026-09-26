import { describe, expect, it } from 'bun:test';
import { chatStatusCopy, choiceFromPolicy, policyFromChoice } from './provider-copy';

describe('key policy choice', () => {
  it('round-trips the two-control form to the stored policy', () => {
    expect(policyFromChoice({ mode: 'team', allowOwn: false })).toBe('team');
    expect(policyFromChoice({ mode: 'team', allowOwn: true })).toBe('team_or_own');
    expect(policyFromChoice({ mode: 'own', allowOwn: false })).toBe('own');
    expect(policyFromChoice({ mode: 'own', allowOwn: true })).toBe('own');
    for (const p of ['team', 'team_or_own', 'own'] as const) expect(policyFromChoice(choiceFromPolicy(p))).toBe(p);
  });
});

describe('chatStatusCopy', () => {
  it('says chat is on and what it runs on', () => {
    expect(chatStatusCopy({ available: true, reason: null }, { kind: 'team', provider: 'openrouter' }, true, 'team'))
      .toMatchObject({ tone: 'success', text: 'Chat is on. It runs on OpenRouter with the team key.', action: null });
  });

  it('names the real reason: switched off, not a missing key', () => {
    const off = chatStatusCopy({ available: false, reason: 'capability_disabled' }, { kind: 'team', provider: 'openrouter' }, true, 'team');
    expect(off.text).toBe('An admin switched chat off for the team.');
    expect(off.action).toEqual({ href: '/app/settings/ai', label: 'Turn chat back on' });
  });

  it('a missing key: admins get the fix, members get who to ask', () => {
    expect(chatStatusCopy({ available: false, reason: 'no_key' }, { kind: 'none' }, true, 'team').text)
      .toBe('Chat starts once you connect a provider below.');
    expect(chatStatusCopy({ available: false, reason: 'no_key' }, { kind: 'none' }, false, 'team').text)
      .toBe('Chat starts once an admin connects a provider.');
  });

  it('under "everyone brings their own key", points a person at their Profile', () => {
    const c = chatStatusCopy({ available: false, reason: 'no_key' }, { kind: 'needs_own' }, false, 'own');
    expect(c.text).toBe('Everyone on this team brings their own key. Add yours to use chat.');
    expect(c.action).toEqual({ href: '/app/settings/account', label: 'Add your key' });
  });

  it('never uses an em dash', () => {
    const all = [
      chatStatusCopy({ available: true, reason: null }, { kind: 'own', provider: 'anthropic' }, false, 'team_or_own'),
      chatStatusCopy({ available: false, reason: 'no_key' }, { kind: 'none' }, false, 'team'),
    ];
    for (const c of all) expect(c.text).not.toContain('—');
  });
});
