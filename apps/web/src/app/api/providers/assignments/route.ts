import { NextRequest, NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { teams } from '@buildd/core/db/schema';
import { assignmentError, parseProviderAssignments } from '@buildd/core/providers/assignments';
import { POLICY_PERMISSION } from '@buildd/core/providers/manage';
import { authenticateTaskScopedCaller } from '@/lib/task-token-auth';
import { TASK_TOKEN_READ_ONLY, resolveProvidersCaller } from '@/lib/providers/caller';
import type { ProviderAssignmentsResponse } from '@buildd/shared';

/**
 * Which connected provider serves each surface (`teams.provider_assignments`,
 * see `@buildd/core/providers/assignments`).
 *
 *   GET   ?teamId=                          → { assignments }
 *   PATCH { surface, provider|null, teamId? } → { assignments }
 *
 * Any member reads (a task token neither reads nor writes); changing one needs manage_team_settings, like the
 * credential policy. A provider the surface cannot use is refused with the
 * registry's reason. One atomic UPDATE per change, so two admins picking
 * different surfaces at once both land.
 */
export async function GET(req: NextRequest) {
  const r = await resolveProvidersCaller(req, req.nextUrl.searchParams.get('teamId'), t => authenticateTaskScopedCaller(t, req));
  if (!r.ok) return r.response;
  if (r.caller.taskScope) return NextResponse.json({ error: TASK_TOKEN_READ_ONLY }, { status: 403 });
  try {
    const team = await db.query.teams.findFirst({ where: eq(teams.id, r.caller.teamId), columns: { providerAssignments: true } });
    const body: ProviderAssignmentsResponse = { assignments: parseProviderAssignments(team?.providerAssignments) };
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[providers/assignments] read failed:', error);
    return NextResponse.json({ error: 'Failed to read provider assignments' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const r = await resolveProvidersCaller(req, typeof body.teamId === 'string' ? body.teamId : null, t => authenticateTaskScopedCaller(t, req));
  if (!r.ok) return r.response;
  const caller = r.caller;
  if (caller.taskScope) return NextResponse.json({ error: TASK_TOKEN_READ_ONLY }, { status: 403 });
  const provider = body.provider ?? null;
  const problem = assignmentError(body.surface, provider);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  if (!(await caller.may(POLICY_PERMISSION))) {
    return NextResponse.json({ error: `Only a team owner or admin can choose which provider serves a surface (needs ${POLICY_PERMISSION}).` }, { status: 403 });
  }
  const surface = body.surface as string;
  const next = provider === null
    ? sql`coalesce(${teams.providerAssignments}, '{}'::jsonb) - ${surface}::text`
    : sql`coalesce(${teams.providerAssignments}, '{}'::jsonb) || jsonb_build_object(${surface}::text, ${provider as string}::text)`;
  try {
    const [row] = await db.update(teams)
      .set({ providerAssignments: next, updatedAt: new Date() })
      .where(eq(teams.id, caller.teamId))
      .returning({ providerAssignments: teams.providerAssignments });
    const out: ProviderAssignmentsResponse = { assignments: parseProviderAssignments(row?.providerAssignments) };
    return NextResponse.json(out);
  } catch (error) {
    console.error('[providers/assignments] write failed:', error);
    return NextResponse.json({ error: 'Failed to change the provider assignment' }, { status: 500 });
  }
}
