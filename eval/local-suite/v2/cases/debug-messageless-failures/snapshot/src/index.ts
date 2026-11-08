import { detectRepeated, type Failure } from './patterns';
import { inWindow } from './window';

export function detectIncidents(
  rows: (Failure & { atMs: number })[],
  nowMs = Date.now(),
) {
  return detectRepeated(rows.filter((r) => inWindow(r.atMs, nowMs)));
}
