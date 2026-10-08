/**
 * Mission completion's kernel input (§17.3, Slice D): the ship-key, the one
 * statement that reads kernel-owned deliveries, and the degrade-to-columns path.
 */
import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { deliveryShipSql, deliveryShipsForPrs, shipKey } from './delivery-ship';

const dialect = new PgDialect();

describe('shipKey', () => {
  test('workspace + lowercased repo + PR number', () => {
    expect(shipKey('w1', 'https://github.com/Acme/Repo/pull/42')).toBe('w1:acme/repo#42');
  });
  test('no workspace or no PR number, no key', () => {
    expect(shipKey(null, 'https://github.com/acme/repo/pull/42')).toBeNull();
    expect(shipKey('w1', 'https://github.com/acme/repo')).toBeNull();
    expect(shipKey('w1', null)).toBeNull();
  });
});

describe('deliveryShipSql', () => {
  test('reads kernel-owned deliveries in kernel-enabled workspaces, keyed like shipKey', () => {
    const q = dialect.sqlToQuery(deliveryShipSql(['w1:acme/repo#42']));
    expect(q.sql).toContain('-- workflow:delivery_ship');
    expect(q.sql).toContain("d.authority = 'kernel'");
    expect(q.sql).toContain("COALESCE(w.git_config->>'workflowKernel', '') NOT IN ('false', 'off')");
    expect(q.sql).toContain("d.workspace_id || ':' || lower(d.repo_full_name) || '#' || d.pr_number AS ship_key");
    expect(q.sql).toContain('IN (SELECT jsonb_array_elements_text($1::jsonb))');
    expect(q.params).toEqual([JSON.stringify(['w1:acme/repo#42'])]);
  });
});

describe('deliveryShipsForPrs', () => {
  test('maps rows by ship key', async () => {
    const ships = await deliveryShipsForPrs(
      [{ workspaceId: 'w1', prUrl: 'https://github.com/acme/repo/pull/42' }],
      async () => ({
        rows: [{ ship_key: 'w1:acme/repo#42', state: 'SUPERSEDED', state_reason: null, superseded_by_pr: '43', superseded_by_url: 'https://github.com/acme/repo/pull/43', superseded_reason: 'landed elsewhere' }],
      }),
    );
    expect(ships.get('w1:acme/repo#42')).toEqual({
      state: 'SUPERSEDED',
      stateReason: null,
      supersededByPr: 43,
      supersededByUrl: 'https://github.com/acme/repo/pull/43',
      supersededReason: 'landed elsewhere',
    });
  });
  test('no keys, no query', async () => {
    let called = false;
    const ships = await deliveryShipsForPrs([{ workspaceId: null, prUrl: null }], async () => {
      called = true;
      return { rows: [] };
    });
    expect(called).toBe(false);
    expect(ships.size).toBe(0);
  });
  test('an unreadable kernel degrades to an empty map', async () => {
    const ships = await deliveryShipsForPrs([{ workspaceId: 'w1', prUrl: 'https://github.com/acme/repo/pull/42' }], async () => {
      throw new Error('boom');
    });
    expect(ships.size).toBe(0);
  });
});
