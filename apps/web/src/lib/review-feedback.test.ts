import { describe, it, expect } from 'bun:test';
import { reviewRowFromEvent, commentRowFromEvent, withOwner } from './review-feedback';

describe('reviewRowFromEvent', () => {
  const base = {
    id: 12345,
    state: 'changes_requested',
    body: "don't use db.transaction() with the neon-http driver",
    commit_id: 'abc123def',
    submitted_at: '2026-09-06T10:00:00Z',
    user: { login: 'a-reviewer', type: 'User' },
  };

  it('maps a changes-requested review', () => {
    const row = reviewRowFromEvent(base)!;
    expect(row.githubId).toBe('12345');
    expect(row.kind).toBe('review');
    expect(row.state).toBe('changes_requested');
    expect(row.body).toContain('neon-http');
    expect(row.headSha).toBe('abc123def');
    expect(row.authorType).toBe('user');
    expect(row.submittedAt?.toISOString()).toBe('2026-09-06T10:00:00.000Z');
  });

  it('keeps a bodied approval and a bodied bare comment', () => {
    // A reviewer can approve while explaining a caveat, or leave reasoning that
    // never became a formal request for changes. Both are engineering content.
    expect(reviewRowFromEvent({ ...base, state: 'approved' })!.state).toBe('approved');
    expect(reviewRowFromEvent({ ...base, state: 'commented' })!.state).toBe('commented');
  });

  it('drops a review with no body, whatever the verdict', () => {
    // The verdict is already on the mission timeline; an empty row here would
    // be a join with no payload.
    for (const state of ['approved', 'changes_requested', 'commented']) {
      expect(reviewRowFromEvent({ ...base, state, body: '' })).toBeNull();
      expect(reviewRowFromEvent({ ...base, state, body: '   \n  ' })).toBeNull();
      expect(reviewRowFromEvent({ ...base, state, body: undefined })).toBeNull();
    }
  });

  it('drops an unknown verdict rather than storing it as null state', () => {
    expect(reviewRowFromEvent({ ...base, state: 'dismissed' })).toBeNull();
    expect(reviewRowFromEvent({ ...base, state: undefined })).toBeNull();
  });

  it('refuses a row with no GitHub id, since that is the dedupe key', () => {
    // The webhook both drops and redelivers events, so a row that cannot
    // collide on github_id would be inserted again on every redelivery.
    expect(reviewRowFromEvent({ ...base, id: undefined })).toBeNull();
    expect(reviewRowFromEvent({ ...base, id: null })).toBeNull();
  });

  it('preserves id 0 rather than treating it as missing', () => {
    expect(reviewRowFromEvent({ ...base, id: 0 })?.githubId).toBe('0');
  });

  it('marks bot authors', () => {
    expect(reviewRowFromEvent({ ...base, user: { login: 'agent', type: 'Bot' } })!.authorType).toBe('bot');
  });

  it('tolerates missing optional fields', () => {
    const row = reviewRowFromEvent({ id: 1, state: 'approved', body: 'ok' })!;
    expect(row.headSha).toBeNull();
    expect(row.authorLogin).toBeNull();
    expect(row.submittedAt).toBeNull();
    expect(row.path).toBeNull();
  });

  it('rejects an unparseable timestamp instead of storing Invalid Date', () => {
    expect(reviewRowFromEvent({ ...base, submitted_at: 'not-a-date' })!.submittedAt).toBeNull();
  });
});

describe('commentRowFromEvent', () => {
  const base = {
    id: 999,
    body: 'this drops the error instead of surfacing it',
    path: 'apps/web/src/lib/knowledge-context.ts',
    line: 42,
    original_line: 40,
    commit_id: 'sha-at-comment-time',
    diff_hunk: '@@ -1,3 +1,4 @@\n+const x = 1;',
    created_at: '2026-09-06T11:00:00Z',
    user: { login: 'a-reviewer', type: 'User' },
  };

  it('captures the path, which is what makes it retrievable', () => {
    const row = commentRowFromEvent(base)!;
    expect(row.kind).toBe('inline_comment');
    expect(row.path).toBe('apps/web/src/lib/knowledge-context.ts');
    expect(row.line).toBe(42);
    expect(row.diffHunk).toContain('@@');
    expect(row.state).toBe('commented');
  });

  it('falls back to original_line when the comment has gone stale', () => {
    // GitHub nulls `line` after a force-push. Without the fallback an outdated
    // comment loses its anchor and becomes unlocatable.
    expect(commentRowFromEvent({ ...base, line: null })!.line).toBe(40);
    expect(commentRowFromEvent({ ...base, line: undefined })!.line).toBe(40);
  });

  it('records no line rather than a wrong one when both are absent', () => {
    expect(commentRowFromEvent({ ...base, line: null, original_line: null })!.line).toBeNull();
  });

  it('takes the SHA the comment was left against, not the PR head', () => {
    expect(commentRowFromEvent(base)!.headSha).toBe('sha-at-comment-time');
  });

  it('drops an empty comment and one with no id', () => {
    expect(commentRowFromEvent({ ...base, body: '' })).toBeNull();
    expect(commentRowFromEvent({ ...base, id: undefined })).toBeNull();
  });

  it('keeps a comment with no path, since PR-level feedback is still feedback', () => {
    expect(commentRowFromEvent({ ...base, path: undefined })!.path).toBeNull();
  });
});

describe('withOwner', () => {
  it('attaches task and worker without touching the mapped fields', () => {
    const row = commentRowFromEvent({ id: 1, body: 'x', path: 'a.ts' })!;
    const owned = withOwner(row, { id: 'worker-1', taskId: 'task-1', workspaceId: 'ws-1' });
    expect(owned.workerId).toBe('worker-1');
    expect(owned.taskId).toBe('task-1');
    expect(owned.path).toBe('a.ts');
  });

  it('nulls both when the PR owner could not be resolved', () => {
    // A review can arrive for a PR whose worker row is gone. The feedback is
    // still worth keeping; it just cannot be attributed to a task.
    for (const owner of [null, undefined, {}]) {
      const owned = withOwner(commentRowFromEvent({ id: 1, body: 'x' })!, owner as any);
      expect(owned.workerId).toBeNull();
      expect(owned.taskId).toBeNull();
    }
  });
});
