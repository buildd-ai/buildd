import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guard for the one-time host-runner backfill (drizzle/0219_backfill_host_runner.sql).
 *
 * No live-Postgres harness in the unit suite (see
 * backfill-orphaned-mission-schedules.test.ts), so this pins the SQL text to
 * what it must select. The regression it guards: keying only on
 * worker_heartbeats, which the stale-runner sweep empties, so a long-lived
 * runner that happened to be offline at deploy lost credential access.
 */
const sql = readFileSync(join(import.meta.dir, '..', 'drizzle', '0219_backfill_host_runner.sql'), 'utf8')
  .replace(/--.*$/gm, '')
  .replace(/\s+/g, ' ')
  .toLowerCase();

describe('0219 host-runner backfill', () => {
  it('only ever grants the flag, never clears it', () => {
    expect(sql).toContain('set "host_runner" = true');
    expect(sql).not.toContain('= false');
  });

  it('selects long-lived runners from live heartbeats', () => {
    expect(sql).toContain('from "worker_heartbeats"');
  });

  it('also selects runners seen through their workers, which outlive heartbeat rows', () => {
    expect(sql).toMatch(/from "workers"/);
    expect(sql).toMatch(/"local_ui_url" is not null/);
  });

  it('excludes one-task --once runs in both sources', () => {
    expect(sql.match(/not like '%\/once\/%'/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('carries no hardcoded ids', () => {
    expect(sql).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });
});
