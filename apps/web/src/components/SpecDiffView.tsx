import type { DiffHunk, DiffRow } from '@/lib/specs/diff';

const OP = { ' ': 'ctx', '-': 'del', '+': 'add', gap: 'gap' } as const;
const ROW_TONE = { ctx: '', del: 'bg-[var(--bad-tint)]', add: 'bg-[var(--ok-tint)]', gap: 'bg-surface-3' } as const;
const KIND_WORD = { added: 'added', removed: 'removed', changed: 'changed' } as const;

function LineNo({ n }: { n: number | null }) {
  return (
    <span data-line className="w-10 shrink-0 select-none px-1 text-right text-text-muted">
      {n ?? ''}
    </span>
  );
}

function Row({ row }: { row: DiffRow }) {
  const op = OP[row.op];
  if (op === 'gap') {
    return (
      <div data-testid="spec-diff-row" data-op="gap" className={`flex ${ROW_TONE.gap} text-text-muted`}>
        <span className="w-20 shrink-0 select-none px-1 text-center" aria-hidden>⋯</span>
        <span className="px-2">Unchanged lines</span>
      </div>
    );
  }
  return (
    <div data-testid="spec-diff-row" data-op={op} className={`flex ${ROW_TONE[op]}`}>
      <LineNo n={row.oldLine} />
      <LineNo n={row.newLine} />
      <span className={`w-4 shrink-0 select-none text-center ${op === 'add' ? 'text-status-success' : op === 'del' ? 'text-status-error' : 'text-text-muted'}`} aria-hidden>
        {row.op === ' ' ? '' : row.op}
      </span>
      <span data-testid="spec-diff-text" className="min-w-0 flex-1 whitespace-pre-wrap pr-2 text-text-primary [overflow-wrap:anywhere]">
        {row.text}
      </span>
    </div>
  );
}

/**
 * A spec revision's changes, read like a code review: one framed block per
 * changed section with its heading path and line counts, then numbered rows
 * (old, new) tinted for added and removed lines. Long lines wrap; nothing
 * scrolls sideways. Rows come from lib/specs/diff.ts, already capped.
 */
export default function SpecDiffView({ hunks, omittedLines }: { hunks: DiffHunk[]; omittedLines: number }) {
  return (
    <div className="flex flex-col gap-3" data-testid="spec-approval-diff">
      {hunks.length === 0 ? <p className="text-body text-text-secondary">No changes.</p> : null}
      {hunks.map((h, i) => (
        <section key={`${i}:${h.path}`} data-testid="spec-diff-hunk" className="card overflow-hidden">
          <header data-testid="spec-diff-hunk-header" className="flex items-baseline gap-2 border-b border-[var(--line-soft)] bg-surface-3 px-3 py-2">
            <span className="min-w-0 text-body font-semibold text-text-primary [overflow-wrap:anywhere]">{h.path}</span>
            <span className="font-mono text-meta text-text-muted">{KIND_WORD[h.kind]}</span>
            <span className="ml-auto shrink-0 font-mono text-meta">
              <span className="text-status-success">+{h.linesAdded}</span>{' '}
              <span className="text-status-error">−{h.linesRemoved}</span>
            </span>
          </header>
          <div className="font-mono text-meta">
            {h.rows.map((r, j) => <Row key={j} row={r} />)}
          </div>
        </section>
      ))}
      {omittedLines > 0 ? <p className="text-meta text-text-muted">{omittedLines} more lines</p> : null}
    </div>
  );
}
