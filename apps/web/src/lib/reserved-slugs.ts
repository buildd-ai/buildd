/**
 * Team slugs that a static route already owns.
 *
 * `/app/team/new` (the New Role form) is a static segment beside the dynamic
 * `/app/team/[slug]`. Next.js matches static segments first, so a team whose
 * slug is one of these would never reach its own page — it would render the
 * static route instead, with no error to explain why.
 *
 * `reserved-slugs.test.ts` derives the expected contents from the directory
 * listing, so adding a static sibling under `team/` fails that test until it
 * is listed here.
 */
export const RESERVED_TEAM_SLUGS = ['new'] as const;

export function isReservedTeamSlug(slug: string): boolean {
  return (RESERVED_TEAM_SLUGS as readonly string[]).includes(slug.toLowerCase());
}
