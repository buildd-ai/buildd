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
  it('says interactive AI is on and what it runs on', () => {
    expect(chatStatusCopy({ available: true, reason: null }, { kind: 'team', provider: 'openrouter' }, true, 'team'))
      .toMatchObject({ tone: 'success', text: 'Interactive AI is on · OpenRouter · team key', action: null });
  });

  it('never offers a switch to turn it on: the only unavailable reason is a missing key', () => {
    for (const admin of [true, false]) {
      for (const policy of ['team', 'team_or_own', 'own'] as const) {
        const c = chatStatusCopy({ available: false, reason: 'no_key' }, { kind: 'none' }, admin, policy);
        expect(`${c.text} ${c.action?.label ?? ''}`).not.toMatch(/turn (it )?on|is off|off for/i);
        expect(c.action?.href).not.toBe('/app/settings/ai');
      }
    }
  });

  it('a missing key: admins get the fix, members get who to ask', () => {
    expect(chatStatusCopy({ available: false, reason: 'no_key' }, { kind: 'none' }, true, 'team').text)
      .toBe('Connect a provider below to start interactive AI');
    expect(chatStatusCopy({ available: false, reason: 'no_key' }, { kind: 'none' }, false, 'team').text)
      .toBe('Interactive AI starts once an admin connects a provider');
  });

  it('under "each person\'s own key", points a person at their Profile', () => {
    const c = chatStatusCopy({ available: false, reason: 'no_key' }, { kind: 'needs_own' }, false, 'own');
    expect(c.text).toBe('Each person uses their own key. Add yours.');
    expect(c.action).toEqual({ href: '/app/settings/account', label: 'Add your key' });
  });

  it('never calls it chat', () => {
    const all = [
      chatStatusCopy({ available: true, reason: null }, { kind: 'team', provider: 'openrouter' }, true, 'team'),
      chatStatusCopy({ available: false, reason: 'no_key' }, { kind: 'none' }, true, 'team'),
      chatStatusCopy({ available: false, reason: 'no_key' }, { kind: 'needs_own' }, false, 'own'),
    ];
    for (const c of all) expect(`${c.text} ${c.action?.label ?? ''}`.toLowerCase()).not.toContain('chat');
  });

  it('never uses an em dash', () => {
    const all = [
      chatStatusCopy({ available: true, reason: null }, { kind: 'own', provider: 'anthropic' }, false, 'team_or_own'),
      chatStatusCopy({ available: false, reason: 'no_key' }, { kind: 'none' }, false, 'team'),
    ];
    for (const c of all) expect(c.text).not.toContain('—');
  });
});
