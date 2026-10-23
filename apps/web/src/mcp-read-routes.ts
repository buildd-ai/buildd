/**
 * Composition root for in-process MCP reads (lib/mcp-local-reads.ts, spec
 * 3ef37387 R-22): it imports route modules of every module, so it is listed in
 * scripts/module-boundaries.ts COMPOSITION_ROOTS.
 *
 * Kept out of modules.ts on purpose. Dozens of routes import modules.ts, and a
 * route table there put every route below into each of their server bundles:
 * `next build` then ran out of memory in compile. Only lib/mcp-local-reads.ts
 * (behind the MCP route) may import this file.
 */
import type { LocalRead } from '@/lib/mcp-local-reads';

/**
 * The read routes MCP actions run in-process (lib/mcp-local-reads.ts, spec
 * 3ef37387 R-22). The most specific entry wins (as Next.js routes), whatever the order.
 */
export const MCP_LOCAL_READS: readonly LocalRead[] = [
  { path: '/api/tasks', load: () => import('@/app/api/tasks/route') },
  { path: '/api/tasks/:id', load: () => import('@/app/api/tasks/[id]/route') },
  { path: '/api/tasks/:id/messages', load: () => import('@/app/api/tasks/[id]/messages/route') },
  { path: '/api/tasks/:id/evidence', load: () => import('@/app/api/tasks/[id]/evidence/route') },
  { path: '/api/workspaces', load: () => import('@/app/api/workspaces/route') },
  { path: '/api/workspaces/by-repo', load: () => import('@/app/api/workspaces/by-repo/route') },
  { path: '/api/workspaces/across/:list', load: () => import('@/app/api/workspaces/across/[list]/route') },
  { path: '/api/workspaces/:id', load: () => import('@/app/api/workspaces/[id]/route') },
  { path: '/api/workspaces/:id/artifacts', load: () => import('@/app/api/workspaces/[id]/artifacts/route') },
  { path: '/api/workspaces/:id/schedules', load: () => import('@/app/api/workspaces/[id]/schedules/route') },
  { path: '/api/workspaces/:id/skills', load: () => import('@/app/api/workspaces/[id]/skills/route') },
  { path: '/api/workspaces/:id/readiness', load: () => import('@/app/api/workspaces/[id]/readiness/route') },
  { path: '/api/workspaces/:id/error-traces', load: () => import('@/app/api/workspaces/[id]/error-traces/route') },
  { path: '/api/missions', load: () => import('@/app/api/missions/route') },
  { path: '/api/missions/:id', load: () => import('@/app/api/missions/[id]/route') },
  { path: '/api/missions/:id/artifacts', load: () => import('@/app/api/missions/[id]/artifacts/route') },
  { path: '/api/prs', load: () => import('@/app/api/prs/route') },
  { path: '/api/github/pr', load: () => import('@/app/api/github/pr/route') },
  { path: '/api/artifacts/linked', load: () => import('@/app/api/artifacts/linked/route') },
  { path: '/api/artifacts/:artifactId', load: () => import('@/app/api/artifacts/[artifactId]/route') },
  { path: '/api/initiatives', load: () => import('@/app/api/initiatives/route') },
  { path: '/api/initiatives/:id', load: () => import('@/app/api/initiatives/[id]/route') },
  { path: '/api/initiatives/:id/artifacts', load: () => import('@/app/api/initiatives/[id]/artifacts/route') },
  { path: '/api/releases', load: () => import('@/app/api/releases/route') },
  { path: '/api/releases/status', load: () => import('@/app/api/releases/status/route') },
  { path: '/api/releases/:id', load: () => import('@/app/api/releases/[id]/route') },
  { path: '/api/roles', load: () => import('@/app/api/roles/route') },
  { path: '/api/roles/:id', load: () => import('@/app/api/roles/[id]/route') },
  { path: '/api/explain', load: () => import('@/app/api/explain/route') },
  { path: '/api/discrepancies', load: () => import('@/app/api/discrepancies/route') },
  { path: '/api/discrepancies/:id', load: () => import('@/app/api/discrepancies/[id]/route') },
  { path: '/api/health/failures', load: () => import('@/app/api/health/failures/route') },
  { path: '/api/health/dispatch', load: () => import('@/app/api/health/dispatch/route') },
  { path: '/api/stats/coordination', load: () => import('@/app/api/stats/coordination/route') },
  { path: '/api/stats/usage', load: () => import('@/app/api/stats/usage/route') },
  { path: '/api/specs/outcomes/:taskId', load: () => import('@/app/api/specs/outcomes/[taskId]/route') },
  { path: '/api/workers/:id', load: () => import('@/app/api/workers/[id]/route') },
];

/**
 * Routes outside MCP_LOCAL_READS that Next.js serves in place of an entry's
 * dynamic segment (`/api/missions/capabilities`, not mission "capabilities"):
 * a path one of these matches goes over HTTP. Derived from the routes on disk;
 * lib/mcp-local-reads.test.ts fails, with the list it expects, when this drifts.
 */
export const MCP_LOCAL_READ_SHADOWS: readonly string[] = [
  '/api/artifacts/designs',
  '/api/artifacts/upload-url',
  '/api/missions/capabilities',
  '/api/missions/recent',
  '/api/missions/stages',
  '/api/releases/compose',
  '/api/releases/readiness',
  '/api/releases/trigger',
  '/api/tasks/bulk',
  '/api/tasks/cleanup',
  '/api/tasks/waiting-input',
  '/api/workers/active',
  '/api/workers/claim',
  '/api/workers/heartbeat',
  '/api/workers/local-sessions',
  '/api/workers/mine',
  '/api/workers/queue',
  '/api/workers/status',
  '/api/workspaces/match-repos',
];
