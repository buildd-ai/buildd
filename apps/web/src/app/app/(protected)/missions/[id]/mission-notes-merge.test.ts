import { describe, expect, test } from 'bun:test';
import { mergeNotesSince, notesUrl } from './mission-notes-merge';

const n = (id: string, at: string, extra: Record<string, unknown> = {}) => ({ id, createdAt: at, type: 'update', status: 'open', title: id, ...extra }) as any;

describe('mergeNotesSince', () => {
  test('new notes join the list, newest first', () => {
    const out = mergeNotesSince([n('b', '2026-10-18T10:01:00Z'), n('a', '2026-10-18T10:00:00Z')], [n('c', '2026-10-18T10:02:00Z')]);
    expect(out.map(x => x.id)).toEqual(['c', 'b', 'a']);
  });

  test('a note that came back (collapsed into, so re-dated) replaces its old copy', () => {
    const out = mergeNotesSince([n('b', '2026-10-18T10:01:00Z', { title: 'old' }), n('a', '2026-10-18T10:00:00Z')], [n('a', '2026-10-18T10:05:00Z', { title: 'merged' })]);
    expect(out.map(x => x.id)).toEqual(['a', 'b']);
    expect(out[0].title).toBe('merged');
  });

  test('a reply marks the open question it answers as answered', () => {
    const q = n('q', '2026-10-18T10:00:00Z', { type: 'question' });
    const out = mergeNotesSince([q], [n('r', '2026-10-18T10:03:00Z', { type: 'reply', replyTo: 'q' })]);
    expect(out.find(x => x.id === 'q')!.status).toBe('answered');
  });
});

describe('notesUrl', () => {
  test('first read is the newest page; later reads ask only since the newest note held', () => {
    expect(notesUrl('m-1', [])).toBe('/api/missions/m-1/notes?limit=50');
    expect(notesUrl('m-1', [n('b', '2026-10-18T10:01:00Z')])).toBe('/api/missions/m-1/notes?limit=50&since=b');
  });
});
