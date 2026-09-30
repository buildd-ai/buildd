/**
 * The stranded-task sweep's two queries, rendered to real SQL.
 *
 * stranded-tasks-sweep.test.ts replaces drizzle-orm with object builders, so
 * it proves what the sweep does with rows but never what the WHERE says. A
 * task in a held mission, a local-executor mission, or held on its own is
 * pending by design, not stranded; these assertions pin that the sweep uses
 * the claim route's own gates to tell the difference.
 */
import { describe, it, expect, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

mock.module('@buildd/core/db', () => ({ db: { query: {} } }));

import { strandedCandidatesQuery, resolvedStrandedNotesQuery } from './stranded-tasks-sweep';
import { notHeldOrLocal } from '@/app/api/workers/claim/held-gate';

const dialect = new PgDialect();
const render = (q: Parameters<PgDialect['sqlToQuery']>[0]) =>
  dialect.sqlToQuery(q).sql.replace(/\$\d+/g, '$?').replace(/\s+/g, ' ');

describe('strandedCandidatesQuery', () => {
  const text = render(strandedCandidatesQuery(120));

  it('skips held, local-executor and single-held tasks via the claim gates', () => {
    expect(text).toContain(render(notHeldOrLocal()));
  });

  it('still selects pending tasks with an old startAt or a deferral streak', () => {
    expect(text).toContain(`"tasks"."status" = 'pending'`);
    expect(text).toContain('"tasks"."start_at" < now()');
    expect(text).toContain('ld.detail IS NOT NULL');
  });
});

describe('resolvedStrandedNotesQuery', () => {
  const text = render(resolvedStrandedNotesQuery());

  it('supersedes a note once its task is held or moved to a local mission', () => {
    expect(text).toContain(`NOT ${render(notHeldOrLocal())}`);
  });

  it('still supersedes a note whose task left pending or was deleted', () => {
    expect(text).toContain(`"tasks"."id" IS NULL OR "tasks"."status" <> 'pending'`);
  });
});
