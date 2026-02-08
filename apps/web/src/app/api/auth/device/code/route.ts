import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { deviceCodes } from '@buildd/core/db/schema';
import { randomBytes } from 'crypto';

const EXPIRY_MINUTES = 15;

// Generate a human-readable code like "ABCD-1234"
function generateUserCode(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // Exclude I, O to avoid confusion
  const digits = '0123456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += letters[Math.floor(Math.random() * letters.length)];
  }
  code += '-';
  for (let i = 0; i < 4; i++) {
    code += digits[Math.floor(Math.random() * digits.length)];
  }
  return code;
}

function generateDeviceToken(): string {
  return randomBytes(32).toString('hex');
}

// POST /api/auth/device/code
// No auth required. Generates a user code + device token pair.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const clientName = body.clientName || 'CLI';
    const level = body.level === 'worker' ? 'worker' : 'admin';

    const userCode = generateUserCode();
    const deviceToken = generateDeviceToken();
    const expiresAt = new Date(Date.now() + EXPIRY_MINUTES * 60 * 1000);

    await db.insert(deviceCodes).values({
      userCode,
      deviceToken,
      clientName,
      level,
      expiresAt,
    });

    // Build verification URL
    const baseUrl = process.env.AUTH_URL || process.env.NEXTAUTH_URL || 'https://buildd.dev';
    const verificationUrl = `${baseUrl}/app/device?code=${userCode}`;

    return NextResponse.json({
      user_code: userCode,
      device_token: deviceToken,
      verification_url: verificationUrl,
      expires_in: EXPIRY_MINUTES * 60,
      interval: 5,
    });
  } catch (error) {
    console.error('Device code generation error:', error);
    return NextResponse.json({ error: 'Failed to generate device code' }, { status: 500 });
  }
}
