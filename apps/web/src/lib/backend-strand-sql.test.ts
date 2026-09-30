/**
 * The backend-strand probe's pending-task filter, rendered to real SQL.
 *
 * backend-strand.test.ts replaces drizzle-orm with object builders, so it can
 * not see the WHERE. Work in a held mission, a local-executor mission, or held
 * on its own is not waiting on a runner credential; counting it as
 * credential-stranded raised a false alarm. The filter reuses the claim
 * route's gates so the two cannot drift.
 */
import { describe, it, expect, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

mock.module('@buildd/core/db', () => ({ db: { query: {} } }));

import { strandedPendingWhere } from './backend-strand';
import { notHeldOrLocal } from '@/app/api/workers/claim/held-gate';

const dialect = new PgDialect();
const render = (q: Parameters<PgDialect['sqlToQuery']>[0]) =>
  dialect.sqlToQuery(q).sql.replace(/\$\d+/g, '$?');

describe('strandedPendingWhere', () => {
  it('excludes held and local-executor work via the claim gates', () => {
    expect(render(strandedPendingWhere(['ws-a']))).toContain(render(notHeldOrLocal()));
  });

  it('scopes to pending tasks in the given workspaces', () => {
    const q = dialect.sqlToQuery(strandedPendingWhere(['ws-a', 'ws-b']));
    expect(q.sql).toContain('"tasks"."status" = $1');
    expect(q.sql).toContain('"tasks"."workspace_id" in ($2, $3)');
    expect(q.params.slice(0, 3)).toEqual(['pending', 'ws-a', 'ws-b']);
  });

  it('narrows to stored backends when given (the sample query)', () => {
    const q = dialect.sqlToQuery(strandedPendingWhere(['ws-a'], ['codex']));
    expect(q.sql).toContain('"tasks"."backend" in (');
    expect(q.params).toContain('codex');
  });
});
