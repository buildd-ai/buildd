import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Invariant: tenant alerts are delivered to the tenant's own channel.
 *
 * `lib/pushover` sends through the platform operator's own Pushover app and
 * user key (env). Only platform-health alerts may use it. Anything about one
 * team's tasks, PRs, missions, budget or credentials goes through `lib/notify`
 * (notifyTeam / notifyTeamOf), which resolves that team's own channel and
 * no-ops when the team has none.
 *
 * Every call to the operator sender is pinned here, per file, with the reason
 * it is platform-level. A new call fails this test until someone decides which
 * side it belongs on.
 */

const WEB_SRC = join(import.meta.dir, '..');

const OPERATOR_SENDER_CALLS: Record<string, { calls: number; why: string }> = {
  'app/api/cron/mission-invariants/route.ts': { calls: 1, why: 'cross-tenant invariant scan digest' },
  'app/api/cron/queue-stall/route.ts': { calls: 1, why: 'cross-tenant queue health watchdog' },
  'app/api/cron/schedules/maintenance/overdue-heartbeats.ts': { calls: 1, why: 'scheduler health: the cron itself stalled' },
  'app/api/github/webhook/route.ts': { calls: 5, why: 'installation sync health + release pipeline failures' },
  'app/api/workers/[id]/route.ts': { calls: 1, why: 'release pipeline failure' },
  'lib/cron-run.ts': { calls: 1, why: 'cron job health' },
  'lib/health-watcher.ts': { calls: 2, why: 'project health watcher (operator-configured)' },
};

/** Modules whose alerts are about one tenant: they must use the team path. */
const TENANT_ALERT_MODULES = [
  'app/api/cron/stall-notify/route.ts',
  'app/api/github/webhook/dark-check-detection.ts',
  'app/api/github/webhook/route.ts',
  'app/api/workers/[id]/route.ts',
  'lib/auto-merge.ts',
  'lib/conflict-retry.ts',
  'lib/heartbeat-circuit-breaker.ts',
  'lib/mission-budget.ts',
  'lib/mission-notifications.ts',
];

function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      collectSources(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const IMPORTS_OPERATOR_SENDER = /from\s+['"](?:@\/lib\/pushover|\.\/pushover|\.\.\/pushover|(?:\.\.\/)+lib\/pushover)['"]/;

function operatorSenderUsage(): Record<string, number> {
  const usage: Record<string, number> = {};
  for (const file of collectSources(WEB_SRC)) {
    const rel = relative(WEB_SRC, file);
    if (rel === 'lib/pushover.ts') continue;
    const src = readFileSync(file, 'utf8');
    if (!IMPORTS_OPERATOR_SENDER.test(src)) continue;
    usage[rel] = (src.match(/\bnotifyOperator\(/g) ?? []).length;
  }
  return usage;
}

describe('tenant alerts are delivered to the tenant channel', () => {
  it('the operator sender is named for what it is', async () => {
    const mod = await import('./pushover');
    expect(typeof mod.notifyOperator).toBe('function');
    expect('notify' in mod).toBe(false);
  });

  it('only pinned platform-level call sites use the operator sender', () => {
    const pinned = Object.fromEntries(Object.entries(OPERATOR_SENDER_CALLS).map(([f, v]) => [f, v.calls]));
    expect(operatorSenderUsage()).toEqual(pinned);
  });

  it('modules that raise tenant alerts use the team path', () => {
    const missing = TENANT_ALERT_MODULES.filter(rel => {
      const src = readFileSync(join(WEB_SRC, rel), 'utf8');
      return !/\bnotifyTeam(Of)?\(/.test(src);
    });
    expect(missing).toEqual([]);
  });

  it('the scan is live: it finds the operator sender importers', () => {
    expect(Object.keys(operatorSenderUsage()).length).toBeGreaterThan(0);
  });
});
