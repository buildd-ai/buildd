'use client';

/**
 * `?state=run-activity`: the task page's run-detail pieces over each scenario in
 * run-activity-fixtures.ts, at the width the task page's main column gives them.
 * Live components wherever the page uses one (RealTimeWorkerView, WorkerSteerPanel,
 * InstructionHistory, TaskEvidenceCard, lineageWorkerHistory); the worker-history
 * row is inline on the server page, so its fixture copy keeps the page's shape.
 */
import { useEffect, useState } from 'react';
import RealTimeWorkerView from '../../(protected)/tasks/[id]/RealTimeWorkerView';
import WorkerSteerPanel from '../../(protected)/tasks/[id]/WorkerSteerPanel';
import InstructionHistory from '../../(protected)/tasks/[id]/InstructionHistory';
import TaskEvidenceCard from '../../(protected)/tasks/[id]/TaskEvidenceCard';
import { lineageWorkerHistory } from '../../(protected)/tasks/[id]/lineage-status';
import {
  ATTEMPT_FLIP,
  RUN_ACTIVITY_FIXTURE_STATE,
  RUN_ACTIVITY_NOW,
  RUN_ACTIVITY_SCENARIOS,
  RUN_ACTIVITY_SCENARIO_TITLES,
  attemptTie,
  failedEvidence,
  failedWorker,
  legacyStreamWorker,
  parseRunActivityScenario,
  researchWorker,
  steeringEndedWorker,
  steeringLiveWorker,
  waitingWorker,
  withFlippedStatus,
  type RunActivityScenario,
  type RunActivityWorker,
} from './run-activity-fixtures';

function WorkerView({ worker, taskStatus = 'running' }: { worker: RunActivityWorker; taskStatus?: string }) {
  return (
    <RealTimeWorkerView
      taskId={`fixture-${worker.id}`}
      initialWorker={worker as never}
      taskStatus={taskStatus}
      outputRequirement={worker.id === 'research' ? 'artifact_required' : 'pr_required'}
      roleName="Builder"
      nowMs={RUN_ACTIVITY_NOW}
    />
  );
}

/** The task page's Worker History rows, ordered by lineageWorkerHistory. */
function AttemptsTie() {
  const [flipped, setFlipped] = useState(false);
  const rows = lineageWorkerHistory(attemptTie.own, (flipped ? withFlippedStatus(attemptTie, ATTEMPT_FLIP) : attemptTie).attempts);
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        data-testid="run-activity-flip-status"
        onClick={() => setFlipped(f => !f)}
        className="self-start min-h-11 border border-border-default px-3 font-mono text-meta text-text-secondary hover:border-border-strong"
      >
        {flipped ? `Undo: ${ATTEMPT_FLIP.id} back to ${ATTEMPT_FLIP.from}` : `Flip ${ATTEMPT_FLIP.id} to ${ATTEMPT_FLIP.to}`}
      </button>
      <ol data-testid="task-worker-history" className="border border-border-default">
        {rows.map(({ worker, attemptLabel }) => (
          <li
            key={worker.id}
            data-worker-id={worker.id}
            data-status={worker.status}
            className="flex min-h-11 items-center gap-3 border-b border-border-default/40 px-3 py-3 last:border-b-0"
          >
            {/* The runner name truncates first; the attempt label never wraps or cuts. */}
            <span className="flex min-w-0 flex-1 text-[13px]">
              <span className="min-w-0 truncate text-text-primary">{worker.name}</span>
              {attemptLabel && <span className="shrink-0 whitespace-nowrap text-text-muted">&nbsp;· {attemptLabel}</span>}
            </span>
            <span className="shrink-0 font-mono text-[11px] uppercase tracking-[1px] text-text-secondary">{worker.status}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Scenario({ scenario }: { scenario: RunActivityScenario }) {
  switch (scenario) {
    case 'research-lifecycle':
      return <WorkerView worker={researchWorker} />;
    case 'legacy-percent-stream':
      return <WorkerView worker={legacyStreamWorker} />;
    case 'waiting-input':
      return <WorkerView worker={waitingWorker} />;
    case 'error':
      return (
        <div className="flex flex-col gap-4">
          <TaskEvidenceCard status="failed" result={{ evidence: failedEvidence }} workerError={failedWorker.error ?? null} />
          <WorkerView worker={failedWorker} taskStatus="failed" />
          <p data-testid="run-activity-worker-error" className="whitespace-pre-wrap break-words text-[12px] text-status-error">{failedWorker.error}</p>
        </div>
      );
    case 'steering-acks':
      return (
        <div className="flex flex-col gap-6">
          <div data-testid="run-activity-steer-live">
            <WorkerSteerPanel
              workerId={steeringLiveWorker.id}
              status={steeringLiveWorker.status}
              hasUnansweredQuestion={false}
              instructionHistory={steeringLiveWorker.instructionHistory as never}
            />
          </div>
          <div data-testid="run-activity-steer-ended">
            <p className="section-label">Ended run</p>
            <InstructionHistory history={steeringEndedWorker.instructionHistory as never} workerStatus={steeringEndedWorker.status} onResend={() => {}} />
          </div>
        </div>
      );
    case 'attempts-tie':
      return <AttemptsTie />;
  }
}

export default function RunActivityFixture() {
  // Read the URL after mount so server and client render alike.
  const [scenarios, setScenarios] = useState<RunActivityScenario[] | null>(null);
  useEffect(() => { setScenarios(parseRunActivityScenario(new URLSearchParams(window.location.search))); }, []);

  return (
    <div data-testid="run-activity-fixture" className="min-h-screen bg-surface-1 text-text-primary">
      <header className="border-b-2 border-border-strong px-4 py-4 md:px-8">
        <p className="section-label">Dev fixtures</p>
        <h1 className="mt-1 font-mono text-[18px] font-semibold">Run activity</h1>
        <nav aria-label="Scenarios" className="-mx-4 mt-3 flex gap-1.5 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-wrap md:px-0">
          {RUN_ACTIVITY_SCENARIOS.map(s => (
            <a
              key={s}
              href={`?state=${RUN_ACTIVITY_FIXTURE_STATE}&scenario=${s}`}
              className="flex min-h-11 shrink-0 items-center border border-border-default bg-surface-2 px-2.5 font-mono text-[12px] text-text-secondary hover:border-border-strong hover:text-text-primary"
            >
              {s}
            </a>
          ))}
        </nav>
      </header>
      <main className="mx-auto flex max-w-4xl flex-col gap-10 px-4 py-6 md:px-8">
        {scenarios?.map(s => (
          <section key={s} data-testid={`run-activity-${s}`} className="flex min-w-0 flex-col gap-3">
            <h2 className="section-label">{RUN_ACTIVITY_SCENARIO_TITLES[s]}</h2>
            <Scenario scenario={s} />
          </section>
        ))}
      </main>
    </div>
  );
}
