import { PR_PILL, type PrDisplayState } from '@/lib/pr-presentation';

export function formatTokens(n: number): string | null {
  if (!n || n <= 0) return null;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Literal class names so Tailwind keeps them. */
// Container widths, not the viewport's: the row also sits in the mission
// sheet's narrow panel on a desktop screen, where five tiles do not fit.
const WIDE_COLS: Record<number, string> = { 1: '@xl:grid-cols-1', 2: '@xl:grid-cols-2', 3: '@xl:grid-cols-3', 4: '@xl:grid-cols-4', 5: '@xl:grid-cols-5' };

/**
 * One figure and its label. With `link`, the whole tile is the link: its
 * negative margins cancel the tile's padding, so the tap target is the tile
 * (never under 44px) and nothing moves on screen.
 */
function Tile({ testId, value, unit, label, link }: { testId?: string; value: React.ReactNode; unit?: string; label: string; link?: { href: string; testId: string } }) {
  const body = (
    <>
      <div className="font-mono text-[20px] @xl:text-[24px] font-semibold tracking-[-0.5px] leading-tight tabular-nums truncate">
        {value}
        {unit && <small className="ml-1 text-[12px] font-normal text-text-muted">{unit}</small>}
      </div>
      <div className="mt-1 font-mono text-meta text-text-muted truncate">{label}</div>
    </>
  );
  return (
    <div data-testid={testId} className="px-3 py-2.5 @xl:px-4 @xl:py-3 border-r border-b @xl:border-b-0 border-border-default last:border-r-0 min-w-0">
      {link ? (
        <a href={link.href} target="_blank" rel="noopener noreferrer" data-testid={link.testId} className="group block -mx-3 -my-2.5 px-3 py-2.5 @xl:-mx-4 @xl:-my-3 @xl:px-4 @xl:py-3">
          {body}
        </a>
      ) : body}
    </div>
  );
}

/**
 * The numbers under the Now strip. No cost tile: on seat/OAuth auth the cost is
 * virtual, so the fourth tile is the PR (and its CI state) once one exists, or
 * how many files the agent has touched before that. A figure the run has not
 * measured yet (no start time, no turns, no tokens, no files, no diff) has no
 * tile, and with none measured there is no strip: an unmeasured 0 reads as a
 * measurement.
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
  /** Null or 0 hides the tile: a figure the run did not report is not a 0. */
  tokens: number | null;
  /** `state` is `resolvePrDisplayState`'s: the delivery's for a kernel-owned PR, else the columns'. */
  pr: { url: string; number: number | null; state: PrDisplayState } | null;
  filesTouched: number;
  added: number | null;
  removed: number | null;
}) {
  const tok = tokens == null ? null : formatTokens(tokens);
  const lifecycle = pr ? PR_PILL[pr.state] : null;
  const hasDiff = (added ?? 0) > 0 || (removed ?? 0) > 0;
  const tiles = [
    elapsed != null && <Tile key="elapsed" value={<span suppressHydrationWarning>{elapsed}</span>} label="Elapsed" />,
    turns > 0 && <Tile key="turns" value={turns} label="Turns" />,
    tok && <Tile key="tokens" testId="worker-stat-tokens" value={tok.replace(/[kM]$/, '')} unit={tok.match(/[kM]$/)?.[0]} label="Tokens" />,
    pr ? (
      <Tile
        key="pr"
        testId="worker-stat-pr"
        link={{ href: pr.url, testId: 'worker-pr-link' }}
        value={<span className="text-accent-text group-hover:underline">#{pr.number ?? 'PR'}</span>}
        label={lifecycle?.label ?? 'PR open'}
      />
    ) : filesTouched > 0 && (
      <Tile key="files" testId="worker-stat-files" value={filesTouched} label={filesTouched === 1 ? 'File touched' : 'Files touched'} />
    ),
    hasDiff && (
      <Tile
        key="diff"
        testId="worker-stat-diff"
        value={
          <>
            <span className="text-status-success">+{added ?? 0}</span>
            {(removed ?? 0) > 0 && <> <span className="text-status-error">&minus;{removed}</span></>}
          </>
        }
        label="Lines so far"
      />
    ),
  ].filter(Boolean);
  if (tiles.length === 0) return null;
  return (
    <div className="@container mt-4 md:mt-5">
      <div data-testid="worker-stats" className={`grid grid-cols-2 ${WIDE_COLS[tiles.length] ?? '@xl:grid-cols-5'} border-2 border-border-strong bg-card`}>
        {tiles}
      </div>
    </div>
  );
}
