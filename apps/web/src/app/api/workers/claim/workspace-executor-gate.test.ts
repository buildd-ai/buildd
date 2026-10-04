import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { CLOUD_DISPATCH_EVENTS, WORKSPACE_EXECUTORS } from '@buildd/shared';
import { workspaceExecutorGate } from './workspace-executor-gate';

const render = (claim: 'host' | 'cloud') => new PgDialect().sqlToQuery(workspaceExecutorGate(claim));

// Behaviour against real rows lives in apps/web/tests/db/workspace-executor-gate.test.ts;
// this pins the rendered shape so a refactor cannot quietly drop a branch.
describe('workspaceExecutorGate SQL', () => {
  it('a host claim excludes tasks whose workspace resolves to cloud', () => {
    const { sql, params } = render('host');
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('"workspaces"');
    expect(sql).toContain('"tasks"."workspace_id"');
    expect(params).toContain('cloud');
    expect(params).not.toContain('host');
  });

  it('a cloud claim excludes tasks whose workspace resolves to host', () => {
    const { params } = render('cloud');
    expect(params).toContain('host');
    expect(params).not.toContain('cloud');
  });

  it('derives from the explicit value first, then the cloud dispatch webhook, else any', () => {
    const { sql, params } = render('host');
    expect(sql).toContain(`git_config->>'executor'`);
    for (const v of WORKSPACE_EXECUTORS) expect(sql).toContain(`'${v}'`);
    expect(sql).toContain(`webhook_config->'enabled'`);
    expect(sql).toContain(`webhook_config->'events' @>`);
    expect(params).toContain(JSON.stringify([...CLOUD_DISPATCH_EVENTS]));
    expect(sql).toMatch(/ELSE 'any' END/);
  });
});
