import TaskTimeRow from '@/components/TaskTimeRow';
import { buildTimeRow } from '@/lib/task-time-row';
import type { TaskEstimatePayload } from '@buildd/shared';

/** Synthetic examples: the QA clone deliberately removes frozen estimates. */
export default function EstimateFixturesPage() {
  const prior: TaskEstimatePayload = {
    estimatorVersion: 'fixture-v1', p50Minutes: 6.2, p80Minutes: 14.2,
    p50Tokens: 1_640_000, p80Tokens: 7_000_000, expectedRepairs: 0, calibration: 'unknown',
    explanation: { sources: [{ source: 'prior', n: 50, weight: 1 }], priorWeight: 1, clusterLabel: null, summary: '',
      evidence: { cutoff: '2026-01-01T00:00:00.000Z', history: { total: 80, completedWork: 60, eligible: 40, excluded: { missing_session_actuals: 20 } },
        neighbours: { retrieved: 0, used: 0, reason: 'no_similar_neighbours' },
        clusters: { available: 2, used: 0, reason: 'task_area_unmapped' }, unavailable: [] } },
  };
  const cold: TaskEstimatePayload = { ...prior, explanation: { ...prior.explanation, evidence: { ...prior.explanation.evidence!, history: { total: 0, completedWork: 0, eligible: 0, excluded: {} } } } };
  const local: TaskEstimatePayload = { ...prior, calibration: 'passed', explanation: { ...prior.explanation, priorWeight: 0, sources: [{ source: 'neighbours', n: 12, weight: 1 }] } };
  const sparse: TaskEstimatePayload = { ...local, calibration: 'unknown', p50Minutes: 7.6, p80Minutes: 8.1,
    explanation: { ...local.explanation, sources: [{ source: 'neighbours', n: 4, weight: 1 }] } };
  const none: TaskEstimatePayload = { ...prior, explanation: { ...prior.explanation, sources: [] } };
  const examples = [
    ['established', 'Established repo', local], ['cold-start', 'New repo', cold],
    ['no-comparable', 'Existing history without comparable tasks', prior], ['sparse', 'Sparse, uncalibrated evidence', sparse],
    ['unavailable', 'Insufficient evidence', none],
  ] as const;
  return <main className="max-w-2xl mx-auto p-4 space-y-6">
    <h1 className="text-heading">Task estimate examples</h1>
    {examples.map(([key, title, estimate]) => <section key={key} data-testid={`estimate-${key}`} className="border-b border-border pb-4">
      <h2 className="text-body font-semibold mb-2">{title}</h2>
      <TaskTimeRow view={buildTimeRow({ sessions: [], finished: false, now: 0, estimate })!} />
    </section>)}
  </main>;
}
