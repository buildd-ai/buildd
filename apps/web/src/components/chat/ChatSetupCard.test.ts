import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ChatSetupCard, { chatSetupCopy } from './ChatSetupCard';

describe('ChatSetupCard', () => {
  it('the title is a heading on the kit card, the body under it, the fix as a link', () => {
    const html = renderToStaticMarkup(createElement(ChatSetupCard, { reason: 'no_key', canManage: true }));
    expect(html).toMatch(/<h3[^>]*data-testid="kit-setup-title"[^>]*>Connect a model provider<\/h3><p class="kit-note">Chat is where/);
    expect(html).toContain('href="/app/settings/providers"');
  });
});

describe('chatSetupCopy', () => {
  it('admin, no key: connect a provider (not "turn on chat")', () => {
    const c = chatSetupCopy('no_key', true);
    expect(c.title).toBe('Connect a model provider');
    expect(c.cta).toEqual({ href: '/app/settings/providers', label: 'Connect a provider' });
  });

  it('owner or admin under the own-key policy: add your own key too', () => {
    expect(chatSetupCopy('no_key', true, 'own').cta?.href).toBe('/app/settings/account');
  });

  it('never offers an enable step: chat is always on', () => {
    for (const admin of [true, false]) {
      for (const policy of ['team', 'team_or_own', 'own'] as const) {
        const c = chatSetupCopy('no_key', admin, policy);
        const all = `${c.title} ${c.body} ${c.cta?.label ?? ''} ${c.secondary?.label ?? ''}`;
        expect(all).not.toMatch(/turn (chat )?on|turn on chat|switched (it )?off|chat is off/i);
        expect(c.cta?.href).not.toBe('/app/settings/ai');
      }
    }
  });

  it('member, team key policy: who to ask, no settings trip', () => {
    const c = chatSetupCopy('no_key', false);
    expect(c.body).toContain('Ask a team admin');
    expect(c.cta).toBeNull();
  });

  it('member, everyone brings their own key: add yours', () => {
    const c = chatSetupCopy('no_key', false, 'own');
    expect(c.title).toBe('Add your key to use chat');
    expect(c.cta?.href).toBe('/app/settings/account');
  });

  it('no em dashes', () => {
    for (const admin of [true, false]) {
      const c = chatSetupCopy('no_key', admin);
      expect(`${c.title} ${c.body}`).not.toContain('—');
    }
  });
});
