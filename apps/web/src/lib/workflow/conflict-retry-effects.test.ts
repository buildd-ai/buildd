/**
 * The mechanical renumber plan (docs/specs/workflow-state-kernel.md §6.7,
 * S27): a byte-identical rename into the next slot no reader of the PR's base,
 * the trunk or the colliding PR can see as taken; refused (an agent
 * regenerates) when the migration directory carries a chained journal.
 */
import { describe, expect, test } from 'bun:test';
import { planRenumber } from './conflict-retry-effects';

const f = (name: string, type = 'file') => ({ name, path: `db/drizzle/${name}`, sha: `s-${name}`, type });

describe('planRenumber', () => {
  test('takes the next index past head, base, trunk and the peer, keeping the width and the name', () => {
    const plan = planRenumber({
      file: '0007_add.sql',
      dirs: { head: [f('0006_a.sql'), f('0007_add.sql')], base: [f('0006_a.sql')], trunk: [f('0009_t.sql')], other: [f('0007_b.sql')] },
    });
    expect(plan).toEqual({ ok: true, from: '0007_add.sql', to: '0010_add.sql' });
  });

  test('a drizzle journal (meta/) cannot be renumbered byte-identically: refused', () => {
    expect(planRenumber({ file: '0007_add.sql', dirs: { head: [f('0007_add.sql'), f('meta', 'dir')], base: [], trunk: [], other: [] } }))
      .toEqual({ ok: false, reason: 'journal_regenerate_required' });
  });

  test('a migration no longer on the head is not this repair to make', () => {
    expect(planRenumber({ file: '0007_add.sql', dirs: { head: [f('0006_a.sql')], base: [], trunk: [], other: [] } }))
      .toEqual({ ok: false, reason: 'migration_not_on_head' });
  });
});
