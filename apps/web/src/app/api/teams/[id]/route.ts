import { NextRequest, NextResponse } from 'next/server';
import { normalizeFeatureModes } from '@buildd/core/inference-policy';
import { isInferenceKeyPolicy } from '@buildd/core/inference-key-policy';
import { db } from '@buildd/core/db';
import { teams, teamMembers, users } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { getRequestPrincipal, requireSessionUser } from '@/lib/auth-helpers';
import { isValidTimezone } from '@buildd/core/timezone';
import { isChatTierName } from '@buildd/shared';

type TeamRole = 'owner' | 'admin' | 'member';

/** Fits numeric(10, 2) with room to spare; anything above is a typo. */
const MAX_CHAT_BUDGET_USD = 100_000;

const ROLE_HIERARCHY: Record<TeamRole, number> = {
  owner: 3,
  admin: 2,
  member: 1,
};

async function verifyTeamAccess(
  userId: string,
  teamId: string,
  requiredRole?: TeamRole
): Promise<{ role: TeamRole } | null> {
  const membership = await db.query.teamMembers.findFirst({
    where: and(
      eq(teamMembers.teamId, teamId),
      eq(teamMembers.userId, userId)
    ),
  });

  if (!membership) return null;

  const role = membership.role as TeamRole;

  if (requiredRole && ROLE_HIERARCHY[role] < ROLE_HIERARCHY[requiredRole]) {
    return null;
  }

  return { role };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const principal = await getRequestPrincipal(req);
  if (!principal) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // An API key may read only its own team, and carries no user role.
    let currentUserRole: TeamRole | null;
    if (principal.kind === 'api_key') {
      if (principal.account.teamId !== id) {
        return NextResponse.json({ error: 'Team not found' }, { status: 404 });
      }
      currentUserRole = null;
    } else {
      const access = await verifyTeamAccess(principal.user.id, id);
      if (!access) {
        return NextResponse.json({ error: 'Team not found' }, { status: 404 });
      }
      currentUserRole = access.role;
    }

    // Explicit column list. This response shape is a contract with unknown
    // callers, so rather than trimming it to the two fields the dashboard reads
    // (enabledBackends / inferenceFeatureModes) it enumerates every column
    // explicitly. That decouples the route from schema.ts, so dropping a column
    // cannot break it mid-deploy — db:migrate runs before next build, so the old
    // code serves against the new schema for the length of the build.
    const team = await db.query.teams.findFirst({
      where: eq(teams.id, id),
      columns: {
        id: true,
        name: true,
        slug: true,
        plan: true,
        createdAt: true,
        updatedAt: true,
        monthlyBudgetUsd: true,
        monthlyCostUsd: true,
        monthlyCostMonth: true,
        budgetAlertsSent: true,
        enabledBackends: true,
        inferenceFeatureModes: true,
        chatDailyBudgetUsd: true,
        chatUserDailyBudgetUsd: true,
        inferenceKeyPolicy: true,
        chatDefaultTier: true,
        chatCapNewSessionTier: true,
        timezone: true,
      },
    });

    if (!team) {
      return NextResponse.json({ error: 'Team not found' }, { status: 404 });
    }

    // Get members with user info
    const members = await db.query.teamMembers.findMany({
      where: eq(teamMembers.teamId, id),
      with: {
        user: true,
      },
    });

    const memberList = members.map(m => ({
      userId: m.userId,
      role: m.role,
      joinedAt: m.joinedAt,
      name: m.user.name,
      email: m.user.email,
      image: m.user.image,
    }));

    return NextResponse.json({
      team,
      members: memberList,
      currentUserRole,
    });
  } catch (error) {
    console.error('Get team error:', error);
    return NextResponse.json({ error: 'Failed to get team' }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const session = await requireSessionUser(req);
  if (session.response) return session.response;
  const user = session.user;

  try {
    const access = await verifyTeamAccess(user.id, id, 'admin');
    if (!access) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await req.json();
    const { name, slug, enabledBackends, inferenceFeatureModes, timezone, chatDailyBudgetUsd, chatUserDailyBudgetUsd, inferenceKeyPolicy, chatDefaultTier, chatCapNewSessionTier } = body;

    const updates: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (name !== undefined) updates.name = name;
    if (enabledBackends !== undefined) {
      // Provider-enablement toggle. Must be a non-empty subset of the known
      // backends — at least one provider stays enabled so work can still run.
      const VALID = ['claude', 'codex'] as const;
      if (
        !Array.isArray(enabledBackends) ||
        enabledBackends.length === 0 ||
        !enabledBackends.every((b: unknown) => (VALID as readonly string[]).includes(b as string))
      ) {
        return NextResponse.json(
          { error: 'enabledBackends must be a non-empty array of "claude" and/or "codex"' },
          { status: 400 },
        );
      }
      updates.enabledBackends = [...new Set(enabledBackends as string[])];
    }
    if (inferenceFeatureModes !== undefined) {
      // Per-feature overrides for server-side features ({ feature: 'server' |
      // 'runner' }). An absent feature, or 'default', follows the billing model.
      // Unknown features are dropped so a newer client cannot write a mode this
      // build does not implement. The retired enabledInferenceCapabilities
      // allowlist is ignored, not written.
      if (inferenceFeatureModes !== null && (typeof inferenceFeatureModes !== 'object' || Array.isArray(inferenceFeatureModes))) {
        return NextResponse.json(
          { error: "inferenceFeatureModes must be an object of feature → 'server' | 'runner' | 'default', or null" },
          { status: 400 },
        );
      }
      updates.inferenceFeatureModes = normalizeFeatureModes(inferenceFeatureModes);
    }
    if (timezone !== undefined) {
      // The team's canonical working zone — used wherever a shared artifact needs a
      // wall clock and there is no single known viewer (PR activity comments, new
      // schedule defaults, mission active hours). `null` clears it back to UTC.
      if (timezone !== null && !isValidTimezone(timezone)) {
        return NextResponse.json(
          { error: 'timezone must be a valid IANA zone name (e.g. America/New_York) or null' },
          { status: 400 },
        );
      }
      updates.timezone = timezone;
    }
    // Agent-chat daily budgets in USD (apps/web/src/lib/chat/limits.ts). `null`
    // reverts to the default; it never means "no cap".
    for (const [field, value] of [
      ['chatDailyBudgetUsd', chatDailyBudgetUsd],
      ['chatUserDailyBudgetUsd', chatUserDailyBudgetUsd],
    ] as const) {
      if (value === undefined) continue;
      if (value === null) { updates[field] = null; continue; }
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_CHAT_BUDGET_USD) {
        return NextResponse.json(
          { error: `${field} must be a number of dollars from 0 to ${MAX_CHAT_BUDGET_USD}, or null for the default` },
          { status: 400 },
        );
      }
      updates[field] = value.toFixed(2);
    }
    // Whose key a person's chat turn spends; enforced by resolveInferenceKey.
    if (inferenceKeyPolicy !== undefined) {
      if (!isInferenceKeyPolicy(inferenceKeyPolicy)) {
        return NextResponse.json({ error: 'inferenceKeyPolicy must be "team", "team_or_own" or "own"' }, { status: 400 });
      }
      updates.inferenceKeyPolicy = inferenceKeyPolicy;
    }
    // The tier a new chat caps at, and whether the cap is on
    // (apps/web/src/lib/chat/composer-prefs.ts). `null` default = auto: no cap.
    if (chatDefaultTier !== undefined) {
      if (chatDefaultTier !== null && !isChatTierName(chatDefaultTier)) {
        return NextResponse.json({ error: 'chatDefaultTier must be "budget", "standard", "premium" or null for auto' }, { status: 400 });
      }
      updates.chatDefaultTier = chatDefaultTier;
    }
    if (chatCapNewSessionTier !== undefined) {
      if (typeof chatCapNewSessionTier !== 'boolean') {
        return NextResponse.json({ error: 'chatCapNewSessionTier must be a boolean' }, { status: 400 });
      }
      updates.chatCapNewSessionTier = chatCapNewSessionTier;
    }
    // Chat is always on: there is no switch. A `chatDisabled` field (the old
    // kill switch; teams.chat_disabled is deprecated) is ignored.
    if (slug !== undefined) {
      // Validate slug format
      if (!/^[a-z0-9-]+$/.test(slug)) {
        return NextResponse.json({ error: 'Slug must contain only lowercase letters, numbers, and hyphens' }, { status: 400 });
      }

      // Check slug uniqueness (excluding current team)
      const existing = await db.query.teams.findFirst({
        where: eq(teams.slug, slug),
        columns: { id: true },
      });

      if (existing && existing.id !== id) {
        return NextResponse.json({ error: 'A team with this slug already exists' }, { status: 409 });
      }

      updates.slug = slug;
    }

    await db.update(teams).set(updates).where(eq(teams.id, id));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Update team error:', error);
    return NextResponse.json({ error: 'Failed to update team' }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const session = await requireSessionUser(req);
  if (session.response) return session.response;
  const user = session.user;

  try {
    const access = await verifyTeamAccess(user.id, id, 'owner');
    if (!access) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Check if it's a personal team
    const team = await db.query.teams.findFirst({
      where: eq(teams.id, id),
      columns: { slug: true },
    });

    if (team?.slug.startsWith('personal-')) {
      return NextResponse.json({ error: 'Cannot delete personal team' }, { status: 400 });
    }

    await db.delete(teams).where(eq(teams.id, id));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Delete team error:', error);
    return NextResponse.json({ error: 'Failed to delete team' }, { status: 500 });
  }
}
