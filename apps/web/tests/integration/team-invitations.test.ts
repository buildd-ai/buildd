/**
 * Integration Tests: Team routes with an API key
 *
 * An API key acts as its own account, scoped to its own team. It can read that
 * team (list, detail, members); team administration — creating, updating or
 * deleting teams, changing members and roles, managing invitations — requires a
 * signed-in session and is refused for every key level.
 *
 * The full invitation / member-management lifecycle is session-driven and is
 * covered by the co-located route tests (apps/web/src/app/api/teams/**).
 *
 * Prerequisites:
 *   - BUILDD_TEST_SERVER set (preview or local URL)
 *   - BUILDD_API_KEY set (or in ~/.buildd/config.json)
 *
 * Usage:
 *   bun test apps/web/tests/integration/team-invitations.test.ts
 */

import { describe, test, beforeAll, expect } from 'bun:test';
import { requireTestEnv, createTestApi } from '../../../../tests/test-utils';

const TIMEOUT = 30_000;

const { server: SERVER, apiKey: API_KEY } = requireTestEnv();
const { api, apiRaw } = createTestApi(SERVER, API_KEY);

const TEST_PREFIX = `inttest-${Date.now()}`;

describe('Team routes — API key access', () => {
  let keyTeamId: string;

  beforeAll(async () => {
    const { teams } = await api('/api/teams');
    expect(Array.isArray(teams)).toBe(true);
    expect(teams.length).toBe(1);
    keyTeamId = teams[0].id;
  }, TIMEOUT);

  test('list teams — returns only the key team, with no user role', async () => {
    const { teams } = await api('/api/teams');
    expect(teams).toHaveLength(1);
    expect(teams[0].id).toBe(keyTeamId);
    expect(teams[0].role).toBeNull();
    expect(teams[0].memberCount).toBeGreaterThanOrEqual(1);
  }, TIMEOUT);

  test('get team — returns the key team and its members', async () => {
    const details = await api(`/api/teams/${keyTeamId}`);
    expect(details.team.id).toBe(keyTeamId);
    expect(details.currentUserRole).toBeNull();
    expect(details.members.length).toBeGreaterThanOrEqual(1);
  }, TIMEOUT);

  test('list members — works for the key team', async () => {
    const { members } = await api(`/api/teams/${keyTeamId}/members`);
    expect(members.length).toBeGreaterThanOrEqual(1);
  }, TIMEOUT);

  test('create team — requires a signed-in session', async () => {
    const { status, body } = await apiRaw('/api/teams', {
      method: 'POST',
      body: JSON.stringify({ name: 'Key Team', slug: `${TEST_PREFIX}-key` }),
    });
    expect(status).toBe(403);
    expect(body.error).toContain('signed-in session');
  }, TIMEOUT);

  test('update team — requires a signed-in session', async () => {
    const { status } = await apiRaw(`/api/teams/${keyTeamId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Renamed by key' }),
    });
    expect(status).toBe(403);
  }, TIMEOUT);

  test('delete team — requires a signed-in session', async () => {
    const { status } = await apiRaw(`/api/teams/${keyTeamId}`, { method: 'DELETE' });
    expect(status).toBe(403);
  }, TIMEOUT);

  test('add member — requires a signed-in session', async () => {
    const { status } = await apiRaw(`/api/teams/${keyTeamId}/members`, {
      method: 'POST',
      body: JSON.stringify({ email: `${TEST_PREFIX}@example.test`, role: 'member' }),
    });
    expect(status).toBe(403);
  }, TIMEOUT);

  test('invitations — require a signed-in session', async () => {
    const list = await apiRaw(`/api/teams/${keyTeamId}/invitations`);
    expect(list.status).toBe(403);

    const create = await apiRaw(`/api/teams/${keyTeamId}/invitations`, {
      method: 'POST',
      body: JSON.stringify({ email: `${TEST_PREFIX}@example.test`, role: 'member' }),
    });
    expect(create.status).toBe(403);
  }, TIMEOUT);
});
