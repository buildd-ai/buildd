import { describe, it, expect } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  DEPENDENCY_BOT_LOGINS,
  isDependencyBotAuthor,
  isDependencyBotPrContext,
  workerNotDependencyBotPr,
} from './dependency-bot-pr';

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

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

// Rendered through PgDialect, not asserted against a mocked `db`: a mocked db
// cannot see what the predicate actually scopes to.
describe('workerNotDependencyBotPr', () => {
  it("excludes a worker whose task adopted a dependency-bot PR, matched on the stored login", () => {
    const q = new PgDialect().sqlToQuery(workerNotDependencyBotPr());
    const text = norm(q.sql);
    expect(text).toMatch(/^not exists \(select 1 from "tasks" "bot_pr_task" where/i);
    // Correlated to the outer worker's task...
    expect(text).toContain('"bot_pr_task"."id" = "workers"."task_id"');
    // ...and keyed on the adoption stamp's author, case-insensitively.
    expect(text).toContain(`lower("bot_pr_task"."context"->'adoptedPr'->>'author') in ($1, $2)`);
    expect(q.params).toEqual([...DEPENDENCY_BOT_LOGINS]);
  });
});
