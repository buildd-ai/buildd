/**
 * Where a task's access grant came from. Kept free of server imports so the
 * task page's client Access section can read the labels; access-log.ts
 * (server-only, it reaches the database) re-exports these.
 */
export type GrantSource = 'filed' | 'role_policy' | 'team_policy' | 'asked';

/** Plain words for where a grant came from (the task page's Access section). */
export const GRANT_SOURCE_TEXT: Record<GrantSource, string> = {
  filed: 'filed with the task',
  role_policy: "the role's standing policy",
  team_policy: "the team's policy",
  asked: 'asked mid-run, approved by a person',
};
