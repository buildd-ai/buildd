/**
 * Role slugs that a static route already owns.
 *
 * `/app/team/[slug]` resolves a *role* — `team/[slug]/page.tsx` looks the slug
 * up in `workspaceSkills` where `isRole` — and `/app/team/new` is a static
 * segment beside it holding the New Role form. Next.js matches static segments
 * first, so a role slugged "new" would never reach its own page: it would
 * render the creation form instead, with no error to explain why.
 *
 * Teams are NOT at risk and must not be guarded here: they route by id at
 * `/app/teams/[id]`, and `teams.slug` appears in no URL path in this app.
 * Guarding team creation would reject a team legitimately named "New" for a
 * collision that cannot happen.
 *
 * `reserved-slugs.test.ts` pins all three of those facts: which table the
 * route reads, which endpoints enforce this guard, and that the list covers
 * every static sibling of `[slug]`.
 */
export const RESERVED_ROLE_SLUGS = ['new'] as const;

export function isReservedRoleSlug(slug: string): boolean {
  return (RESERVED_ROLE_SLUGS as readonly string[]).includes(slug.toLowerCase());
}
