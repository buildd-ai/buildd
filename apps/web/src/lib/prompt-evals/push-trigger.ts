/**
 * Which pushes start a prompt eval: a push to the configured prompts repo
 * (`PROMPTS_REPO`) on the branch the deploy seed reads (`PROMPTS_REPO_REF`,
 * default `main`), that left a commit behind. The eval scores the pushed sha,
 * so a regression shows up before the next deploy seeds it.
 */
import { promptsRepoConfig } from '../prompts-repo';

export interface PushLike {
  ref?: string;
  after?: string;
  deleted?: boolean;
  repository?: { full_name?: string };
}

const SHA_RE = /^[0-9a-f]{40}$/;

/** The sha to score, or null when this push does not start an eval. */
export function promptEvalRefForPush(event: PushLike, env: Record<string, string | undefined> = process.env): string | null {
  const cfg = promptsRepoConfig(env);
  if (!cfg) return null;
  if (event.repository?.full_name?.toLowerCase() !== cfg.repo.toLowerCase()) return null;
  if (event.ref !== `refs/heads/${cfg.ref}`) return null;
  if (event.deleted || !event.after || !SHA_RE.test(event.after)) return null;
  return event.after;
}
