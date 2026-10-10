import { isPersonalKeyProvider } from '@builddai/ai-kit/models/provider-keys';
import { NextRequest, NextResponse } from 'next/server';
import { requireSessionUser } from '@/lib/auth-helpers';
import { getUserTeamIds, resolveActiveTeamId } from '@/lib/team-access';
import { can } from '@/lib/permissions';
import { listProviderKeys } from '@/lib/provider-keys';
import { removeChatKey, sharedWritePermissions, writeChatKey, writeTeamChatKey } from '@/lib/providers/write-path';
import { resolveChatModel } from '@/lib/chat/models';
import type { ChatUses, SetProviderKeyRequest } from '@buildd/shared';

/**
 * Provider keys for chat, inference and decision calls.
 *
 *   GET    /api/inference-keys?teamId=                      → ListProviderKeysResponse
 *   PUT    /api/inference-keys  { teamId, provider, scope, value } → SetProviderKeyResponse
 *   DELETE /api/inference-keys?teamId=&provider=&scope=     → DeleteProviderKeyResponse
 *
 * Session only: a personal key belongs to a person, and API keys are not
 * people. `scope: 'team'` writes need team owner/admin: for a key agent runs
 * read too (Anthropic, OpenAI), `manage_team_model_keys` and
 * `manage_team_credentials`, the rule of every agent-credential write; for a
 * chat-only key, `manage_inference_providers`. Plaintext never leaves
 * the server — responses carry the last four characters and health.
 *
 * Writes go through the one provider write path (`@/lib/providers/write-path`),
 * which `/api/providers` also uses; this route keeps its own request and
 * response shapes.
 */

type Caller = { userId: string; teamId: string; isAdmin: boolean };

async function resolveCaller(
  req: NextRequest,
  requestedTeamId: string | null | undefined,
): Promise<{ caller: Caller } | { response: Response }> {
  const session = await requireSessionUser(req);
  if (session.response) return { response: session.response };
  const userId = session.user.id;

  const teamIds = await getUserTeamIds(userId);
  if (teamIds.length === 0) return { response: NextResponse.json({ error: 'No team found' }, { status: 403 }) };
  // No teamId ⇒ the session's ACTIVE team (the `buildd-team` cookie), not
  // whichever membership row happens to come first.
  const teamId = requestedTeamId
    || await resolveActiveTeamId(userId, req.cookies.get('buildd-team')?.value ?? null);
  if (!teamId || !teamIds.includes(teamId)) return { response: NextResponse.json({ error: 'Team not found' }, { status: 404 }) };

  const isAdmin = await can({ kind: 'user', userId }, 'manage_inference_providers', teamId);
  return { caller: { userId, teamId, isAdmin } };
}

/**
 * What this person's chat turn resolves to, by the same resolver a turn uses
 * (the default tier, `FALLBACK_TIER`, and no workspace, like chat
 * availability), so Settings reports the real provider and
 * whose key pays instead of guessing from the key list. Null when nothing
 * resolves or the lookup fails.
 */
async function resolveChatUses(teamId: string, userId: string): Promise<ChatUses | null> {
  try {
    const m = await resolveChatModel({ tier: 'standard', teamId, workspaceId: null, userId });
    if (!m.ok) return null;
    return { provider: m.provider, scope: m.keyScope, ...(m.via ? { via: m.via } : {}) };
  } catch (error) {
    console.warn('[inference-keys] chat route lookup failed:', error);
    return null;
  }
}

/**
 * May this caller write or remove the team's key for this provider? A key
 * agent runs read (Anthropic, OpenAI) takes the rule every write of an agent
 * credential takes (`sharedWritePermissions`: manage_team_model_keys and
 * manage_team_credentials); a chat-only key keeps manage_inference_providers.
 */
async function mayManageTeamKey(caller: Caller, provider: string): Promise<boolean> {
  const needs = sharedWritePermissions('inference_key', provider);
  if (!needs || !needs.includes('manage_team_credentials')) return caller.isAdmin;
  for (const p of needs) {
    if (!(await can({ kind: 'user', userId: caller.userId }, p, caller.teamId))) return false;
  }
  return true;
}

function parseScope(value: unknown): 'user' | 'team' | null {
  return value === 'user' || value === 'team' ? value : null;
}

const TEAM_ADMIN_ONLY = 'Only a team owner or admin can manage the team key.';

export async function GET(req: NextRequest) {
  const r = await resolveCaller(req, req.nextUrl.searchParams.get('teamId'));
  if ('response' in r) return r.response;
  const { userId, teamId, isAdmin } = r.caller;
  try {
    const [list, chatUses] = await Promise.all([listProviderKeys(teamId, userId, isAdmin), resolveChatUses(teamId, userId)]);
    return NextResponse.json({ ...list, chatUses });
  } catch (error) {
    console.error('[inference-keys] list failed:', error);
    return NextResponse.json({ error: 'Failed to list provider keys' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  let body: Partial<SetProviderKeyRequest>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const r = await resolveCaller(req, body.teamId);
  if ('response' in r) return r.response;
  const { userId, teamId } = r.caller;

  if (!isPersonalKeyProvider(body.provider)) {
    return NextResponse.json({ error: 'Unsupported standalone key provider' }, { status: 400 });
  }
  const scope = parseScope(body.scope);
  if (!scope) return NextResponse.json({ error: "scope must be 'user' or 'team'" }, { status: 400 });
  if (typeof body.value !== 'string' || !body.value.trim()) {
    return NextResponse.json({ error: 'value is required' }, { status: 400 });
  }
  if (scope === 'team' && !(await mayManageTeamKey(r.caller, body.provider))) {
    return NextResponse.json({ error: TEAM_ADMIN_ONLY }, { status: 403 });
  }

  try {
    if (scope === 'team') {
      const result = await writeTeamChatKey({ teamId, userId, provider: body.provider, value: body.value });
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
      return NextResponse.json({ key: result.key, requeued: result.requeued });
    }
    const result = await writeChatKey({ teamId, userId, provider: body.provider, scope, value: body.value });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ key: result.key });
  } catch (error) {
    console.error('[inference-keys] set failed:', error);
    return NextResponse.json({ error: 'Failed to save provider key' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const r = await resolveCaller(req, params.get('teamId'));
  if ('response' in r) return r.response;
  const { userId, teamId } = r.caller;

  const provider = params.get('provider');
  if (!isPersonalKeyProvider(provider)) {
    return NextResponse.json({ error: 'Unsupported standalone key provider' }, { status: 400 });
  }
  const scope = parseScope(params.get('scope'));
  if (!scope) return NextResponse.json({ error: "scope must be 'user' or 'team'" }, { status: 400 });
  if (scope === 'team' && !(await mayManageTeamKey(r.caller, provider))) {
    return NextResponse.json({ error: TEAM_ADMIN_ONLY }, { status: 403 });
  }

  try {
    return NextResponse.json({ deleted: await removeChatKey({ teamId, userId, provider, scope }) });
  } catch (error) {
    console.error('[inference-keys] delete failed:', error);
    return NextResponse.json({ error: 'Failed to delete provider key' }, { status: 500 });
  }
}
