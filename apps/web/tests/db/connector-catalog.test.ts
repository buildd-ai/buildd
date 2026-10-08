/**
 * Connector catalog uniqueness, against real Postgres. The create routes rely
 * on the two partial unique indexes (ON CONFLICT DO NOTHING → 409), so a mocked
 * db cannot show them: one platform row per slug (team_id NULL), one row per
 * slug per team, and a team may reuse a platform slug to override it.
 * Contract: docs/specs/mcp-connectors-and-roles.md §5b.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { db } from '@buildd/core/db';
import { connectorCatalogEntries, connectorCatalogTeamPolicies } from '@buildd/core/db/schema';
import { loadTeamCatalog } from '@/lib/connector-catalog-store';
import { assertDbConfigured, seedWorkspace } from './harness';

let teamId: string;
let otherTeamId: string;
const slug = `qa-${Math.random().toString(36).slice(2, 10)}`;
const entry = (over: Partial<typeof connectorCatalogEntries.$inferInsert> = {}) => ({
  slug, name: 'QA Server', url: 'https://mcp.qa.example/mcp', ...over,
});
const insert = async (v: typeof connectorCatalogEntries.$inferInsert) =>
  (await db.insert(connectorCatalogEntries).values(v).onConflictDoNothing().returning()).length;

beforeAll(async () => {
  assertDbConfigured();
  ({ teamId } = await seedWorkspace());
  ({ teamId: otherTeamId } = await seedWorkspace());
});

describe('connector_catalog_entries uniqueness', () => {
  test('one platform row per slug', async () => {
    expect(await insert(entry({ teamId: null }))).toBe(1);
    expect(await insert(entry({ teamId: null, name: 'dup' }))).toBe(0);
  });

  test('one row per slug per team, independent across teams and of the platform row', async () => {
    expect(await insert(entry({ teamId, name: 'Ours' }))).toBe(1);
    expect(await insert(entry({ teamId, name: 'Ours again' }))).toBe(0);
    expect(await insert(entry({ teamId: otherTeamId, name: 'Theirs' }))).toBe(1);
  });

  test('loadTeamCatalog: the team row overrides the platform row; the policy attaches by slug', async () => {
    await db.insert(connectorCatalogTeamPolicies).values({ teamId, slug, policy: 'blocked' });
    const mine = (await loadTeamCatalog(teamId)).find(e => e.slug === slug);
    expect(mine).toMatchObject({ source: 'team', name: 'Ours', policy: 'blocked' });
    const theirs = (await loadTeamCatalog(otherTeamId)).find(e => e.slug === slug);
    expect(theirs).toMatchObject({ source: 'team', name: 'Theirs', policy: 'available' });
  });
});
