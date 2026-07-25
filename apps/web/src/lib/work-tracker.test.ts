import { describe, it, expect, mock } from 'bun:test';
import { parseGitHubIssueUrl, parseLinearUrl, getConnectorAccessToken, fetchLinearProgress } from './work-tracker';

describe('parseGitHubIssueUrl', () => {
  it('parses a standard GitHub issue URL', () => {
    expect(parseGitHubIssueUrl('https://github.com/acme/widgets/issues/42')).toEqual({
      owner: 'acme',
      repo: 'widgets',
      number: 42,
    });
  });

  it('ignores trailing path/query segments', () => {
    expect(parseGitHubIssueUrl('https://github.com/acme/widgets/issues/7#issuecomment-1')).toEqual({
      owner: 'acme',
      repo: 'widgets',
      number: 7,
    });
  });

  it('returns null for a pull-request URL (not an issue)', () => {
    expect(parseGitHubIssueUrl('https://github.com/acme/widgets/pull/42')).toBeNull();
  });

  it('returns null for a non-GitHub / Linear URL', () => {
    expect(parseGitHubIssueUrl('https://linear.app/acme/issue/ACM-42')).toBeNull();
  });

  it('returns null for null/empty input', () => {
    expect(parseGitHubIssueUrl(null)).toBeNull();
    expect(parseGitHubIssueUrl('')).toBeNull();
  });
});

describe('parseLinearUrl', () => {
  it('parses a Linear issue URL to its identifier (uppercased)', () => {
    expect(parseLinearUrl('https://linear.app/acme/issue/acm-42/fix-bug')).toEqual({
      type: 'issue',
      externalId: 'ACM-42',
    });
  });

  it('parses a Linear project URL to its trailing slug segment', () => {
    expect(parseLinearUrl('https://linear.app/acme/project/mobile-app-9f8e7d6c')).toEqual({
      type: 'project',
      externalId: 'mobile-app-9f8e7d6c',
    });
  });

  it('is deterministic — same URL yields the same id', () => {
    const url = 'https://linear.app/acme/project/mobile-app-9f8e7d6c';
    expect(parseLinearUrl(url)).toEqual(parseLinearUrl(url));
  });

  it('returns null for a non-Linear URL and for junk', () => {
    expect(parseLinearUrl('https://github.com/acme/widgets/issues/42')).toBeNull();
    expect(parseLinearUrl('not a url')).toBeNull();
    expect(parseLinearUrl(null)).toBeNull();
  });
});

describe('getConnectorAccessToken — refresh wiring', () => {
  const TEAM = 'team-1';
  const CONN = 'conn-1';

  // decrypt is identity in tests: the stored encryptedValue IS the plaintext blob.
  const identityDecrypt = (v: string) => v;
  const blob = (accessToken: string) => JSON.stringify({ access_token: accessToken });

  /** Fake db whose secrets.findFirst returns each queued row in turn (last one sticks). */
  function fakeDb(rows: any[]) {
    let i = 0;
    return {
      query: {
        secrets: {
          findFirst: async () => rows[Math.min(i++, rows.length - 1)] ?? null,
        },
      },
    } as any;
  }

  it('does NOT refresh a token that is comfortably in the future', async () => {
    const refresh = mock(async () => 'refreshed' as const);
    const db = fakeDb([{ id: 's1', tokenExpiresAt: new Date(Date.now() + 3_600_000), encryptedValue: blob('live') }]);
    const token = await getConnectorAccessToken(CONN, TEAM, { db, refresh, decrypt: identityDecrypt });
    expect(refresh).not.toHaveBeenCalled();
    expect(token).toBe('live');
  });

  it('refreshes proactively when the token has no expiry and returns the new token', async () => {
    const refresh = mock(async () => 'refreshed' as const);
    const db = fakeDb([
      { id: 's1', tokenExpiresAt: null, encryptedValue: blob('old') },
      { id: 's1', tokenExpiresAt: new Date(Date.now() + 3_600_000), encryptedValue: blob('fresh') },
    ]);
    const token = await getConnectorAccessToken(CONN, TEAM, { db, refresh, decrypt: identityDecrypt });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(token).toBe('fresh');
  });

  it('returns null when the refresher reports the credential is expired/dead', async () => {
    const refresh = mock(async () => 'expired' as const);
    const db = fakeDb([{ id: 's1', tokenExpiresAt: new Date(Date.now() - 1000), encryptedValue: blob('dead') }]);
    const token = await getConnectorAccessToken(CONN, TEAM, { db, refresh, decrypt: identityDecrypt });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(token).toBeNull();
  });

  it("on 'locked' returns the current token when it is still valid by the real clock", async () => {
    const refresh = mock(async () => 'locked' as const);
    // Within the 60s skew (→ triggers refresh) but not yet past → still usable.
    const db = fakeDb([{ id: 's1', tokenExpiresAt: new Date(Date.now() + 30_000), encryptedValue: blob('current') }]);
    const token = await getConnectorAccessToken(CONN, TEAM, { db, refresh, decrypt: identityDecrypt });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(token).toBe('current');
  });

  it("on 'locked' returns null when the current token is already past expiry", async () => {
    const refresh = mock(async () => 'locked' as const);
    const db = fakeDb([{ id: 's1', tokenExpiresAt: new Date(Date.now() - 1000), encryptedValue: blob('current') }]);
    const token = await getConnectorAccessToken(CONN, TEAM, { db, refresh, decrypt: identityDecrypt });
    expect(token).toBeNull();
  });

  it("on 'skipped' (header auth) returns the existing token unchanged", async () => {
    const refresh = mock(async () => 'skipped' as const);
    const db = fakeDb([{ id: 's1', tokenExpiresAt: null, encryptedValue: 'raw-header-token' }]);
    const token = await getConnectorAccessToken(CONN, TEAM, { db, refresh, decrypt: identityDecrypt });
    expect(token).toBe('raw-header-token');
  });

  it('returns null when no secret row exists (never calls the refresher)', async () => {
    const refresh = mock(async () => 'refreshed' as const);
    const db = fakeDb([null]);
    const token = await getConnectorAccessToken(CONN, TEAM, { db, refresh, decrypt: identityDecrypt });
    expect(refresh).not.toHaveBeenCalled();
    expect(token).toBeNull();
  });
});

describe('fetchLinearProgress', () => {
  const opts = (kind: 'project' | 'issue', externalId = 'x') => ({
    connectorId: 'conn-1',
    teamId: 'team-1',
    externalId,
    kind,
  });
  const goodToken = mock(async () => 'live-token');

  it('project happy path: progress 0.4 → percent 40, name/state passed through', async () => {
    const graphql = mock(async () => ({
      data: { project: { name: 'Mobile App', progress: 0.4, state: 'started' } },
    }));
    const result = await fetchLinearProgress(opts('project'), { getToken: goodToken, graphql });
    expect(result).toEqual({ title: 'Mobile App', percent: 40, state: 'started' });
  });

  it('project rounds fractional progress (0.666 → 67)', async () => {
    const graphql = mock(async () => ({
      data: { project: { name: 'P', progress: 0.666, state: null } },
    }));
    const result = await fetchLinearProgress(opts('project'), { getToken: goodToken, graphql });
    expect(result).toEqual({ title: 'P', percent: 67, state: null });
  });

  it('issue happy path: title + state.name, percent always null', async () => {
    const graphql = mock(async () => ({
      data: { issue: { identifier: 'ACM-42', title: 'Fix the bug', state: { name: 'In Progress' } } },
    }));
    const result = await fetchLinearProgress(opts('issue', 'ACM-42'), { getToken: goodToken, graphql });
    expect(result).toEqual({ title: 'Fix the bug', percent: null, state: 'In Progress' });
  });

  it('issue falls back to identifier when title is absent', async () => {
    const graphql = mock(async () => ({
      data: { issue: { identifier: 'ACM-7', title: null, state: null } },
    }));
    const result = await fetchLinearProgress(opts('issue', 'ACM-7'), { getToken: goodToken, graphql });
    expect(result).toEqual({ title: 'ACM-7', percent: null, state: null });
  });

  it('returns null when there is no token (never calls graphql)', async () => {
    const noToken = mock(async () => null);
    const graphql = mock(async () => ({ data: {} }));
    const result = await fetchLinearProgress(opts('project'), { getToken: noToken, graphql });
    expect(result).toBeNull();
    expect(graphql).not.toHaveBeenCalled();
  });

  it('returns null on a GraphQL null response (network/error)', async () => {
    const graphql = mock(async () => null);
    const result = await fetchLinearProgress(opts('project'), { getToken: goodToken, graphql });
    expect(result).toBeNull();
  });

  it('returns null when the entity is missing from the response', async () => {
    const graphql = mock(async () => ({ data: { project: null } }));
    const result = await fetchLinearProgress(opts('project'), { getToken: goodToken, graphql });
    expect(result).toBeNull();
  });

  it('never throws — a throwing graphql yields null', async () => {
    const graphql = mock(async () => {
      throw new Error('boom');
    });
    const result = await fetchLinearProgress(opts('issue'), { getToken: goodToken, graphql });
    expect(result).toBeNull();
  });

  it('nulls percent when progress is not a number', async () => {
    const graphql = mock(async () => ({ data: { project: { name: 'P', progress: null, state: 'planned' } } }));
    const result = await fetchLinearProgress(opts('project'), { getToken: goodToken, graphql });
    expect(result).toEqual({ title: 'P', percent: null, state: 'planned' });
  });
});
