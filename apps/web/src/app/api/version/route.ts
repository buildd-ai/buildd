import { NextRequest, NextResponse } from 'next/server';
import { getLatestVersion } from '@/lib/version-cache';
import { trackEvent } from '@/lib/axiom';

/**
 * GET /api/version
 *
 * Public endpoint (no auth) — returns the latest dev commit SHA.
 * Used by runner in serverless mode to poll for updates.
 */
export async function GET(req: NextRequest) {
  trackEvent('api.version.request', {
    userAgent: req.headers.get('user-agent'),
  });
  try {
    const version = await getLatestVersion();
    return NextResponse.json(version);
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Failed to fetch version' },
      { status: 502 },
    );
  }
}
