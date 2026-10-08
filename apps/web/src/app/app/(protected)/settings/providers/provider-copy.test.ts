import { describe, expect, it } from 'bun:test';
import { PROVIDERS_DESCRIPTION, chatStatusCopy, choiceFromPolicy, policyFromChoice } from './provider-copy';

const OK = { available: true, reason: null } as const;
const NO = { available: false, reason: 'no_key' } as const;
const team = (...providers: ('anthropic' | 'openai' | 'openrouter')[]) =>
  ({ kind: 'keys', keys: providers.map((provider) => ({ provider, whose: 'team' as const })) }) as const;

describe('key policy choice', () => {
  it('round-trips the two-control form to the stored policy', () => {
    expect(policyFromChoice({ mode: 'team', allowOwn: false })).toBe('team');
    expect(policyFromChoice({ mode: 'team', allowOwn: true })).toBe('team_or_own');
    expect(policyFromChoice({ mode: 'own', allowOwn: false })).toBe('own');
    expect(policyFromChoice({ mode: 'own', allowOwn: true })).toBe('own');
    for (const p of ['team', 'team_or_own', 'own'] as const) expect(policyFromChoice(choiceFromPolicy(p))).toBe(p);
  });
});

describe('PROVIDERS_DESCRIPTION', () => {
  it('names every provider and recommends none of them', () => {
    for (const label of ['Anthropic', 'OpenAI', 'OpenRouter']) expect(PROVIDERS_DESCRIPTION).toContain(label);
    expect(PROVIDERS_DESCRIPTION).not.toMatch(/every model tier with one key|recommended/i);
  });
});

describe('chatStatusCopy', () => {
  it('says what chat uses, as a status, not an on/off state', () => {
    expect(chatStatusCopy(OK, team('anthropic'), true, 'team'))
      .toMatchObject({ tone: 'success', text: 'Chat uses: Anthropic · team key', action: null });
    expect(chatStatusCopy(OK, { kind: 'keys', keys: [{ provider: 'openrouter', whose: 'own' }] }, false, 'team_or_own').text)
      .toBe('Chat uses: OpenRouter · your key');
  });

  it('names every configured provider, so a mixed team is not reported as OpenRouter-only', () => {
    expect(chatStatusCopy(OK, team('openrouter', 'anthropic', 'openai'), true, 'team').text)
      .toBe('Chat uses: OpenRouter, Anthropic, OpenAI · team keys');
    expect(chatStatusCopy(OK, team('openai'), true, 'team').text).toBe('Chat uses: OpenAI · team key');
    expect(chatStatusCopy(OK, {
      kind: 'keys', keys: [{ provider: 'anthropic', whose: 'own' }, { provider: 'openai', whose: 'team' }],
    }, false, 'team_or_own').text).toBe('Chat uses: Anthropic · your key; OpenAI · team key');
  });

  it('keys that cannot serve the default model are not reported as "needs a key"', () => {
    const admin = chatStatusCopy(NO, team('openai'), true, 'team');
    expect(admin.tone).toBe('warning');
    expect(admin.text).not.toMatch(/needs a key\. Add one/);
    expect(admin.text).toContain('OpenAI');
    expect(admin.action).toEqual({ href: '/app/settings/models', label: 'Choose models' });
    const member = chatStatusCopy(NO, team('openai'), false, 'team');
    expect(member.text).toMatch(/Ask an admin\.$/);
    expect(member.action).toBeNull();
  });

  it('never offers a switch to turn it on: the only unavailable reason is a missing key', () => {
    for (const admin of [true, false]) {
      for (const policy of ['team', 'team_or_own', 'own'] as const) {
        const c = chatStatusCopy(NO, { kind: 'none' }, admin, policy);
        expect(`${c.text} ${c.action?.label ?? ''}`).not.toMatch(/turn (it )?on|is off|off for/i);
        expect(c.action?.href).not.toBe('/app/settings/ai');
      }
    }
  });

  it('a missing key: admins get the fix, members get who to ask', () => {
    expect(chatStatusCopy(NO, { kind: 'none' }, true, 'team').text).toBe('Chat needs a key. Add one below.');
    expect(chatStatusCopy(NO, { kind: 'none' }, false, 'team').text).toBe('Chat needs a key. Ask an admin.');
  });

  it('under "each person\'s own key", points a person at their Profile', () => {
    const c = chatStatusCopy(NO, { kind: 'needs_own' }, false, 'own');
    expect(c.text).toBe('Chat needs your own key.');
    expect(c.action).toEqual({ href: '/app/settings/account', label: 'Add your key' });
  });

  it('never implies a switch, and never assumes OpenRouter', () => {
    const all = [
      chatStatusCopy(OK, team('anthropic'), true, 'team'),
      chatStatusCopy(OK, { kind: 'none' }, true, 'team'),
      chatStatusCopy(NO, team('anthropic', 'openai'), true, 'team'),
      chatStatusCopy(NO, { kind: 'none' }, true, 'team'),
      chatStatusCopy(NO, { kind: 'needs_own' }, false, 'own'),
    ];
    for (const c of all) {
      expect(`${c.text} ${c.action?.label ?? ''}`).not.toMatch(/\bis (on|off)\b|enable|interactive ai/i);
      expect(c.text).not.toContain('OpenRouter');
    }
  });

  it('never uses an em dash', () => {
    const all = [
      chatStatusCopy(OK, { kind: 'keys', keys: [{ provider: 'anthropic', whose: 'own' }] }, false, 'team_or_own'),
      chatStatusCopy(NO, team('openai'), true, 'team'),
      chatStatusCopy(NO, { kind: 'none' }, false, 'team'),
    ];
    for (const c of all) expect(c.text).not.toContain('—');
  });
});
