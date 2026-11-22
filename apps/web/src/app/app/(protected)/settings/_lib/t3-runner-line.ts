/**
 * What a runner says about serving T3 Code over ACP. buildd's server cannot see
 * T3, so this is only the runner's own report (`environment.acp.ready`, written
 * by the runner on its heartbeat). A runner that never reported shows "unknown"
 * rather than a guess.
 */
export type AcpLineState = 'ready' | 'not-ready' | 'unknown';
export interface AcpLine { state: AcpLineState; label: string }

export function acpLineFor(environment: unknown): AcpLine {
  const acp = (environment as { acp?: { ready?: unknown } } | null | undefined)?.acp;
  const ready = acp && typeof acp === 'object' ? acp.ready : undefined;
  if (ready === true) return { state: 'ready', label: 'Ready' };
  if (ready === false) return { state: 'not-ready', label: 'Not ready' };
  return { state: 'unknown', label: 'Unknown, update the runner' };
}
