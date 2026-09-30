/**
 * The connector-block reminder's candidate filter, rendered to real SQL.
 * route.test.ts mocks drizzle-orm, so the WHERE is invisible there. A task
 * held on its own or sitting in a held or local-executor mission is not
 * waiting on the connector, so no reminder should fire for it.
 */
import { describe, it, expect, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

mock.module('@buildd/core/db', () => ({ db: { query: {} } }));

import { connectorBlockReminderWhere } from './reminder-candidates';
import { notHeldOrLocal } from '@/app/api/workers/claim/held-gate';

const dialect = new PgDialect();
const render = (q: Parameters<PgDialect['sqlToQuery']>[0]) =>
  dialect.sqlToQuery(q).sql.replace(/\$\d+/g, '$?');

describe('connectorBlockReminderWhere', () => {
  const text = render(connectorBlockReminderWhere());

  it('skips held and local-executor work via the claim gates', () => {
    expect(text).toContain(render(notHeldOrLocal()));
  });

  it('still selects pending, notified, not-yet-reminded tasks', () => {
    expect(text).toContain('"tasks"."status" = $?');
    expect(text).toContain(`"tasks"."context"->>'connectorBlockNotifiedAt' IS NOT NULL`);
    expect(text).toContain(`"tasks"."context"->>'connectorBlockReminderSentAt' IS NULL`);
  });
});
