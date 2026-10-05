import { describe, expect, it } from 'bun:test';
import { chatKeyLine, ownKeyProviders } from './chat-key-line';

describe('chatKeyLine: the one Account row about chat', () => {
  it('names the provider and whose key, nothing more', () => {
    expect(chatKeyLine({ kind: 'team', provider: 'openrouter' }, { isAdmin: false }))
      .toEqual({ text: 'OpenRouter · team key', action: null });
    expect(chatKeyLine({ kind: 'own', provider: 'anthropic' }, { isAdmin: false }).text)
      .toBe('Anthropic · your key');
  });

  it('reports the actual provider for every route, not OpenRouter', () => {
    expect(chatKeyLine({ kind: 'team', provider: 'anthropic' }, { isAdmin: false }).text).toBe('Anthropic · team key');
    expect(chatKeyLine({ kind: 'team', provider: 'openai' }, { isAdmin: false }).text).toBe('OpenAI · team key');
    expect(chatKeyLine({ kind: 'own', provider: 'openai' }, { isAdmin: false }).text).toBe('OpenAI · your key');
  });

  it('says which scope pays: workspace, the deployment, or a gateway', () => {
    expect(chatKeyLine({ kind: 'team', provider: 'openai', scope: 'workspace' }, { isAdmin: false }).text).toBe('OpenAI · workspace key');
    expect(chatKeyLine({ kind: 'team', provider: 'anthropic', scope: 'server' }, { isAdmin: false }).text).toBe('Anthropic · buildd key');
    expect(chatKeyLine({ kind: 'team', provider: 'anthropic', via: 'litellm' }, { isAdmin: false }).text).toBe('Anthropic via LiteLLM gateway · team key');
  });

  it('with no team key: members learn who to ask, admins get the fix', () => {
    expect(chatKeyLine({ kind: 'none' }, { isAdmin: false }))
      .toEqual({ text: 'Not set up yet · ask an admin', action: null });
    expect(chatKeyLine({ kind: 'none' }, { isAdmin: true }))
      .toEqual({ text: 'Not set up yet', action: { href: '/app/settings/providers', label: 'Set it up' } });
  });

  it('when everyone brings their own key, names the one provider on offer, or none when several are', () => {
    expect(chatKeyLine({ kind: 'needs_own' }, { isAdmin: false, offered: ['anthropic'] }).text).toBe('Add your Anthropic key');
    expect(chatKeyLine({ kind: 'needs_own' }, { isAdmin: false, offered: ['openai'] }).text).toBe('Add your OpenAI key');
    expect(chatKeyLine({ kind: 'needs_own' }, { isAdmin: false, offered: ['openrouter', 'openai'] }).text).toBe('Add your own key');
    expect(chatKeyLine({ kind: 'needs_own' }, { isAdmin: false }).text).toBe('Add your own key');
  });

  it('never says it is off or offers to turn it on: chat is always on', () => {
    for (const isAdmin of [true, false]) {
      for (const key of [{ kind: 'team', provider: 'openrouter' }, { kind: 'none' }, { kind: 'needs_own' }] as const) {
        const l = chatKeyLine(key, { isAdmin });
        expect(`${l.text} ${l.action?.label ?? ''}`).not.toMatch(/off for|turn it on/i);
      }
    }
  });
});

describe('ownKeyProviders: the team-enabled providers that take personal keys', () => {
  const p = (provider: string, team: boolean, mine: boolean) => ({ provider, team: team ? {} : null, mine: mine ? {} : null }) as never;
  const all = (overrides: Record<string, [boolean, boolean]>) =>
    ['openrouter', 'anthropic', 'openai'].map((id) => p(id, ...(overrides[id] ?? [false, false])));

  it('only Anthropic enabled: offers only Anthropic', () => {
    expect(ownKeyProviders(all({ anthropic: [true, false] }))).toEqual(['anthropic']);
  });

  it('only OpenAI enabled: offers only OpenAI', () => {
    expect(ownKeyProviders(all({ openai: [true, false] }))).toEqual(['openai']);
  });

  it('only OpenRouter enabled: offers only OpenRouter', () => {
    expect(ownKeyProviders(all({ openrouter: [true, false] }))).toEqual(['openrouter']);
  });

  it('several enabled: offers those, in display order', () => {
    expect(ownKeyProviders(all({ openai: [true, false], anthropic: [true, false] }))).toEqual(['anthropic', 'openai']);
    expect(ownKeyProviders(all({ openai: [true, false], openrouter: [true, false], anthropic: [true, false] })))
      .toEqual(['openrouter', 'anthropic', 'openai']);
  });

  it('keeps a provider you already hold a key for, so you can remove it', () => {
    expect(ownKeyProviders(all({ anthropic: [true, false], openai: [false, true] }))).toEqual(['anthropic', 'openai']);
  });

  it('no team key at all restricts nothing: every personal-key provider is offered', () => {
    expect(ownKeyProviders(all({}))).toEqual(['openrouter', 'anthropic', 'openai']);
  });

  it('excludes a provider whose route takes no personal keys, even when the team enabled it', () => {
    expect(ownKeyProviders([...all({ anthropic: [true, false] }), p('litellm', true, false)])).toEqual(['anthropic']);
    expect(ownKeyProviders([p('litellm', true, false), ...all({})])).toEqual(['openrouter', 'anthropic', 'openai']);
  });
});
