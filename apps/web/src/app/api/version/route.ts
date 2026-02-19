import { NextResponse } from 'next/server';
import { getLatestVersion } from '@/lib/version-cache';

/**
 * GET /api/version
 *
 * Public endpoint (no auth) — returns the latest dev commit SHA.
 * Used by local-ui in serverless mode to poll for updates.
 */
export async function GET() {
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
