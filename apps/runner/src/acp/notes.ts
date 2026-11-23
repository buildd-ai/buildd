/**
 * Which thread notes (buildd task events, lib/task-thread-target.ts) a client thread
 * has already been shown, kept in `<BUILDD_HOME>/acp-notes.json`: keys only
 * (`<taskId>:<event>`), no content. Bounded, like acp-sessions.json.
 */
import { existsSync, readFileSync } from 'fs';
import { writeSecretJsonFile } from '../secure-file';
import type { ShownNotes } from './bridge';

export const ACP_NOTES_FILE = 'acp-notes.json';

export function fileShownNotes(path: string, opts: { max?: number } = {}): ShownNotes {
  const max = opts.max ?? 2_000;
  let shown: Array<[string, string]> = [];
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf-8'));
      if (Array.isArray(parsed?.shown)) {
        shown = parsed.shown.filter((l: unknown): l is [string, string] =>
          Array.isArray(l) && l.length === 2 && typeof l[0] === 'string' && typeof l[1] === 'string');
      }
    }
  } catch { shown = []; }
  return {
    has: (threadId, key) => shown.some(([t, k]) => t === threadId && k === key),
    add(threadId, key) {
      if (shown.some(([t, k]) => t === threadId && k === key)) return;
      shown = [...shown, [threadId, key] as [string, string]].slice(-max);
      try { writeSecretJsonFile(path, { shown }); } catch (err) {
        console.error(`[buildd acp] could not save thread notes to ${path}: ${(err as Error).message}`);
      }
    },
  };
}
