import { describe, expect, it } from 'bun:test';
import { rankPrComments, MAX_COMMENTS_RETURNED, MAX_COMMENT_BODY_CHARS } from './pr-comments';

const BOT_LOGIN = 'buildd[bot]';

describe('rankPrComments', () => {
  it('ranks buildd-authored comments above human comments and other bots', () => {
    const raw = [
      { id: 1, user: { login: 'github-actions[bot]', type: 'Bot' }, body: 'CI run started', created_at: '2026-01-01T00:00:00Z' },
      { id: 2, user: { login: 'alice', type: 'User' }, body: 'looks good to me', created_at: '2026-01-02T00:00:00Z' },
      { id: 3, user: { login: BOT_LOGIN, type: 'Bot' }, body: 'Reviewer approved these changes.', created_at: '2026-01-03T00:00:00Z' },
    ];

    const result = rankPrComments(raw, BOT_LOGIN);

    expect(result.items.map(i => i.kind)).toEqual(['buildd', 'human', 'bot']);
    expect(result.items[0]!.author).toBe(BOT_LOGIN);
    expect(result.total).toBe(3);
    expect(result.omitted).toBe(0);
  });

  it('caps at MAX_COMMENTS_RETURNED and reports the omitted count', () => {
    const raw = Array.from({ length: MAX_COMMENTS_RETURNED + 4 }, (_, i) => ({
      id: i,
      user: { login: 'alice', type: 'User' },
      body: `comment ${i}`,
      created_at: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    }));

    const result = rankPrComments(raw, BOT_LOGIN);

    expect(result.items.length).toBe(MAX_COMMENTS_RETURNED);
    expect(result.total).toBe(MAX_COMMENTS_RETURNED + 4);
    expect(result.omitted).toBe(4);
  });

  it('drops noise (bot tier) first when the cap is exceeded, keeping every buildd comment', () => {
    const buildd = Array.from({ length: 3 }, (_, i) => ({
      id: 100 + i,
      user: { login: BOT_LOGIN, type: 'Bot' },
      body: `buildd decision ${i}`,
      created_at: `2026-02-0${i + 1}T00:00:00Z`,
    }));
    const otherBots = Array.from({ length: MAX_COMMENTS_RETURNED + 5 }, (_, i) => ({
      id: 200 + i,
      user: { login: 'dependabot[bot]', type: 'Bot' },
      body: `bump dependency ${i}`,
      created_at: `2026-03-0${(i % 9) + 1}T00:00:00Z`,
    }));

    const result = rankPrComments([...otherBots, ...buildd], BOT_LOGIN);

    expect(result.items.filter(i => i.kind === 'buildd').length).toBe(3);
    expect(result.items.every((item, idx) => idx === 0 || TIER_RANK(item.kind) >= TIER_RANK(result.items[idx - 1]!.kind))).toBe(true);
    expect(result.omitted).toBeGreaterThan(0);
  });

  it('truncates an oversized comment body through the shared marker', () => {
    const longBody = 'x'.repeat(MAX_COMMENT_BODY_CHARS + 250);
    const result = rankPrComments(
      [{ id: 1, user: { login: 'alice', type: 'User' }, body: longBody, created_at: '2026-01-01T00:00:00Z' }],
      BOT_LOGIN,
    );

    expect(result.items[0]!.body).toContain(`…[truncated 250 chars]`);
    expect(result.items[0]!.body.length).toBeLessThan(longBody.length);
  });

  it('drops comments with an empty or missing body and never crashes on zero comments', () => {
    const result = rankPrComments(
      [
        { id: 1, user: { login: 'alice' }, body: '   ', created_at: '2026-01-01T00:00:00Z' },
        { id: 2, user: { login: 'bob' }, body: null, created_at: '2026-01-01T00:00:00Z' },
      ],
      BOT_LOGIN,
    );
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.omitted).toBe(0);

    const empty = rankPrComments([], BOT_LOGIN);
    expect(empty).toEqual({ items: [], total: 0, omitted: 0 });
  });

  it('matches the bot login case-insensitively', () => {
    const result = rankPrComments(
      [{ id: 1, user: { login: 'BUILDD[BOT]', type: 'Bot' }, body: 'activity update', created_at: '2026-01-01T00:00:00Z' }],
      BOT_LOGIN,
    );
    expect(result.items[0]!.kind).toBe('buildd');
  });
});

function TIER_RANK(kind: string): number {
  return kind === 'buildd' ? 0 : kind === 'human' ? 1 : 2;
}
