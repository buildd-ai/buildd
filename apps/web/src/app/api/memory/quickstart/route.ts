import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';

/**
 * POST /api/memory/quickstart
 *
 * Public onboarding endpoint — generates a Memory API key + ready-to-paste MCP config.
 * Creates a new team with a random ID and provisions an API key via the Memory service.
 *
 * Rate limited: 3 requests per IP per hour (in-memory).
 */

const MEMORY_API_URL = process.env.MEMORY_API_URL;
const MEMORY_ROOT_KEY = process.env.MEMORY_ROOT_KEY;

// Simple in-memory rate limiter (IP → timestamps[])
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 3;

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const timestamps = rateLimitMap.get(ip) ?? [];

  // Remove expired entries
  const valid = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  rateLimitMap.set(ip, valid);

  if (valid.length >= RATE_LIMIT_MAX) {
    return true;
  }

  valid.push(now);
  return false;
}

export async function POST(req: NextRequest) {
  if (!MEMORY_API_URL || !MEMORY_ROOT_KEY) {
    return NextResponse.json(
      { error: 'Memory service not configured' },
      { status: 503 },
    );
  }

  // Rate limit by IP
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  if (isRateLimited(ip)) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Try again later.' },
      { status: 429 },
    );
  }

  try {
    const teamId = `team_${randomBytes(8).toString('hex')}`;

    // Create team + API key via Memory service
    const res = await fetch(`${MEMORY_API_URL}/api/keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MEMORY_ROOT_KEY}`,
      },
      body: JSON.stringify({ teamId }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error('Memory API error:', res.status, body);
      return NextResponse.json(
        { error: 'Failed to create API key' },
        { status: 502 },
      );
    }

    const data = await res.json();
    const key = data.key as string;

    const mcpConfig = {
      mcpServers: {
        memory: {
          command: 'npx',
          args: ['-y', '@buildd/memory-plugin'],
          env: {
            BUILDD_MEMORY_API_KEY: key,
          },
        },
      },
    };

    return NextResponse.json({ key, teamId, mcpConfig });
  } catch (err: any) {
    console.error('Quickstart error:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
