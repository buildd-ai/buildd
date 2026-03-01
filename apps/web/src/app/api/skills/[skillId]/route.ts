import { NextResponse } from 'next/server';

// Team-level skills have been removed. Use workspace-scoped skills instead:
// PATCH/DELETE /api/workspaces/[id]/skills/[skillId]

export async function PATCH() {
  return NextResponse.json(
    { error: 'Team-level skills have been removed. Use /api/workspaces/[id]/skills/[skillId] instead.' },
    { status: 410 }
  );
}

export async function DELETE() {
  return NextResponse.json(
    { error: 'Team-level skills have been removed. Use /api/workspaces/[id]/skills/[skillId] instead.' },
    { status: 410 }
  );
}
