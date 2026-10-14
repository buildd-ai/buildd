import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { approveDeviceCode } from '@/lib/device-approve';

function requestIp(req: NextRequest): string | null {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim() || null;
  return req.headers.get('x-real-ip');
}

// POST /api/auth/device/approve
// Requires session auth. Invariant: a device code is approved only by an
// explicit confirm. The body must carry `confirm: true` and the workspaces
// the person picked (`workspaceIds`); the device page sends both from the
// runner consent page (/api/auth/device/consent). There is no GET handler.
export async function POST(req: NextRequest) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { code, confirm, workspaceIds } = body;

    if (!code || typeof code !== 'string') {
      return NextResponse.json({ error: 'code is required' }, { status: 400 });
    }
    if (confirm !== true) {
      return NextResponse.json({
        error: 'Approving a device needs an explicit confirm. Open the device page and choose workspaces.',
      }, { status: 400 });
    }
    if (!Array.isArray(workspaceIds) || workspaceIds.length === 0) {
      return NextResponse.json({
        error: 'Choose the workspaces this runner claims from. Open the device page and choose workspaces.',
      }, { status: 400 });
    }

    const result = await approveDeviceCode({
      userId: session.user.id,
      code,
      workspaceIds,
      ip: requestIp(req),
      userAgent: req.headers.get('user-agent'),
    });
    if (!result.ok) return NextResponse.json({ error: result.message }, { status: result.status });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Device approve error:', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
