/**
 * A bare origin with more history than any depth the cloud clone or an
 * on-demand branch fetch uses, so a shallow clone of it really is shallow.
 * Real git, one fast-import stream.
 *
 *   main       DEEP_ORIGIN_COMMITS commits (the remote HEAD)
 *   dev        main~5 plus 2 commits of its own (a default branch that is not `main`)
 *   mission/x  main~3 plus 3 commits of its own (an integration branch)
 *   buildd/old main~20 plus 1 commit (a resume branch cut long ago)
 */
import { execFileSync } from 'child_process';
import { join } from 'path';

export const DEEP_ORIGIN_COMMITS = 80;

export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

export function makeDeepOrigin(dir: string): { origin: string; url: string } {
  const origin = join(dir, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  let stream = '';
  let mark = 0;
  let t = 1_700_000_000;
  const commit = (ref: string, from: number | null, file: string, body: string): number => {
    mark++;
    stream += `commit ${ref}\nmark :${mark}\ncommitter t <t@example.com> ${t++} +0000\ndata ${body.length}\n${body}\n`;
    if (from !== null) stream += `from :${from}\n`;
    stream += `M 100644 inline ${file}\ndata ${body.length + 1}\n${body}\n\n`;
    return mark;
  };
  const main: number[] = [];
  for (let i = 0; i < DEEP_ORIGIN_COMMITS; i++) main.push(commit('refs/heads/main', main.at(-1) ?? null, 'f.txt', `c${i}`));
  const at = (back: number) => main[main.length - 1 - back]!;
  let tip = at(5);
  for (let i = 0; i < 2; i++) tip = commit('refs/heads/dev', tip, 'dev.txt', `dev${i}`);
  tip = at(3);
  for (let i = 0; i < 3; i++) tip = commit('refs/heads/mission/x', tip, 'mission.txt', `m${i}`);
  commit('refs/heads/buildd/old', at(20), 'old.txt', 'old');
  execFileSync('git', ['fast-import', '--quiet'], { cwd: origin, input: stream });
  // GitHub serves any reachable commit by id; a local bare repo needs telling.
  git(origin, 'config', 'uploadpack.allowReachableSHA1InWant', 'true');
  return { origin, url: `file://${origin}` };
}

/** `refs/remotes/origin/*` names in `repo`, without origin/HEAD. */
export function remoteBranches(repo: string): string[] {
  return git(repo, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin')
    .split('\n').filter(Boolean).filter(r => r !== 'refs/remotes/origin/HEAD')
    .map(r => r.slice('refs/remotes/origin/'.length)).sort();
}
