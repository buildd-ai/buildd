/**
 * SessionLinks (bridge.ts) kept in `<BUILDD_HOME>/acp-sessions.json`: which
 * worker each client-started thread is. Ids only, no content. Bounded: the
 * oldest links go once there are `max`, long after their workers are gone.
 */
import { existsSync, readFileSync } from 'fs';
import { writeSecretJsonFile } from '../secure-file';
import type { SessionLinks } from './bridge';

export const ACP_SESSIONS_FILE = 'acp-sessions.json';

export function fileSessionLinks(path: string, opts: { max?: number } = {}): SessionLinks {
  const max = opts.max ?? 1_000;
  let links: Array<[string, string]> = [];
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf-8'));
      if (Array.isArray(parsed?.links)) {
        links = parsed.links.filter((l: unknown): l is [string, string] =>
          Array.isArray(l) && l.length === 2 && typeof l[0] === 'string' && typeof l[1] === 'string');
      }
    }
  } catch { links = []; }

  return {
    get(sessionId) {
      return links.find(([s]) => s === sessionId)?.[1] ?? null;
    },
    sessionFor(workerId) {
      return links.find(([, w]) => w === workerId)?.[0] ?? null;
    },
    set(sessionId, workerId) {
      links = [...links.filter(([s]) => s !== sessionId), [sessionId, workerId] as [string, string]].slice(-max);
      try {
        writeSecretJsonFile(path, { links });
      } catch (err) {
        console.error(`[buildd acp] could not save thread links to ${path}: ${(err as Error).message}`);
      }
    },
  };
}
