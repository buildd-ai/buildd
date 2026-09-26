/**
 * GET /api/objects/[kind]/[id] — one live buildd object as the chat feed
 * renders it (docs/design/agent-chat.md, "Objects in the feed").
 *
 * A message part stores a `BuilddObjectRef`, never a snapshot; the inline card
 * and the docked pane fetch the object's current view here and refetch when its
 * Pusher channel says it changed. Read-only, session users only, and scoped by
 * the same access checks the object's own page uses — a ref naming an object in
 * another team's workspace is a 404, like any id the user can't see.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { isUuid } from '@/lib/uuid';
import { loadMissionObject } from '@/lib/chat-objects/load-mission-object';
import { loadTaskObject } from '@/lib/chat-objects/load-task-object';
import { loadPrObject, parsePrRefId } from '@/lib/chat-objects/load-pr-object';
import { loadQuestionObject } from '@/lib/chat-objects/load-question-object';
import type { ObjectView } from '@/components/chat/objects/object-views';

const LOADERS: Record<string, (id: string, userId: string) => Promise<ObjectView | null>> = {
  mission: loadMissionObject,
  task: loadTaskObject,
  pr: loadPrObject,
  question: loadQuestionObject,
};

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ kind: string; id: string }> },
) {
  const { kind, id: pathId } = await params;
  // `owner/repo#n` can't ride in a path segment, so a PR named that way comes
  // as `/api/objects/pr/ref?ref=owner%2Frepo%23n`.
  const id = kind === 'pr' && pathId === 'ref' ? req.nextUrl.searchParams.get('ref') ?? '' : pathId;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });

  const load = Object.prototype.hasOwnProperty.call(LOADERS, kind) ? LOADERS[kind] : undefined;
  if (!load) return NextResponse.json({ error: 'Unknown object kind' }, { status: 400, headers: NO_STORE });
  // A PR is also named by its `owner/repo#n` (the chat contract's PR ref id).
  const validId = isUuid(id) || (kind === 'pr' && parsePrRefId(id) !== null);
  if (!validId) return NextResponse.json({ error: 'Invalid id' }, { status: 400, headers: NO_STORE });

  try {
    const view = await load(id, user.id);
    if (!view) return NextResponse.json({ error: 'Not found' }, { status: 404, headers: NO_STORE });
    return NextResponse.json(view, { headers: NO_STORE });
  } catch (err) {
    console.error(`[objects] ${kind} load failed:`, err);
    return NextResponse.json({ error: 'Failed to load object' }, { status: 500, headers: NO_STORE });
  }
}
