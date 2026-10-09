import Link from 'next/link';
import { displayTaskTitle } from '@/lib/task-title';
import { deriveTaskEyebrow, taskEyebrowText, type TaskEyebrow } from '@/lib/task-eyebrow';

interface ChainTask {
  id: string;
  title: string;
  status: string;
  roleSlug: string | null;
  taskClass?: string | null;
  roleInferred?: boolean;
  worker: {
    prUrl: string | null;
    prNumber: number | null;
    turns: number;
    branch: string;
    status?: string | null;
    mergedAt?: Date | string | null;
    prLifecycleStatus?: string | null;
    runner?: string | null;
  } | null;
  artifacts: Array<{ id: string; type: string; title: string | null }>;
}

interface PlanChainViewProps {
  currentTaskId: string;
  tasks: ChainTask[];
  roleMap: Record<string, { name: string; color: string }>;
  /** Runners online for the team; a running card names its runner only when > 1. */
  onlineRunners?: number;
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

const OUTCOME_TONE: Record<'success' | 'warning' | 'muted', string> = {
  success: 'text-status-success',
  warning: 'text-status-warning',
  muted: 'text-text-muted',
};

/** The card's eyebrow line (lib/task-eyebrow.ts). Nothing renders for a null eyebrow. */
function Eyebrow({ eyebrow }: { eyebrow: TaskEyebrow }) {
  if (!eyebrow) return null;
  if (eyebrow.kind === 'outcome') {
    return (
      <span data-testid="plan-card-eyebrow" className={`font-mono text-[11px] md:text-[10px] truncate ${OUTCOME_TONE[eyebrow.tone]}`}>
        {eyebrow.label}
      </span>
    );
  }
  if (eyebrow.kind === 'runner') {
    return <span data-testid="plan-card-eyebrow" className="font-mono text-[11px] md:text-[10px] text-text-muted truncate">{eyebrow.label}</span>;
  }
  return (
    <span data-testid="plan-card-eyebrow" title={taskEyebrowText(eyebrow)} className="flex items-center gap-1.5 min-w-0">
      {eyebrow.color && <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: eyebrow.color }} />}
      <span className="text-[11px] font-medium truncate" style={eyebrow.color ? { color: eyebrow.color } : undefined}>
        {eyebrow.label}
      </span>
      {eyebrow.inferred && <span className="font-mono text-[11px] md:text-[10px] text-text-muted shrink-0">auto</span>}
      {eyebrow.runner && <span className="font-mono text-[11px] md:text-[10px] text-text-muted truncate min-w-0 shrink-[10]">· {eyebrow.runner}</span>}
    </span>
  );
}

function ChainNode({
  task,
  isCurrent,
  roleMap,
  onlineRunners,
}: {
  task: ChainTask;
  isCurrent: boolean;
  roleMap: Record<string, { name: string; color: string }>;
  onlineRunners: number;
}) {
  const role = task.roleSlug ? roleMap[task.roleSlug] : null;
  const style = STATUS_STYLES[task.status] ?? STATUS_STYLES.pending;
  const isBlocked = task.status === 'pending' && !isCurrent;
  const eyebrow = deriveTaskEyebrow({
    status: task.status,
    workerStatus: task.worker?.status,
    taskClass: task.taskClass,
    role: task.roleSlug ? { slug: task.roleSlug, name: role?.name, color: role?.color } : null,
    roleInferred: task.roleInferred,
    runner: task.worker?.runner,
    onlineRunners,
    pr: task.worker ? { number: task.worker.prNumber, mergedAt: task.worker.mergedAt, lifecycle: task.worker.prLifecycleStatus } : null,
    artifactCount: task.artifacts?.length ?? 0,
  });
  // A terminal card's eyebrow already carries its PR / artifacts.
  const outcomeInEyebrow = eyebrow?.kind === 'outcome';

  const card = (
    <div
      className={[
        'flex flex-col gap-2 p-3 border min-w-[155px] max-w-[195px]',
        'bg-surface-2 border-border-default',
        isCurrent ? 'ring-1 ring-primary/50' : '',
        isBlocked ? 'opacity-50' : '',
      ].join(' ')}
    >
      {/* Eyebrow — role while pending/running, what shipped once terminal, or
          nothing. The empty row keeps titles aligned across the strip. */}
      <div className="flex items-center min-h-[18px] min-w-0">
        <Eyebrow eyebrow={eyebrow} />
      </div>

      {/* Title */}
      <div className="text-[12px] font-medium text-text-primary leading-tight line-clamp-2" title={task.title}>
        {displayTaskTitle(task.title)}
      </div>

      {/* Status + artifacts row */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className={`inline-flex items-center gap-1 font-mono text-[11px] md:text-[10px] ${style.text}`}>
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${style.dot}`} />
          {task.status === 'waiting_input' ? 'waiting' : task.status}
        </span>

        {/* PR chip — a live task's PR; a terminal one says it in the eyebrow */}
        {task.worker?.prNumber && !outcomeInEyebrow && (
          <span className="bg-status-info/10 text-status-info font-mono text-[11px] md:text-[10px] rounded px-1.5">
            #{task.worker.prNumber}
          </span>
        )}

        {/* Artifact count (non-PR) */}
        {(task.artifacts || []).length > 0 && !task.worker?.prNumber && !outcomeInEyebrow && (
          <span className="bg-surface-3 text-text-muted font-mono text-[11px] md:text-[10px] rounded px-1.5">
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

export default function PlanChainView({ currentTaskId, tasks, roleMap, onlineRunners = 0 }: PlanChainViewProps) {
  return (
    <div className="mb-6">
      <div className="font-mono text-[11px] md:text-[10px] uppercase tracking-[2.5px] text-text-muted pb-2 border-b border-border-default mb-3">
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
              onlineRunners={onlineRunners}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
