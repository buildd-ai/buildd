/**
 * Text rendering of `tasks.result.evidence` / `result.mismatch` for the MCP
 * tools. The record is already redacted and bounded when written; this only
 * lays it out, so `get_task` and `get_error_traces` read the same way.
 */
import type { TaskEvidence, TaskMismatch } from '@buildd/shared';

const MISMATCH_LABEL: Record<string, string> = {
  pushed_without_diff: 'Summary claims work was pushed, but no diff was recorded',
  success_with_red_check: 'Reported success while a check was failing',
  last_command_failed: 'Reported success, but the last test/typecheck command failed',
};

export function formatTaskMismatch(mismatch: readonly TaskMismatch[] | null | undefined): string[] {
  if (!Array.isArray(mismatch) || mismatch.length === 0) return [];
  return [
    '## ⚠️ Mismatch',
    ...mismatch.map(m => `- **${MISMATCH_LABEL[m.kind] ?? m.kind}** — ${m.detail}`),
  ];
}

/** `keyLimit` bounds the key lines shown; the full (already capped) list stays in the record. */
export function formatTaskEvidence(
  evidence: TaskEvidence | null | undefined,
  keyLimit = 15,
): string[] {
  if (!evidence || typeof evidence !== 'object') return [];
  const out: string[] = ['## Evidence', `**Error class:** ${evidence.errorClass}`];
  const cmd = evidence.lastFailingCommand;
  if (cmd) out.push(`**Last failing command:** \`${cmd.command}\` (exit ${cmd.exitCode ?? '?'})`);
  const d = evidence.diff;
  if (d) out.push(`**Diff:** ${d.files} files / +${d.added} / -${d.removed}`);
  if (Array.isArray(evidence.ciChecks) && evidence.ciChecks.length > 0) {
    out.push('**CI checks:**');
    for (const c of evidence.ciChecks) out.push(`- ${c.state === 'failed' ? '✗' : c.state === 'pending' ? '…' : '✓'} ${c.name}${c.url ? ` — ${c.url}` : ''}`);
  }
  const keys = Array.isArray(evidence.keyLines) ? evidence.keyLines : [];
  if (keys.length > 0) {
    const source = evidence.keyLinesSource === 'ci_digest' ? ' (from the CI failure digest)' : '';
    out.push(`**Key lines${source}:**`, '```', ...keys.slice(0, keyLimit), ...(keys.length > keyLimit ? [`… ${keys.length - keyLimit} more`] : []), '```');
  }
  const links = evidence.links ?? {};
  const linkBits = [
    links.prUrl ? `PR ${links.prUrl}` : null,
    links.ciRunUrl ? `CI ${links.ciRunUrl}` : null,
    links.fullLogUrl ? `full log ${links.fullLogUrl}` : null,
  ].filter(Boolean);
  if (linkBits.length > 0) out.push(`**Links:** ${linkBits.join(' · ')}`);
  return out;
}

export interface EvidenceObjectLine {
  id: string;
  kind: string;
  bytes: number;
  uploadState: string;
}

const humanBytes = (n: number): string =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : n >= 1024 ? `${Math.round(n / 1024)} KiB` : `${n} B`;

/**
 * The stored run-evidence objects behind a task or PR: pointers only. A
 * failure's key lines are in the record above; the text of an object is read
 * through `read_evidence`.
 */
export function formatEvidenceObjects(objects: readonly EvidenceObjectLine[] | null | undefined): string[] {
  if (!Array.isArray(objects) || objects.length === 0) return [];
  return [
    `## Run evidence objects (${objects.length})`,
    ...objects.map(o => `- ${o.kind} · ${humanBytes(o.bytes)}${o.uploadState === 'stored' ? '' : ` · ${o.uploadState}`} (id: ${o.id})`),
    'Read one: action=read_evidence { evidenceId, tail?, grep? }.',
  ];
}
