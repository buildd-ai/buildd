import Link from 'next/link';

/**
 * Shape of `tasks.context.specSource`: a repo spec document, written by
 * `approvePlan` (apps/web/src/lib/approve-plan.ts) onto every child of an
 * emitsPlan-originated plan (docs/design/spec-to-build-pattern.md §3), and/or a
 * Living Spec pin the server writes when the task is filed (lib/specs/pin.ts).
 * Duplicated here rather than imported so this presentational component
 * stays free of approve-plan.ts's server/DB-only dependency graph.
 */
export interface SpecSourceContext {
  specPath?: string;
  planningTaskId?: string;
  specId?: string;
  revision?: number;
  contentHash?: string;
}

export interface SpecSourceBlockProps {
  specSource: SpecSourceContext | null | undefined;
}

/**
 * Read-only traceability block: which spec authorized this task (the Living
 * Spec revision it is pinned to, and/or the repo document), and the planning
 * task whose approved plan materialized it. Renders nothing when
 * `context.specSource` is absent (ordinary, non-spec-originated tasks).
 */
export function SpecSourceBlock({ specSource }: SpecSourceBlockProps) {
  const repoDoc = specSource?.specPath && specSource?.planningTaskId ? specSource.specPath : null;
  const pinned = specSource?.specId && typeof specSource.revision === 'number' ? specSource : null;
  if (!repoDoc && !pinned) return null;

  return (
    <div className="mb-6" data-testid="task-spec-source">
      <div className="font-mono text-[11px] md:text-[10px] uppercase tracking-[2.5px] text-text-muted pb-2 border-b border-border-default mb-4">
        Spec
      </div>
      <div className="card p-4 space-y-1">
        {pinned && (
          <div className="text-[13px] text-text-primary" data-testid="task-spec-source-pin">
            Pinned to revision {pinned.revision}
            {pinned.contentHash && (
              <span className="font-mono text-[11px] text-text-muted"> · {pinned.contentHash.slice(0, 12)}</span>
            )}
          </div>
        )}
        {repoDoc && (
          <div className="text-[13px] font-medium text-text-primary break-all" data-testid="task-spec-source-path">
            {repoDoc}
          </div>
        )}
        {specSource?.planningTaskId && (
          <Link
            href={`/app/tasks/${specSource.planningTaskId}`}
            className="text-[13px] text-primary hover:underline"
            data-testid="task-spec-source-link"
          >
            Planning task
          </Link>
        )}
      </div>
    </div>
  );
}

export default SpecSourceBlock;
