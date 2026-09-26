/**
 * A story `tool` event → the action milestone a runner writes for that tool
 * call: structured `{tool, path, add, rem, cmd, count}` plus the legacy label
 * (apps/runner/src/tool-milestones.ts is the real writer).
 */
export function toolMilestone(e: Record<string, any>, ts: number): Record<string, unknown> {
  const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;
  const tool = String(e.tool);
  const label = tool === 'Bash'
    ? `Ran: ${String(e.cmd ?? '').slice(0, 50)}`
    : `${tool === 'Write' ? 'Wrote' : tool === 'Read' ? 'Read' : 'Edited'} ${base(String(e.path ?? 'file'))}`;
  return {
    type: 'action', label, ts, tool,
    ...(e.path != null ? { path: e.path } : {}),
    ...(e.cmd != null ? { cmd: e.cmd } : {}),
    ...(tool !== 'Read' && tool !== 'Bash' ? { add: e.add ?? 0, rem: e.rem ?? 0 } : {}),
    ...(e.count != null ? { count: e.count } : {}),
  };
}
