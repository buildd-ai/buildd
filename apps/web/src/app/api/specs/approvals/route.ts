import { NextRequest, NextResponse } from 'next/server';
import { countAwaitingApproval } from '@/lib/specs/approval-inbox';
import { specCaller } from '@/lib/specs/caller';

/**
 * GET /api/specs/approvals?workspaceId=: how many spec revisions wait for
 * approval, and the inbox link (lib/specs/approval-inbox.ts; Living Spec
 * b7fc9316 R-7). From a person (a dashboard or their own OAuth session) the
 * ones waiting on them; from an API key or task token the ones waiting in the
 * workspace. Read-only: it never returns a confirm token or anything that
 * approves.
 */
export async function GET(req: NextRequest) {
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const r = await countAwaitingApproval(caller, req.nextUrl.searchParams.get('workspaceId'));
  if (r.ok) return NextResponse.json({ count: r.count, scope: r.scope, inboxUrl: r.inboxUrl });
  return NextResponse.json({ error: r.error }, { status: r.status });
}
