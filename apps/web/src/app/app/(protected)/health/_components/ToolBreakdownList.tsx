import type { ToolBreakdownRow } from '@/lib/tool-usage-breakdown';
import { formatShare } from '@/lib/usage-breakdowns';

/**
 * The tool list where each row opens in place: Bash into what the commands
 * were for, buildd into its actions, Read/Edit/Write into repo areas. A row
 * with nothing to break down is a plain row.
 */
export default function ToolBreakdownList({ rows, maxCalls, openAll = false }: { rows: ToolBreakdownRow[]; maxCalls: number; /** Render every breakdown open (fixtures). */ openAll?: boolean }) {
  return (
    <ul data-testid="tool-breakdown-list" className="space-y-2">
      {rows.map(row => (
        <li key={row.name} data-testid="tool-breakdown-row">
          {row.children.length > 0 ? (
            <details className="group/tool" open={openAll || undefined}>
              <summary className="list-none cursor-pointer select-none">
                <ToolLine row={row} maxCalls={maxCalls} expandable />
              </summary>
              <BreakdownChildren row={row} />
            </details>
          ) : (
            <ToolLine row={row} maxCalls={maxCalls} expandable={false} />
          )}
        </li>
      ))}
    </ul>
  );
}

function ToolLine({ row, maxCalls, expandable }: { row: ToolBreakdownRow; maxCalls: number; expandable: boolean }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className={`w-3 shrink-0 text-meta text-text-muted ${expandable ? '' : 'invisible'}`}>
          <span className="group-open/tool:hidden">+</span>
          <span className="hidden group-open/tool:inline">−</span>
        </span>
        <span className="text-body text-text-primary flex-1 min-w-0 truncate" title={row.name}>{row.label}</span>
        <span className="text-meta text-text-muted tabular-nums shrink-0">
          {row.calls.toLocaleString('en-US')} · {formatShare(row.share)}
        </span>
      </div>
      <div className="ml-5 h-1.5 bg-surface-3 overflow-hidden">
        <div className="h-full bg-primary" style={{ width: `${maxCalls > 0 ? (row.calls / maxCalls) * 100 : 0}%` }} />
      </div>
    </div>
  );
}

function BreakdownChildren({ row }: { row: ToolBreakdownRow }) {
  return (
    <div data-testid="tool-breakdown-children" className="ml-5 mt-2 mb-1 space-y-1 border-l border-border-default pl-3">
      {row.children.map(child => (
        <div key={child.key} data-testid="tool-breakdown-child" className="flex items-center gap-2 min-w-0" title={child.hint}>
          <span className="text-meta text-text-secondary flex-1 min-w-0 truncate">{child.label}</span>
          {child.dedicatedTool && (
            <span className="text-meta text-status-warning shrink-0">{child.dedicatedTool} does this</span>
          )}
          <span className="text-meta text-text-muted tabular-nums shrink-0">
            {child.calls.toLocaleString('en-US')} · {formatShare(child.share)}
          </span>
        </div>
      ))}
      {row.childCoverage && (
        <p className="text-meta text-text-muted">
          Broken down: {row.childCoverage.covered.toLocaleString('en-US')} of {row.childCoverage.of.toLocaleString('en-US')} calls.
        </p>
      )}
    </div>
  );
}
