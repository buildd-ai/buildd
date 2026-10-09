/**
 * The workspace overview's one-sentence summary of its queue:
 * "3 pending, 1 running, 2 failed." Only nonzero parts; finished work
 * (completed, cancelled) is history, not queue.
 */
export function taskCountLede(counts: Record<string, number>): string {
  const n = (k: string) => counts[k] || 0;
  const parts = [
    [n('pending'), 'pending'],
    [n('assigned') + n('in_progress'), 'running'],
    [n('failed'), 'failed'],
  ] as const;
  const said = parts.filter(([c]) => c > 0).map(([c, w]) => `${c} ${w}`);
  return said.length ? `${said.join(', ')}.` : 'Nothing queued.';
}
