import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformOwner } from '@/lib/admin/owner-gate';
import { readPusherUsage } from '@/lib/pusher-usage';

const MAX_DAYS = 35;

/**
 * GET /api/admin/pusher-usage — platform owner only (404 otherwise).
 *
 * Pusher publishes per UTC day, by event and channel kind (lib/pusher-usage.ts).
 * Pusher bills each publish once per subscribed connection; `onRunnerChannels`
 * is the share every runner connection receives. Query: days (1-35, default 7).
 */
export async function GET(req: NextRequest) {
  const gate = await requirePlatformOwner(req);
  if (gate.response) return gate.response;
  const raw = Number(req.nextUrl.searchParams.get('days') ?? 7);
  if (!Number.isInteger(raw) || raw < 1 || raw > MAX_DAYS) {
    return NextResponse.json({ error: `days must be an integer from 1 to ${MAX_DAYS}` }, { status: 400 });
  }
  const days = await readPusherUsage(raw);
  if (!days) return NextResponse.json({ error: 'Redis unavailable' }, { status: 503 });
  return NextResponse.json({ days });
}
