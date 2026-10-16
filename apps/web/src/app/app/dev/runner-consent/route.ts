/**
 * Dev fixture: the runner consent pages with fake data, for visual review.
 * The real routes need a signed-in person with teams, which the Visual QA
 * harness does not have; this renders the same HTML with placeholder teams.
 * No database, no session, no key is minted, and the form posts to a path
 * that does not exist. Not served in production.
 *
 *   /app/dev/runner-consent?state=cli     `buildd login`: three teams, a restricted workspace offered to an admin only, a long name
 *   /app/dev/runner-consent?state=single  one workspace, ticked for them
 *   /app/dev/runner-consent?state=device  `buildd login --device`, the code in the lede
 *   /app/dev/runner-consent?state=edit    Settings' Edit: current picks, one removed by a team admin, one no longer reachable
 *   /app/dev/runner-consent?state=error   an approval with nothing ticked
 */
import { NextRequest, NextResponse } from 'next/server';
import { RUNNER_CONSENT_HEADERS } from '@/lib/runner-consent';
import { isRunnerConsentFixtureState, renderRunnerConsentFixture } from './runner-consent-fixtures';

export const dynamic = 'force-dynamic';

function notFound(message: string) {
  return new NextResponse(message, { status: 404, headers: { 'content-type': 'text/plain' } });
}

export async function GET(req: NextRequest) {
  if (process.env.NODE_ENV === 'production') return notFound('Not found');
  const state = req.nextUrl.searchParams.get('state') ?? 'cli';
  if (!isRunnerConsentFixtureState(state)) return notFound(`Unknown state "${state}"`);
  return new NextResponse(renderRunnerConsentFixture(state), { status: 200, headers: RUNNER_CONSENT_HEADERS });
}
