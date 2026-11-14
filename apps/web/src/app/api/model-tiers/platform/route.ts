/**
 * The platform default model per tier (lib/admin/platform-tier-defaults.ts):
 * what every team without a registry row of its own runs, set by a platform
 * admin without a deploy.
 *
 * GET  → per tier: the effective model at platform level with its source
 *        (platform | policy | catalog | default), price, CLI floor and
 *        certification, the stored platform row, the staleness suggestion,
 *        and `canWrite`. Read through the same gate as the rest of
 *        /api/model-tiers: a signed-in member or an admin-level key.
 * PUT  { op: set | apply | clear | revert, tier, model?, reason?, confirm, confirmBandChange?, via? }
 *      → platform operators only (lib/admin/platform-operator-caller.ts); a
 *        team admin and a per-task token are refused. One shared function
 *        holds the admin check, the guard rails and the audit row, so the
 *        Settings section and the `manage_platform_tiers` MCP action that call
 *        this route cannot disagree with it.
 *
 * Statuses: 400 bad body, 403 not an operator, 409 confirm / band confirm /
 * no change / nothing to revert / conflict, 422 model refused (not in the
 * catalog, not certified, retired), 503 catalog unreadable. The body carries
 * `code` and `error`, and `detail` where there is more to say.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticate } from '@/lib/model-tier-access';
import {
  applyPlatformTierDefaultChange,
  parsePlatformTierChange,
  readPlatformTierDefaults,
  type PlatformTierCaller,
} from '@/lib/admin/platform-tier-defaults';
import { platformTierDefaultsDeps } from '@/lib/admin/platform-tier-defaults-deps';

function callerOf(auth: { user: { id: string; email?: string | null } | null; apiAccount: { id: string; level?: string | null; oauthUserId?: string | null } | null }): PlatformTierCaller {
  return { user: auth.user, account: auth.apiAccount, principal: auth.apiAccount ? 'key' : 'person' };
}

export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if ('error' in auth) return auth.error;
  try {
    return NextResponse.json(await readPlatformTierDefaults(callerOf(auth), platformTierDefaultsDeps()));
  } catch (error) {
    console.error('GET /api/model-tiers/platform error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const auth = await authenticate(req);
  if ('error' in auth) return auth.error;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'bad_request' }, { status: 400 });
  }
  const parsed = parsePlatformTierChange(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, code: parsed.code }, { status: parsed.status });
  try {
    const result = await applyPlatformTierDefaultChange(callerOf(auth), parsed.change, platformTierDefaultsDeps());
    if (!result.ok) {
      return NextResponse.json({ error: result.error, code: result.code, ...(result.detail ? { detail: result.detail } : {}) }, { status: result.status });
    }
    return NextResponse.json(result);
  } catch (error) {
    console.error('PUT /api/model-tiers/platform error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
