/**
 * Reads the effective Coding policy (`teams.coding_policy`,
 * `team_members.coding_policy`). Rule: ./coding-policy.ts.
 *
 * No cross-request cache: a tightened restriction must hold on the very next
 * claim. Reads throw on a DB error; the claim holds the task rather than
 * guessing that no restriction applies.
 */
import { and, eq } from 'drizzle-orm';
import { db } from './db/client';
import { teamMembers, teams } from './db/schema';
import {
  parseCodingPolicyLayer,
  resolveCodingPolicy,
  type EffectiveCodingPolicy,
} from './coding-policy';

export interface CodingPolicySubject {
  teamId: string | null | undefined;
  workspaceId?: string | null;
  /** The task's requester; null = unidentified automation. A function is called only if a member layer may exist. */
  userId?: string | null | (() => Promise<string | null>);
}

export async function loadCodingPolicy(subject: CodingPolicySubject): Promise<EffectiveCodingPolicy> {
  if (!subject.teamId) return resolveCodingPolicy({});
  const row = await db.query.teams.findFirst({ where: eq(teams.id, subject.teamId), columns: { codingPolicy: true } });
  const stored = row?.codingPolicy ?? null;
  const workspace = subject.workspaceId ? stored?.workspaces?.[subject.workspaceId] : undefined;
  let member = null;
  let requesterKnown = true;
  if (stored?.membersRestricted) {
    const userId = typeof subject.userId === 'function' ? await subject.userId() : subject.userId ?? null;
    if (userId) {
      const m = await db.query.teamMembers.findFirst({
        where: and(eq(teamMembers.teamId, subject.teamId), eq(teamMembers.userId, userId)),
        columns: { codingPolicy: true },
      });
      member = parseCodingPolicyLayer(m?.codingPolicy);
    } else {
      requesterKnown = false;
    }
  }
  return resolveCodingPolicy({
    team: parseCodingPolicyLayer(stored?.team),
    workspace: parseCodingPolicyLayer(workspace),
    member,
    requesterKnown,
  });
}

/** Memoizes within one request (the claim loop), keyed by team|workspace|requester. */
export function codingPolicyLoader() {
  const memo = new Map<string, Promise<EffectiveCodingPolicy>>();
  return async (subject: CodingPolicySubject): Promise<EffectiveCodingPolicy> => {
    const userId = typeof subject.userId === 'function' ? await subject.userId() : subject.userId ?? null;
    const key = `${subject.teamId ?? ''}|${subject.workspaceId ?? ''}|${userId ?? ''}`;
    let p = memo.get(key);
    if (!p) { p = loadCodingPolicy({ ...subject, userId }); memo.set(key, p); }
    return p;
  };
}
