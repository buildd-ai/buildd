/**
 * Which heartbeats make up a team's fleet, rendered to real SQL. The loader
 * matched on `worker_heartbeats.workspace_ids`, which the heartbeat route has
 * written as `[]` for a long time, so a runner whose account belongs to
 * another team but is linked to this team's workspaces was never loaded: its
 * live workers showed under a URL-derived name, "Offline", while
 * list_runners (the claim rule) listed it online.
 */
import { describe, it, expect } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { fleetHeartbeatScope } from './fleet-heartbeat-scope';

const dialect = new PgDialect();
const render = (q: Parameters<PgDialect['sqlToQuery']>[0]) => dialect.sqlToQuery(q).sql.replace(/\$\d+/g, '$?');

describe('fleetHeartbeatScope', () => {
  const text = render(fleetHeartbeatScope({ teamId: 'team-1', wsIds: ['ws-1', 'ws-2'] })!);

  it("takes a runner whose account is linked to the team's workspaces, from any team", () => {
    expect(text).toContain('"account_workspaces"');
    expect(text).toContain('"account_workspaces"."workspace_id" in ($?, $?)');
  });

  it('a link an admin removed reaches nothing', () => {
    expect(text).toContain('"account_workspaces"."removed_at" is null');
  });

  it('a person-granted link counts only while its grant still holds (the claim rule and the runner list drop it too)', () => {
    expect(text).toContain('"account_workspaces"."granted_by_user_id" is null or');
  });

  it("still takes the team's own accounts", () => {
    expect(text).toContain('"accounts"."team_id" = $?');
  });

  it('no longer reads the never-written workspace_ids column', () => {
    expect(text).not.toContain('workspace_ids');
  });

  it('with no team and no workspaces there is nothing to scope to', () => {
    expect(fleetHeartbeatScope({ teamId: null, wsIds: [] })).toBeNull();
  });
});
