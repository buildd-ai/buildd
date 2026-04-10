import Link from 'next/link';

interface ChainTask {
  id: string;
  title: string;
  status: string;
  roleSlug: string | null;
  worker: {
    prUrl: string | null;
    prNumber: number | null;
    turns: number;
    branch: string;
  } | null;
  artifacts: Array<{ id: string; type: string; title: string | null }>;
}

interface PlanChainViewProps {
  currentTaskId: string;
  tasks: ChainTask[];
  roleMap: Record<string, { name: string; color: string }>;
}

const STATUS_STYLES: Record<string, { dot: string; text: string }> = {
  pending:       { dot: 'bg-status-warning',                       text: 'text-status-warning' },
  assigned:      { dot: 'bg-status-info',                          text: 'text-status-info' },
  running:       { dot: 'bg-status-running animate-status-pulse',  text: 'text-status-running' },
  waiting_input: { dot: 'bg-status-running',                       text: 'text-status-running' },
  completed:     { dot: 'bg-status-success',                       text: 'text-status-success' },
  failed:        { dot: 'bg-status-error',                         text: 'text-status-error' },
  cancelled:     { dot: 'bg-text-muted',                           text: 'text-text-muted' },
};

function ChevronRight() {
  return (
    <svg className="w-3.5 h-3.5 shrink-0 text-border-strong" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
    </svg>
  );
}

function ChainNode({
  task,
  isCurrent,
  roleMap,
}: {
  task: ChainTask;
  isCurrent: boolean;
  roleMap: Record<string, { name: string; color: string }>;
}) {
  const role = task.roleSlug ? roleMap[task.roleSlug] : null;
  const style = STATUS_STYLES[task.status] ?? STATUS_STYLES.pending;
  const isBlocked = task.status === 'pending' && !isCurrent;
  const isDone = task.status === 'completed';

  const card = (
    <div
      className={[
        'flex flex-col gap-2 p-3 rounded-[10px] border min-w-[155px] max-w-[195px]',
        'bg-surface-2 border-border-default',
        isCurrent ? 'ring-1 ring-primary/50' : '',
        isBlocked ? 'opacity-50' : '',
      ].join(' ')}
    >
      {/* Role badge */}
      <div className="flex items-center gap-1.5 min-h-[18px]">
        {role ? (
          <>
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: role.color }}
            />
            <span
              className="text-[11px] font-medium truncate"
              style={{ color: role.color }}
            >
              {role.name}
            </span>
          </>
        ) : (
          <span className="text-[11px] text-text-muted">—</span>
        )}
      </div>

      {/* Title */}
      <div className="text-[12px] font-medium text-text-primary leading-tight line-clamp-2">
        {task.title}
      </div>

      {/* Status + artifacts row */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className={`inline-flex items-center gap-1 font-mono text-[10px] ${style.text}`}>
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${style.dot}`} />
          {task.status === 'waiting_input' ? 'waiting' : task.status}
        </span>

        {/* PR chip */}
        {task.worker?.prNumber && (
          <span className="bg-status-success/10 text-status-success font-mono text-[10px] rounded px-1.5">
            #{task.worker.prNumber}{isDone ? ' ✓' : ''}
          </span>
        )}

        {/* Artifact count (non-PR) */}
        {task.artifacts.length > 0 && !task.worker?.prNumber && (
          <span className="bg-surface-3 text-text-muted font-mono text-[10px] rounded px-1.5">
            {task.artifacts.length} artifact{task.artifacts.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>
    </div>
  );

  if (isCurrent) return card;

  return (
    <Link href={`/app/tasks/${task.id}`} className="hover:opacity-80 transition-opacity">
      {card}
    </Link>
  );
}

export default function PlanChainView({ currentTaskId, tasks, roleMap }: PlanChainViewProps) {
  return (
    <div className="mb-6">
      <div className="font-mono text-[10px] uppercase tracking-[2.5px] text-text-muted pb-2 border-b border-border-default mb-3">
        Execution Plan · {tasks.length} phase{tasks.length !== 1 ? 's' : ''}
      </div>
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
        {tasks.map((task, i) => (
          <div key={task.id} className="flex items-center gap-1.5 shrink-0">
            {i > 0 && <ChevronRight />}
            <ChainNode
              task={task}
              isCurrent={task.id === currentTaskId}
              roleMap={roleMap}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
