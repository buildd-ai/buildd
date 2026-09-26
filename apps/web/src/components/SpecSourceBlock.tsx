import Link from 'next/link';

/**
 * Shape of `tasks.context.specSource`, written by `approvePlan`
 * (apps/web/src/lib/approve-plan.ts) onto every child materialized from an
 * emitsPlan-originated plan (docs/design/spec-to-build-pattern.md §3).
 * Duplicated here rather than imported so this presentational component
 * stays free of approve-plan.ts's server/DB-only dependency graph.
 */
export interface SpecSourceContext {
  specPath: string;
  planningTaskId: string;
}

export interface SpecSourceBlockProps {
  specSource: SpecSourceContext | null | undefined;
}

/**
 * Read-only traceability block: which spec doc authorized this task, and the
 * planning task whose approved plan materialized it. Renders nothing when
 * `context.specSource` is absent (ordinary, non-spec-originated tasks).
 */
export function SpecSourceBlock({ specSource }: SpecSourceBlockProps) {
  if (!specSource?.specPath || !specSource?.planningTaskId) return null;

  return (
    <div className="mb-6" data-testid="task-spec-source">
      <div className="font-mono text-[11px] md:text-[10px] uppercase tracking-[2.5px] text-text-muted pb-2 border-b border-border-default mb-4">
        Spec
      </div>
      <div className="card p-4 space-y-1">
        <div className="text-[13px] font-medium text-text-primary break-all" data-testid="task-spec-source-path">
          {specSource.specPath}
        </div>
        <Link
          href={`/app/tasks/${specSource.planningTaskId}`}
          className="text-[13px] text-primary hover:underline"
          data-testid="task-spec-source-link"
        >
          Planning task
        </Link>
      </div>
    </div>
  );
}

export default SpecSourceBlock;
