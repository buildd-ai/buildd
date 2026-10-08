import { describe, expect, it } from 'bun:test';
import { nonDiffActions } from './attempt-actions';

const ran = (cmd: string) => ({ type: 'action' as const, label: `Ran: ${cmd}`, cmd, ts: 1, tool: 'Bash' as const });

describe('nonDiffActions', () => {
  it('a body edit shows as an edit, not as nothing', () => {
    expect(nonDiffActions([ran('gh pr edit 12 --body-file /tmp/body.md')])).toEqual(['Edited PR body']);
  });
  it('re-runs and comments are named; reads are not', () => {
    expect(nonDiffActions([
      ran('gh run rerun 123 --failed'),
      ran('gh pr comment 12 --body "done"'),
      ran('gh pr view 12'),
      { type: 'phase' as const, label: 'gh pr edit in a phase label', toolCount: 1, ts: 2 },
    ])).toEqual(['Re-ran checks', 'Posted a comment']);
  });
  it('nothing recorded → nothing claimed', () => {
    expect(nonDiffActions(null)).toEqual([]);
    expect(nonDiffActions([ran('bun test')])).toEqual([]);
  });
});
