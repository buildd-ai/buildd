import type { NextRequest } from 'next/server';
import { handlePlanRequest } from '@/lib/ai/handlers';
import { planDeps } from '@/lib/ai/deps';

// POST /api/ai/plan — which model a sibling app should call for a tier, and
// whether it may spend (docs/design/shared-ai-kit.md §2). Contract and
// decision rules: apps/web/src/lib/ai/plan.ts.
export async function POST(req: NextRequest) {
  return handlePlanRequest(req, planDeps);
}
