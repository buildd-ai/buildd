import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { teams } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import type { WallFallbackOption, WallFallbackSettingsResponse } from '@buildd/shared';
import { validateWallFallbackInput, type WallFallbackProvider } from '@buildd/core/wall-fallback';
import { requireSessionUser } from '@/lib/auth-helpers';
import { getUserTeamIds } from '@/lib/team-access';
import { can } from '@/lib/permissions';
import { isUuid } from '@/lib/uuid';
import {
  WALL_FALLBACK_LABELS,
  loadWallFallbackSetting,
  resolveWallFallbackCredential,
  wallFallbackSpentToday,
} from '@/lib/subscription-fallback';

/**
 * Settings › Models › "When the subscription limit is reached": the team's
 * subscription-wall fallback (packages/core/wall-fallback.ts, provider-failover
 * spec "Subscription wall fallback").
 *
 *   GET → WallFallbackSettingsResponse                     any member
 *         The choice, the daily cap, what fallback runs cost today, and for
 *         each fallback the team credential it would use (last four only).
 *   PUT { fallback, maxCostPerDayUsd? } → the same          manage_team_settings
 *         400 for a fallback with no usable team credential: a fallback that
 *         can never serve a run would read as protection it is not.
 *
 * Session only: like every team spend setting, an API key cannot change it.
 */

const PROVIDERS: WallFallbackProvider[] = ['anthropic', 'openrouter', 'litellm', 'endpoint'];

async function caller(req: NextRequest, teamId: string): Promise<{ response: Response } | { canManage: boolean }> {
  const session = await requireSessionUser(req);
  if (session.response) return { response: session.response };
  const userId = session.user.id;
  if (!(await getUserTeamIds(userId)).includes(teamId)) return { response: NextResponse.json({ error: 'Team not found' }, { status: 404 }) };
  return { canManage: await can({ kind: 'user', userId }, 'manage_team_settings', teamId) };
}

/** Team-scope credentials only: the setting is the team's, so is what it names. */
async function options(teamId: string): Promise<WallFallbackOption[]> {
  return Promise.all(PROVIDERS.map(async (id) => {
    const c = await resolveWallFallbackCredential({ teamId, workspaceId: null, served: id });
    return { id, label: WALL_FALLBACK_LABELS[id], available: !!c, last4: c?.last4 ?? null };
  }));
}

async function view(teamId: string, canManage: boolean): Promise<WallFallbackSettingsResponse> {
  const [setting, opts, spentTodayUsd] = await Promise.all([
    loadWallFallbackSetting(teamId),
    options(teamId),
    wallFallbackSpentToday(teamId),
  ]);
  return { setting, options: opts, spentTodayUsd: Number.isFinite(spentTodayUsd) ? spentTodayUsd : 0, canManage };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  const c = await caller(req, id);
  if ('response' in c) return c.response;
  return NextResponse.json(await view(id, c.canManage));
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  const c = await caller(req, id);
  if ('response' in c) return c.response;
  if (!c.canManage) return NextResponse.json({ error: 'Only a team owner or admin can change this.' }, { status: 403 });

  const parsed = validateWallFallbackInput(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const setting = parsed.setting;

  if (setting.fallback !== 'wait') {
    const credential = await resolveWallFallbackCredential({ teamId: id, workspaceId: null, served: setting.fallback });
    if (!credential) {
      return NextResponse.json({
        error: `Add ${WALL_FALLBACK_LABELS[setting.fallback]} under Providers first: there is nothing for a walled run to fall back to.`,
      }, { status: 400 });
    }
  }

  await db.update(teams)
    .set({ subscriptionWallFallback: setting.fallback === 'wait' ? null : setting, updatedAt: new Date() })
    .where(eq(teams.id, id));
  return NextResponse.json(await view(id, c.canManage));
}
