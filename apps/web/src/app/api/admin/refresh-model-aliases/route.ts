import { NextRequest, NextResponse } from 'next/server';
import { authorizePlatformAdmin } from '@/lib/platform-admin';
import { updateModelAliases, DEFAULT_ALIASES } from '@buildd/core/model-aliases';

/**
 * POST /api/admin/refresh-model-aliases
 *
 * Refresh the system_cache.model_aliases entry without waiting out the 1-hour TTL
 * or needing a deploy. Lets you point `opus` / `sonnet` / `haiku` aliases at newly
 * released Claude versions immediately.
 *
 * Request body (optional): `{ haiku?: string, sonnet?: string, opus?: string }`.
 * If omitted for any alias, the current DEFAULT_ALIASES value is kept.
 *
 * Auth: platform admin API key only (BUILDD_PLATFORM_ADMIN_ACCOUNT_IDS, see
 * lib/platform-admin.ts). The write target is the single global system_cache
 * model-alias row (not tenant-scoped), so neither a team-admin key nor a
 * session is sufficient.
 */
export async function POST(req: NextRequest) {
  const gate = await authorizePlatformAdmin(req);
  if (gate.response) return gate.response;

  let body: { haiku?: string; sonnet?: string; opus?: string } = {};
  try {
    body = (await req.json().catch(() => ({}))) ?? {};
  } catch {
    body = {};
  }

  const aliases = {
    haiku: body.haiku || DEFAULT_ALIASES.haiku,
    sonnet: body.sonnet || DEFAULT_ALIASES.sonnet,
    opus: body.opus || DEFAULT_ALIASES.opus,
  };

  // updateModelAliases expects `{ value, label? }[]`; pass each entry so the name
  // substring match classifies them into the right slot.
  await updateModelAliases([
    { value: aliases.haiku },
    { value: aliases.sonnet },
    { value: aliases.opus },
  ]);

  return NextResponse.json({ aliases });
}
