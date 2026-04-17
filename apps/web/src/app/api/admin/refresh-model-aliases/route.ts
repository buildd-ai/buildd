import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
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
 * Admin-level API key (or session auth with admin flag) required.
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (apiAccount && apiAccount.level !== 'admin') {
    return NextResponse.json({ error: 'Requires admin-level API key' }, { status: 403 });
  }

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
