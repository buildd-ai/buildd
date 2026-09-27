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
  it('says what chat uses, as a status, not an on/off state', () => {
    expect(chatStatusCopy({ available: true, reason: null }, { kind: 'team', provider: 'anthropic' }, true, 'team'))
      .toMatchObject({ tone: 'success', text: 'Chat uses: Anthropic · team key', action: null });
    expect(chatStatusCopy({ available: true, reason: null }, { kind: 'own', provider: 'openrouter' }, false, 'team_or_own').text)
      .toBe('Chat uses: OpenRouter · your key');
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
      .toBe('Chat needs a key. Add one below.');
    expect(chatStatusCopy({ available: false, reason: 'no_key' }, { kind: 'none' }, false, 'team').text)
      .toBe('Chat needs a key. Ask an admin.');
  });

  it('under "each person\'s own key", points a person at their Profile', () => {
    const c = chatStatusCopy({ available: false, reason: 'no_key' }, { kind: 'needs_own' }, false, 'own');
    expect(c.text).toBe('Chat needs your own key.');
    expect(c.action).toEqual({ href: '/app/settings/account', label: 'Add your key' });
  });

  it('never implies a switch: no "is on", "is off" or "enable"', () => {
    const all = [
      chatStatusCopy({ available: true, reason: null }, { kind: 'team', provider: 'openrouter' }, true, 'team'),
      chatStatusCopy({ available: false, reason: 'no_key' }, { kind: 'none' }, true, 'team'),
      chatStatusCopy({ available: false, reason: 'no_key' }, { kind: 'needs_own' }, false, 'own'),
    ];
    for (const c of all) expect(`${c.text} ${c.action?.label ?? ''}`).not.toMatch(/\bis (on|off)\b|enable|interactive ai/i);
  });

  it('never uses an em dash', () => {
    const all = [
      chatStatusCopy({ available: true, reason: null }, { kind: 'own', provider: 'anthropic' }, false, 'team_or_own'),
      chatStatusCopy({ available: false, reason: 'no_key' }, { kind: 'none' }, false, 'team'),
    ];
    for (const c of all) expect(c.text).not.toContain('—');
  });
});
