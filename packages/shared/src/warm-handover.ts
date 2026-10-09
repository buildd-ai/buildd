/** Reuse is additionally gated by the cloud platform CONTAINER_REUSE kill switch. */
export type WarmHandover = 'off' | 'repo' | 'deps';
export function isWarmHandover(value: unknown): value is WarmHandover {
  return value === 'off' || value === 'repo' || value === 'deps';
}
/** A missing/null workspace override inherits the team; malformed policy fails closed. */
export function resolveWarmHandover(team: unknown, workspace: unknown): WarmHandover {
  const value = workspace ?? team ?? 'off';
  return isWarmHandover(value) ? value : 'off';
}
