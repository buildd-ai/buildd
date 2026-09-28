import { tryLock } from '@/lib/redis';

/**
 * One explicit claim attempt per (task, account) per window, for a person's
 * interactive session. Those claims skip the per-runner cooldown (there is no
 * runner loop to break), so this is what stops a script or a looping agent on
 * an MCP session from hammering one task.
 *
 * Redis (SET NX EX) when configured, so the window holds across instances;
 * otherwise a per-instance map, which still bounds a single hot loop.
 */
export const EXPLICIT_CLAIM_WINDOW_SEC = 10;

const local = new Map<string, number>();
const LOCAL_MAX = 10_000;

/** Test hook. */
export function resetExplicitClaimRateLimit(): void {
  local.clear();
}

/** True = allowed (and the window is now armed); false = inside the window. */
export async function allowExplicitClaim(
  taskId: string,
  accountId: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const key = `buildd:explicit-claim:${accountId}:${taskId}`;
  const remote = await tryLock(key, EXPLICIT_CLAIM_WINDOW_SEC);
  if (remote !== null) return remote;
  const prev = local.get(key);
  if (prev !== undefined && nowMs - prev < EXPLICIT_CLAIM_WINDOW_SEC * 1000) return false;
  if (local.size >= LOCAL_MAX) local.clear();
  local.set(key, nowMs);
  return true;
}
