import { describe, it, expect } from 'bun:test';
import { isDependencyBotAuthor, isDependencyBotPrContext } from './dependency-bot-pr';

describe('isDependencyBotAuthor', () => {
  it.each(['renovate[bot]', 'dependabot[bot]', 'Renovate[bot]'])('is true for %s', (login) => {
    expect(isDependencyBotAuthor({ login, type: 'Bot' })).toBe(true);
  });

  it('is false for bots that open PRs buildd should own (release PRs, Actions)', () => {
    expect(isDependencyBotAuthor({ login: 'buildd-ai[bot]', type: 'Bot' })).toBe(false);
    expect(isDependencyBotAuthor({ login: 'github-actions[bot]', type: 'Bot' })).toBe(false);
  });

  it('is false for a human, and for a user whose name merely resembles the bot', () => {
    expect(isDependencyBotAuthor({ login: 'maintainer', type: 'User' })).toBe(false);
    expect(isDependencyBotAuthor({ login: 'renovate', type: 'User' })).toBe(false);
  });

  it('refuses a matching login whose type says it is not a bot', () => {
    expect(isDependencyBotAuthor({ login: 'renovate[bot]', type: 'User' })).toBe(false);
  });

  it('accepts a matching login with no type (older adoption rows stored only the login)', () => {
    expect(isDependencyBotAuthor({ login: 'renovate[bot]' })).toBe(true);
  });

  it('is false with no author', () => {
    expect(isDependencyBotAuthor(null)).toBe(false);
    expect(isDependencyBotAuthor({})).toBe(false);
  });
});

describe('isDependencyBotPrContext', () => {
  it('reads the adoption stamp', () => {
    expect(isDependencyBotPrContext({ adoptedPr: { author: 'dependabot[bot]', authorType: 'Bot' } })).toBe(true);
    expect(isDependencyBotPrContext({ adoptedPr: { author: 'renovate[bot]' } })).toBe(true);
  });

  it('is false for a human-authored adoption and for a task buildd opened itself', () => {
    expect(isDependencyBotPrContext({ adoptedPr: { author: 'maintainer', authorType: 'User' } })).toBe(false);
    expect(isDependencyBotPrContext({ iteration: 1 })).toBe(false);
    expect(isDependencyBotPrContext(null)).toBe(false);
  });
});
