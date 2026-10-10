import { NextRequest, NextResponse } from 'next/server';
import { normalizeDecisionShadows } from '@buildd/core/inference-policy';
import { isUuid } from '@/lib/uuid';
import { applyChatRetroPatch, type ChatRetroSettings } from '@/lib/chat-retro/settings';
import { notFound, requirePlatformOwner } from '@/lib/admin/owner-gate';
import { readTeamExperimentFlags, writeTeamExperimentFlags } from '@/lib/admin/data';
import { recordPlatformAdminAudit } from '@/lib/admin/audit';

/**
 * /api/admin/teams/[id]/experiment-flags — platform owner only (404 otherwise).
 *
 * A team's experimental switches: the opt-in decision capabilities it has on
 * (enabledDecisionShadows) and chat retro (lessons / proposals).
 *
 * GET   → { teamId, flags: { enabledDecisionShadows, chatRetro, chatRetroDogfood } }
 * PATCH { enabledDecisionShadows?: string[] | null, chatRetro?: { lessons?, proposals? } }
 *       → { teamId, flags, deletedLessons }. Audited with the flags before and after.
 *       Same validation as the team settings routes; turning lessons off deletes the
 *       team's lessons, as it does there.
 */
const FIELDS = ['enabledDecisionShadows', 'chatRetro'];

async function load(req: NextRequest, params: Promise<{ id: string }>) {
  const gate = await requirePlatformOwner(req);
  if (gate.response) return { response: gate.response };
  const { id } = await params;
  if (!isUuid(id)) return { response: notFound() };
  const flags = await readTeamExperimentFlags(id);
  if (!flags) return { response: notFound() };
  return { account: gate.account, teamId: id, flags };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await load(req, params);
  if ('response' in r) return r.response;
  return NextResponse.json({ teamId: r.teamId, flags: r.flags });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await load(req, params);
  if ('response' in r) return r.response;
  const { flags: before } = r;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'body must be an object' }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter(k => !FIELDS.includes(k));
  if (unknown.length) return NextResponse.json({ error: `unknown field(s): ${unknown.join(', ')}` }, { status: 400 });
  if (!FIELDS.some(k => k in b)) return NextResponse.json({ error: `send one of: ${FIELDS.join(', ')}` }, { status: 400 });

  let enabledDecisionShadows: string[] | null | undefined;
  if ('enabledDecisionShadows' in b) {
    const normalized = normalizeDecisionShadows(b.enabledDecisionShadows);
    if (!normalized.ok) return NextResponse.json({ error: normalized.error }, { status: 400 });
    enabledDecisionShadows = normalized.value;
  }
  let chatRetro: ChatRetroSettings | undefined;
  let deleteLessons = false;
  if ('chatRetro' in b) {
    const patch = applyChatRetroPatch(before.chatRetro, b.chatRetro, { dogfood: before.chatRetroDogfood });
    if (!patch.ok) return NextResponse.json({ error: patch.error }, { status: patch.locked ? 409 : 400 });
    chatRetro = patch.next;
    deleteLessons = patch.deleteLessons;
  }

  const { deletedLessons } = await writeTeamExperimentFlags(r.teamId, {
    ...(enabledDecisionShadows !== undefined ? { enabledDecisionShadows } : {}),
    ...(chatRetro ? { chatRetro } : {}),
    deleteLessons,
  });
  const after = {
    ...before,
    ...(enabledDecisionShadows !== undefined ? { enabledDecisionShadows } : {}),
    ...(chatRetro ? { chatRetro } : {}),
  };
  await recordPlatformAdminAudit({
    actorAccountId: r.account.id,
    action: 'team.experiment_flags.update',
    targetType: 'team',
    targetId: r.teamId,
    teamId: r.teamId,
    before: { ...before },
    after: { ...after, ...(deletedLessons ? { deletedLessons } : {}) },
  });
  return NextResponse.json({ teamId: r.teamId, flags: after, deletedLessons });
}
