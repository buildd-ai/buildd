import { describe, expect, it } from 'bun:test';
import { chatKeyLine, ownKeyProviders } from './chat-key-line';

describe('chatKeyLine: the one Account row about chat', () => {
  it('names the provider and whose key, nothing more', () => {
    expect(chatKeyLine({ kind: 'team', provider: 'openrouter' }, { isAdmin: false, chatDisabled: false }))
      .toEqual({ text: 'OpenRouter · team key', action: null });
    expect(chatKeyLine({ kind: 'own', provider: 'anthropic' }, { isAdmin: false, chatDisabled: false }).text)
      .toBe('Anthropic · your key');
  });

  it('with no team key: members learn who to ask, admins get the fix', () => {
    expect(chatKeyLine({ kind: 'none' }, { isAdmin: false, chatDisabled: false }))
      .toEqual({ text: 'Not set up yet · ask an admin', action: null });
    expect(chatKeyLine({ kind: 'none' }, { isAdmin: true, chatDisabled: false }))
      .toEqual({ text: 'Not set up yet', action: { href: '/app/settings/providers', label: 'Set it up' } });
  });

  it('when everyone brings their own key, asks for yours', () => {
    expect(chatKeyLine({ kind: 'needs_own' }, { isAdmin: false, chatDisabled: false }).text)
      .toBe('Add your OpenRouter key to use chat');
  });

  it('says so when an admin switched chat off', () => {
    expect(chatKeyLine({ kind: 'team', provider: 'openrouter' }, { isAdmin: false, chatDisabled: true }).text)
      .toBe('Off for this team');
  });
});

describe('ownKeyProviders', () => {
  const p = (provider: string, team: boolean, mine: boolean) => ({ provider, team: team ? {} : null, mine: mine ? {} : null }) as never;

  it('offers only providers the team routes chat through, OpenRouter first', () => {
    expect(ownKeyProviders([p('openrouter', false, false), p('anthropic', true, false), p('openai', false, false)]))
      .toEqual(['openrouter', 'anthropic']);
  });

  it('keeps a provider you already hold a key for', () => {
    expect(ownKeyProviders([p('openrouter', false, false), p('anthropic', false, false), p('openai', false, true)]))
      .toEqual(['openrouter', 'openai']);
  });
});
