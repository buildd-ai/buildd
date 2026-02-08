import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { validateCronExpression, computeNextRuns, describeSchedule } from '@/lib/schedule-helpers';

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const cron = req.nextUrl.searchParams.get('cron');
  const timezone = req.nextUrl.searchParams.get('timezone') || 'UTC';

  if (!cron) {
    return NextResponse.json({ valid: false, description: 'No expression provided' });
  }

  const error = validateCronExpression(cron);
  if (error) {
    return NextResponse.json({ valid: false, description: error });
  }

  const description = describeSchedule(cron);
  const nextRuns = computeNextRuns(cron, timezone, 3).map((d) =>
    d.toLocaleString('en-US', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' })
  );

  return NextResponse.json({ valid: true, description, nextRuns });
}
