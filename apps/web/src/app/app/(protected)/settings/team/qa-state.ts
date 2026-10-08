/**
 * `?state=` fixtures for Settings → Team → Members, so the visual audit can reach
 * gated UI that the CI QA account's data can't produce (docs/specs/qa-capture-steps.md).
 *
 * The CI QA user owns a team of one, and the Remove button and role <Select> only
 * render for *another* member. `?state=multi-member` adds a synthetic second row;
 * TeamDetailClient never sends a write for it.
 *
 * Dev-server only: Visual QA runs `bun dev`, production ignores the param.
 */

export type TeamQaState = 'multi-member';

/** userId of the synthetic row. Not a UUID, so it can never match a real user. */
export const QA_FIXTURE_MEMBER_ID = 'qa-fixture-member';

export function resolveTeamQaState(
  raw: string | string[] | undefined,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): TeamQaState | null {
  if (nodeEnv !== 'development') return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === 'multi-member' ? 'multi-member' : null;
}

interface MemberRow {
  userId: string;
  role: 'owner' | 'admin' | 'member';
  joinedAt: string;
  name: string | null;
  email: string;
  image: string | null;
}

export function withQaFixtureMembers(members: MemberRow[], state: TeamQaState | null): MemberRow[] {
  if (state !== 'multi-member') return members;
  if (members.some((m) => m.userId === QA_FIXTURE_MEMBER_ID)) return members;
  return [
    ...members,
    {
      userId: QA_FIXTURE_MEMBER_ID,
      role: 'member',
      joinedAt: new Date(0).toISOString(),
      name: 'Sample Member',
      email: 'member@example.com',
      image: null,
    },
  ];
}
