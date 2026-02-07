import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';

// POST /api/workers/[id]/activity - Report tool usage from Claude Code hooks
// This allows MCP workers to get automatic visibility via hooks
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);

  if (!account) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, id),
  });

  if (!worker) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  // Allow activity reports from the worker's owner OR any authenticated account
  // (hooks might run with different credentials)
  // For security, we still require valid API key

  const body = await req.json();
  const { toolName, toolInput, timestamp } = body;

  if (!toolName) {
    return NextResponse.json({ error: 'toolName is required' }, { status: 400 });
  }

  // Create milestone entry from tool call
  const milestoneLabel = formatToolLabel(toolName, toolInput);
  const currentMilestones = (worker.milestones as any[]) || [];

  // Dedupe - don't add if last milestone is identical and within 1 second
  const lastMilestone = currentMilestones[currentMilestones.length - 1];
  const now = timestamp || Date.now();
  if (lastMilestone &&
      lastMilestone.label === milestoneLabel &&
      Math.abs(lastMilestone.timestamp - now) < 1000) {
    return NextResponse.json({ ok: true, deduplicated: true });
  }

  const newMilestone = {
    label: milestoneLabel,
    timestamp: now,
  };

  // Update worker with new milestone and current action (cap at 50 to prevent JSONB bloat)
  const updatedMilestones = [...currentMilestones, newMilestone];
  if (updatedMilestones.length > 50) {
    updatedMilestones.splice(0, updatedMilestones.length - 50);
  }

  await db
    .update(workers)
    .set({
      milestones: updatedMilestones,
      currentAction: milestoneLabel,
      updatedAt: new Date(),
    })
    .where(eq(workers.id, id));

  return NextResponse.json({ ok: true, milestone: newMilestone });
}

// Format tool name and input into a readable label
function formatToolLabel(toolName: string, toolInput?: any): string {
  const name = toolName.toLowerCase();

  // Extract useful info from tool input
  let detail = '';
  if (toolInput) {
    if (typeof toolInput === 'string') {
      detail = toolInput.slice(0, 50);
    } else if (toolInput.file_path) {
      detail = toolInput.file_path.split('/').pop() || toolInput.file_path;
    } else if (toolInput.command) {
      detail = toolInput.command.slice(0, 40);
    } else if (toolInput.pattern) {
      detail = toolInput.pattern;
    } else if (toolInput.query) {
      detail = toolInput.query.slice(0, 40);
    }
  }

  // Map common tool names to readable labels
  switch (name) {
    case 'read':
      return detail ? `Read ${detail}` : 'Read file';
    case 'write':
      return detail ? `Write ${detail}` : 'Write file';
    case 'edit':
      return detail ? `Edit ${detail}` : 'Edit file';
    case 'bash':
      if (detail.startsWith('git commit')) return 'Git commit';
      if (detail.startsWith('git push')) return 'Git push';
      if (detail.startsWith('git ')) return 'Git operation';
      if (detail.includes('npm') || detail.includes('bun')) return 'Package operation';
      if (detail.includes('test')) return 'Run tests';
      return detail ? `Run: ${detail.slice(0, 30)}` : 'Run command';
    case 'grep':
      return detail ? `Search: ${detail}` : 'Search code';
    case 'glob':
      return detail ? `Find: ${detail}` : 'Find files';
    case 'webfetch':
    case 'web_fetch':
      return 'Fetch web page';
    case 'websearch':
    case 'web_search':
      return detail ? `Search: ${detail}` : 'Web search';
    default:
      return detail ? `${toolName}: ${detail.slice(0, 30)}` : toolName;
  }
}
