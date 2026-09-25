import { describe, it, expect } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { and } from 'drizzle-orm';
import { EXPLICIT_ROLE_SLUGS, VISUAL_AUDITOR_ROLE_SLUG } from '@buildd/shared';
import { roleSlugGate, isRoleClaimable } from './role-gate';

// The role gate is SQL-filtered in Postgres, so a mocked `db` can't observe it.
// Render it through PgDialect instead. Safe: `bun run test` runs one process
// per file, so route.test.ts's `drizzle-orm` mock never reaches this file.
const dialect = new PgDialect();

function render(skills: string[] | undefined) {
  const clauses = roleSlugGate(skills);
  if (clauses.length === 0) return { sql: '', params: [] as unknown[], count: 0 };
  const q = dialect.sqlToQuery(and(...clauses)!);
  return { sql: q.sql.replace(/\s+/g, ' '), params: q.params, count: clauses.length };
}

describe('roleSlugGate() — emitted SQL', () => {
  it('with no skills, still keeps explicit-slug tasks away (and nothing else)', () => {
    const { sql, params, count } = render([]);
    expect(count).toBe(1);
    // The IS NULL arm is load-bearing: `NULL NOT IN (...)` is NULL, so without
    // it every unrouted task would silently drop out of the claim.
    expect(sql).toBe('("tasks"."role_slug" is null or "tasks"."role_slug" not in ($1))');
    expect(params).toEqual([...EXPLICIT_ROLE_SLUGS]);
  });

  it('treats an omitted list exactly like an empty one', () => {
    expect(render(undefined)).toEqual(render([]));
  });

  it("['visual-auditor'] opens explicit tasks WITHOUT closing any other role", () => {
    const { sql, params, count } = render([VISUAL_AUDITOR_ROLE_SLUG]);
    // Only the explicit clause: a browser runner must keep claiming builder,
    // organizer, ... tasks. The legacy strict clause here would strand them.
    expect(count).toBe(1);
    expect(sql).toBe(
      '("tasks"."role_slug" is null or "tasks"."role_slug" not in ($1) or "tasks"."role_slug" in ($2))',
    );
    expect(params).toEqual([...EXPLICIT_ROLE_SLUGS, VISUAL_AUDITOR_ROLE_SLUG]);
  });

  it("['builder'] keeps today's strict routing and still refuses explicit slugs", () => {
    const { sql, params, count } = render(['builder']);
    expect(count).toBe(2);
    expect(sql).toBe(
      '(("tasks"."role_slug" is null or "tasks"."role_slug" not in ($1)) and ' +
        '("tasks"."role_slug" is null or "tasks"."role_slug" in ($2) or "tasks"."role_slug" in ($3)))',
    );
    expect(params).toEqual([...EXPLICIT_ROLE_SLUGS, ...EXPLICIT_ROLE_SLUGS, 'builder']);
  });

  it('a mixed list opens the explicit slug and restricts to the legacy ones', () => {
    const { sql, params, count } = render(['builder', VISUAL_AUDITOR_ROLE_SLUG]);
    expect(count).toBe(2);
    expect(sql).toContain('"tasks"."role_slug" not in ($1) or "tasks"."role_slug" in ($2)');
    // The legacy list carries only the non-explicit slug.
    expect(params).toEqual([
      ...EXPLICIT_ROLE_SLUGS,
      VISUAL_AUDITOR_ROLE_SLUG,
      ...EXPLICIT_ROLE_SLUGS,
      'builder',
    ]);
  });
});

describe('isRoleClaimable() — mirrors the SQL rule', () => {
  const cases: Array<[string | null, string[] | undefined, boolean]> = [
    [null, undefined, true],
    [null, [], true],
    [null, ['builder'], true],
    [null, [VISUAL_AUDITOR_ROLE_SLUG], true],
    ['builder', undefined, true],
    ['builder', [], true],
    ['builder', ['builder'], true],
    ['builder', ['organizer'], false],
    ['builder', [VISUAL_AUDITOR_ROLE_SLUG], true],
    ['builder', ['organizer', VISUAL_AUDITOR_ROLE_SLUG], false],
    [VISUAL_AUDITOR_ROLE_SLUG, undefined, false],
    [VISUAL_AUDITOR_ROLE_SLUG, [], false],
    [VISUAL_AUDITOR_ROLE_SLUG, ['builder'], false],
    [VISUAL_AUDITOR_ROLE_SLUG, [VISUAL_AUDITOR_ROLE_SLUG], true],
    [VISUAL_AUDITOR_ROLE_SLUG, ['builder', VISUAL_AUDITOR_ROLE_SLUG], true],
  ];
  for (const [role, skills, expected] of cases) {
    it(`role=${role ?? 'null'} skills=${JSON.stringify(skills)} → ${expected}`, () => {
      expect(isRoleClaimable(role, skills)).toBe(expected);
    });
  }
});
