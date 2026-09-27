import type { NextRequest } from 'next/server';
import { handleUsageRequest } from '@/lib/ai/handlers';
import { usageDeps } from '@/lib/ai/deps';

// POST /api/ai/usage — content-free, identity-free usage receipts from sibling
// apps (docs/design/shared-ai-kit.md §2). Schema: apps/web/src/lib/ai/usage.ts.
export async function POST(req: NextRequest) {
  return handleUsageRequest(req, usageDeps);
}
