import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { loadWaitingInput } from '@/lib/waiting-input';

/**
 * GET /api/tasks/waiting-input[?fresh=1]: the questions waiting on the signed-in
 * user, scoped to their teams in SQL and kept 30 s (lib/waiting-input.ts).
 */
export async function GET(req?: NextRequest) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const fresh = req?.nextUrl?.searchParams.get('fresh') === '1';
    return NextResponse.json({ tasks: await loadWaitingInput(user.id, { fresh }) });
  } catch (error) {
    console.error('Error fetching waiting-input tasks:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
