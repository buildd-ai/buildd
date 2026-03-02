import { NextResponse } from 'next/server';

// Team-level skills have been removed. Use workspace-scoped skills instead:
// GET/POST /api/workspaces/[id]/skills

export async function GET() {
  return NextResponse.json(
    { error: 'Team-level skills have been removed. Use /api/workspaces/[id]/skills instead.' },
    { status: 410 }
  );
}

export async function POST() {
  return NextResponse.json(
    { error: 'Team-level skills have been removed. Use /api/workspaces/[id]/skills instead.' },
    { status: 410 }
  );
}
