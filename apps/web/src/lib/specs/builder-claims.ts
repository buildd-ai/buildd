/**
 * What a mission's builders said they did, for its final verification to
 * check (Living Specs c5a2c67b R-2: verify independently, using the evidence
 * that already exists). Pure: builder-claims-store.ts loads it.
 *
 * Every line here is a claim, not a fact. The record's own contradictions
 * (task-evidence.ts detectMismatches: a push with no diff, a last command
 * that failed) and a PR closed without merging are shown beside the claims
 * they undercut, so the verifier starts from what is already known to be
 * doubtful.
 */
import type { TaskMismatch } from '@buildd/shared';

export interface BuilderClaim {
  taskId: string;
  title: string;
  status: string;
  /** Set when the task was replaced: the task that did its work instead. */
  supersededBy?: string | null;
  summary?: string | null;
  /** 'fallback': the runner captured the agent's last words, not a summary it wrote. */
  summarySource?: 'agent' | 'fallback' | null;
  delivered?: string | null;
  decisions?: string[];
  leftUndone?: string[];
  assumptions?: string[];
  mismatches: TaskMismatch[];
  pr?: { number: number; merged: boolean; closedUnmerged: boolean } | null;
  reports: Array<{ id: string; type: string; title: string | null }>;
}

const MAX_SUMMARY = 700;
const MAX_LIST = 5;
const MAX_CHARS = 24_000;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

function renderOne(c: BuilderClaim): string[] {
  const head = `### ${c.title} (task ${c.taskId}, ${c.status}${c.supersededBy ? `, superseded by ${c.supersededBy}` : ''})`;
  const lines = [head];
  if (c.summary) lines.push(`- Summary${c.summarySource === 'fallback' ? ' (not written by the builder: its last message)' : ''}: ${clip(oneLine(c.summary), MAX_SUMMARY)}`);
  else lines.push('- Summary: none recorded.');
  if (c.delivered) lines.push(`- Delivered: ${clip(oneLine(c.delivered), 300)}`);
  for (const [label, list] of [['Decision', c.decisions], ['Assumption', c.assumptions], ['Left undone', c.leftUndone]] as const) {
    for (const item of (list ?? []).slice(0, MAX_LIST)) lines.push(`- ${label}: ${clip(oneLine(item), 240)}`);
  }
  if (c.pr) lines.push(`- PR #${c.pr.number}: ${c.pr.merged ? 'merged' : c.pr.closedUnmerged ? 'closed without merging (deliverable rejected)' : 'not merged'}`);
  for (const m of c.mismatches) lines.push(`- Record contradicts the claim [${m.kind}]: ${clip(oneLine(m.detail), 240)}`);
  for (const r of c.reports.slice(0, MAX_LIST)) lines.push(`- Artifact ${r.id} (${r.type})${r.title ? `: ${clip(oneLine(r.title), 120)}` : ''}`);
  return lines;
}

/** The prompt section; empty when the mission has no build task to report on. */
export function renderBuilderClaims(claims: readonly BuilderClaim[]): string[] {
  if (!claims.length) return [];
  const flagged = claims.filter((c) => c.mismatches.length || c.pr?.closedUnmerged).length;
  const out = [
    `## What the builders said (${claims.length} task${claims.length === 1 ? '' : 's'}${flagged ? `, ${flagged} with the record contradicting it` : ''})`,
    ``,
    `Each line below is a builder's claim, not a fact. Check it against the code at the target.`,
    ``,
  ];
  let size = out.join('\n').length;
  let shown = 0;
  // Flagged tasks first: they are where a claim is already known to be doubtful.
  const ordered = [...claims].sort((a, b) => Number(!!(b.mismatches.length || b.pr?.closedUnmerged)) - Number(!!(a.mismatches.length || a.pr?.closedUnmerged)));
  for (const c of ordered) {
    const block = [...renderOne(c), ''];
    const len = block.join('\n').length;
    if (size + len > MAX_CHARS) break;
    out.push(...block);
    size += len;
    shown++;
  }
  if (shown < claims.length) out.push(`(${claims.length - shown} more task(s) not shown; read them with \`get_task\`.)`, '');
  out.push(
    `Judge the work as a whole: do these tasks together deliver the spec, or does something in scope fall between them? ` +
    `In your report, list the claims you confirmed, the ones the code contradicts and the ones you could not check, each with the evidence. ` +
    `A contradicted claim is handled like a failed criterion: record the criterion it bears on as fail and file one \`[spec repair]\` task for it, as below. ` +
    `For a large spec you may split the reading across local subagents in this session; do not file tasks to do the checking.`,
  );
  return out;
}
