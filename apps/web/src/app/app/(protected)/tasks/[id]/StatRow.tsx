import { derivePrLifecycle } from '@/lib/pr-presentation';

export function formatTokens(n: number): string | null {
  if (!n || n <= 0) return null;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function Tile({ testId, value, unit, label }: { testId?: string; value: React.ReactNode; unit?: string; label: string }) {
  return (
    <div data-testid={testId} className="px-3 py-2.5 md:px-4 md:py-3 border-r border-b md:border-b-0 border-border-default last:border-r-0 min-w-0">
      <div className="font-mono text-[20px] md:text-[24px] font-semibold tracking-[-0.5px] leading-tight tabular-nums truncate">
        {value}
        {unit && <small className="ml-1 text-[12px] font-normal tracking-normal text-text-muted">{unit}</small>}
      </div>
      <div className="mt-1 font-mono text-[11px] md:text-[10px] uppercase tracking-[1.8px] text-text-muted truncate">{label}</div>
    </div>
  );
}

/**
 * The numbers under the Now strip. No cost tile: on seat/OAuth auth the cost is
 * virtual, so the fourth tile is the PR (and its CI state) once one exists, or
 * how many files the agent has touched before that.
 */
export default function StatRow({
  elapsed,
  turns,
  tokens,
  pr,
  filesTouched,
  added,
  removed,
}: {
  elapsed: string | null;
  turns: number;
  tokens: number;
  pr: { url: string; number: number | null; lifecycle: string | null } | null;
  filesTouched: number;
  added: number | null;
  removed: number | null;
}) {
  const tok = formatTokens(tokens);
  const lifecycle = pr ? derivePrLifecycle(pr.lifecycle, true) : null;
  const hasDiff = (added ?? 0) > 0 || (removed ?? 0) > 0;
  return (
    <div data-testid="worker-stats" className="grid grid-cols-2 md:grid-cols-5 border-2 border-border-strong bg-card mt-4 md:mt-5">
      <Tile value={<span suppressHydrationWarning>{elapsed ?? '—'}</span>} label="Elapsed" />
      <Tile value={turns} label="Turns" />
      <Tile value={tok ? tok.replace(/[kM]$/, '') : '—'} unit={tok?.match(/[kM]$/)?.[0]} label="Tokens" />
      {pr ? (
        <Tile
          testId="worker-stat-pr"
          value={
            <a href={pr.url} target="_blank" rel="noopener noreferrer" data-testid="worker-pr-link" className="text-accent-text hover:underline">
              #{pr.number ?? 'PR'}
            </a>
          }
          label={lifecycle?.label ?? 'PR open'}
        />
      ) : (
        <Tile testId="worker-stat-files" value={filesTouched} label={filesTouched === 1 ? 'File touched' : 'Files touched'} />
      )}
      <Tile
        testId="worker-stat-diff"
        value={hasDiff ? (
          <>
            <span className="text-status-success">+{added ?? 0}</span>
            {(removed ?? 0) > 0 && <> <span className="text-status-error">&minus;{removed}</span></>}
          </>
        ) : '—'}
        label="Lines so far"
      />
    </div>
  );
}
