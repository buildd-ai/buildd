import { NextRequest, NextResponse } from 'next/server';
import { requireSessionUser } from '@/lib/auth-helpers';
import { createSubscription, listSubscriptions, type SubscriptionSubject } from '@/lib/subscriptions';
import { prSubject, taskSubject, TERMINAL_TASK_STATUSES, watchLabels } from '@/lib/watch-subjects';
import { watchEventTypes } from '@/lib/watch-notice';

/** Live watches per person (knowledge-base: buildd/design/subscriptions-and-notifications.md → Limits). */
export const MAX_ACTIVE_WATCHES = 25;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

/**
 * GET /api/subscriptions → { subscriptions: Array<Subscription & { label }> }
 *
 * The signed-in person's live watches (not ended, not expired), newest first.
 * Every row carries its teamId and workspaceId, which is what chat's reach
 * filter reads.
 */
export async function GET(req: NextRequest) {
  const s = await requireSessionUser(req);
  if (s.response) return s.response;
  const subs = await listSubscriptions({ userId: s.user.id });
  const labels = await watchLabels(subs);
  return NextResponse.json({ subscriptions: subs.map(x => ({ ...x, label: labels.get(x.id) ?? null })) });
}

/**
 * POST /api/subscriptions — watch one task or PR, once.
 *
 * Body: `{ taskId }` or `{ workspaceId, prNumber }`, plus optional
 * `eventTypes` (defaults: a task when it finishes or fails, a PR when it
 * merges) and `conversationId` (where it is delivered; must be the caller's).
 * P1 has one-shot watches only: `lifetime: 'standing'` is refused.
 *
 * Visibility first: 404 when the subject does not exist or the caller can't
 * see it, the same answer either way. Only for a visible subject: 400 (no
 * repo linked) or 409 (already ended, so the watch could never fire).
 */
export async function POST(req: NextRequest) {
  const s = await requireSessionUser(req);
  if (s.response) return s.response;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return bad('Invalid JSON'); }
  if (!body || typeof body !== 'object') return bad('Invalid JSON');

  if (body.lifetime !== undefined && body.lifetime !== 'one_shot') {
    return bad('Only one-shot watches are available: it tells you once, then ends.');
  }
  const hasTask = body.taskId !== undefined && body.taskId !== null;
  const hasPr = body.prNumber !== undefined && body.prNumber !== null;
  if (hasTask === hasPr) return bad('Name one thing to watch: taskId, or workspaceId with prNumber.');

  const conversationId = typeof body.conversationId === 'string' && UUID_RE.test(body.conversationId) ? body.conversationId : null;
  let subject: SubscriptionSubject;

  if (hasTask) {
    if (typeof body.taskId !== 'string' || !UUID_RE.test(body.taskId)) return bad('taskId must be a task id');
    const task = await taskSubject(body.taskId, s.user.id);
    if (!task) return bad('Task not found', 404);
    if ((TERMINAL_TASK_STATUSES as readonly string[]).includes(task.status)) {
      return NextResponse.json({ error: 'subject_ended', message: `That task is already ${task.status}, so there is nothing left to watch for.` }, { status: 409 });
    }
    subject = { kind: 'task', taskId: task.id };
  } else {
    const n = typeof body.prNumber === 'number' ? body.prNumber : Number(body.prNumber);
    if (!Number.isInteger(n) || n <= 0) return bad('prNumber must be a positive whole number');
    if (typeof body.workspaceId !== 'string' || !UUID_RE.test(body.workspaceId)) return bad('workspaceId is required to watch a PR');
    const pr = await prSubject(body.workspaceId, n, s.user.id);
    if (!pr.ok) {
      return pr.reason === 'no_repo'
        ? bad('That workspace has no GitHub repo linked, so its PRs cannot be watched.')
        : bad('Workspace not found', 404);
    }
    if (pr.merged) {
      return NextResponse.json({ error: 'subject_ended', message: `#${n} has already merged, so there is nothing left to watch for.` }, { status: 409 });
    }
    subject = { kind: 'pr', workspaceId: body.workspaceId, repoFullName: pr.repoFullName, prNumber: n };
  }

  const eventTypes = watchEventTypes(subject.kind, body.eventTypes);
  if (eventTypes.length === 0) return bad(`Those events don't apply to a ${subject.kind === 'pr' ? 'PR' : 'task'}.`);

  const owner = { userId: s.user.id };
  if ((await listSubscriptions(owner)).length >= MAX_ACTIVE_WATCHES) {
    return bad(`You already have ${MAX_ACTIVE_WATCHES} watches running. Stop one first.`, 429);
  }

  const sub = await createSubscription({
    owner, subject, eventTypes, lifetime: 'one_shot', conversationId,
    createdVia: conversationId ? 'chat' : 'settings',
  });
  if (!sub) return bad('Not found', 404);
  return NextResponse.json({ subscription: sub }, { status: 201 });
}
