/**
 * GET /api/workers/estimates?ids=<workerId>,<workerId>
 *
 * The calling runner's own workers' task estimates in minutes (null without
 * one), for the update window's finish-or-pause decision (spec 47c97f48 R-2,
 * lib/worker-estimates.ts). Only this account's workers are answered; at most
 * 50 ids. Read-only.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey } from '@/lib/api-auth';
import { loadWorkerEstimates } from '@/lib/worker-estimates';

export async function GET(req: NextRequest) {
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey, req);
  if (!account) return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  if ((account as any).level === 'trigger') {
    return NextResponse.json({ error: 'Trigger tokens run no workers.' }, { status: 403 });
  }
  const ids = (req.nextUrl.searchParams.get('ids') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  try {
    const estimates = await loadWorkerEstimates((account as any).id, ids);
    return NextResponse.json({ estimates });
  } catch (err) {
    console.error('[workers/estimates] failed:', err);
    return NextResponse.json({ error: 'Failed to load estimates' }, { status: 500 });
  }
}
