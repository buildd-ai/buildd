/**
 * The name a run goes by on Health › Runners and Home's Agents rows: the
 * task's short label when it is words ("home and nav"), else its title in
 * words. Invariant and friction tasks carry machine identifiers as labels
 * ("open_pr_outp", cut from `open_pr_outpaced_by_base`), which read as
 * nothing; those fall back to the title with the identifiers spelled out.
 * Display only.
 */
import { displayTaskTitle } from './task-title';

const REFRESH = /^chore\(mission\): merge (\S+) into the (.+) integration branch$/;
const BRACKETS = /^(?:\[[^\]]*\]\s*)+/;

/** `open_pr_outpaced_by_base` → `open PR outpaced by base`; `pull_request 4191` → `PR #4191`. */
function spellOut(text: string): string {
  return text
    .replace(/\bpull_request[ _#]?(\d+)/gi, 'PR #$1')
    .replace(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/gi, w => w.split('_').map(p => (p.toLowerCase() === 'pr' ? 'PR' : p)).join(' '));
}

/** A machine identifier, a bare PR number, or a stub too short to name anything. */
const isIdentifier = (s: string) => /_/.test(s) || !/[a-z]{2,}/i.test(s) || (/^[a-z0-9-]+$/i.test(s) && s.length <= 3)
  // or a copy of a raw title ("PR #12: [friction] …"), which the title path reads better
  || /^PR #\d+:/i.test(s) || /\[[^\]]*\]/.test(s);

export function readableRunName(task: { label: string | null | undefined; title: string | null | undefined }): string {
  const title = (task.title ?? '').trim();
  const refresh = REFRESH.exec(title);
  if (refresh) return `Bring ${refresh[2]} up to date with ${refresh[1]}`;
  const label = (task.label ?? '').trim();
  if (label && !isIdentifier(label) && label !== 'untitled') return label;
  // A reviewer or fix task is titled "[reviewer] PR #N: <the PR's title>":
  // name it by what the PR does, marked as a review when it is one.
  const review = /^\s*\[reviewer\]/i.test(title);
  const bare = title.replace(BRACKETS, '').replace(/^PR #\d+:\s*/i, '').replace(BRACKETS, '').trim();
  const shown = spellOut(displayTaskTitle(bare).replace(BRACKETS, '').trim());
  const named = shown ? shown.charAt(0).toUpperCase() + shown.slice(1) : '';
  if (!named) return label || 'Untitled task';
  return review ? `Review: ${named}` : named;
}
