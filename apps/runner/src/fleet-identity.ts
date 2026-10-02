/**
 * The fleet identity a `--once` run puts on its heartbeat
 * (packages/shared/src/runner-fleet.ts). Long-lived runners send none.
 */
import type { RunnerFleetIdentity, WorkerEnvironment } from '@buildd/shared';

/**
 * The heartbeat environment with `fleet` set. Before the environment scan
 * finishes there is no environment yet; the identity is sent anyway on an
 * empty one, so the first heartbeat of a short run already names its group.
 */
export function withFleetIdentity(
  environment: WorkerEnvironment | undefined,
  fleet: RunnerFleetIdentity | undefined,
): WorkerEnvironment | undefined {
  if (!fleet) return environment;
  const base: WorkerEnvironment = environment ?? { tools: [], envKeys: [], mcp: [], labels: {}, scannedAt: new Date().toISOString() };
  return { ...base, fleet };
}
