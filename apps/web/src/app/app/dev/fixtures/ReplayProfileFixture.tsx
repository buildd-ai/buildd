/**
 * `?state=replay-profile`: the v2 per-category replay profile populated the way a real run set
 * fills it: several categories, a sealed-holdout split, grader flags, harness errors, a
 * paired verdict and a long config id. Built through the real buildModelComparison, so the
 * fixture cannot drift from what the page receives. Display only.
 */
import { buildModelComparison, type ComparisonRow } from '@buildd/core/model-comparison';
import ReplayProfile from '@/app/app/(protected)/settings/models/comparison/ReplayProfile';

const CATEGORIES = ['find-by-behaviour', 'debugging', 'multi-file-change', 'code-review', 'long-context-retention', 'terminal-recovery'];
const CONFIGS = ['local-qwen3-coder-30b-a3b-instruct-q4_k_m@32768', 'm@8192'];

let seq = 0;
function run(configId: string, category: string, split: 'dev' | 'sealed-holdout', caseId: string, result: string, extra: Record<string, unknown> = {}): ComparisonRow {
  seq++;
  const failureClass = result === 'pass' ? null : result === 'error' ? 'harness' : 'model';
  return {
    workerId: `fx-w${seq}`, taskId: `fx-t${seq}`, chainId: null, resolvedModel: 'fx-model', endpointKind: 'local_loopback',
    modelVersion: null, quantization: null, backend: null, harnessVersion: null, runtime: null, taskClass: null,
    startedAt: new Date(), endedAt: null, createdAt: new Date(), durationMs: 4000 + seq * 913, inputTokens: 12000 + seq * 310,
    outputTokens: 800 + seq * 17, tokensPerSecond: null, terminalOutcome: 'completed', failureOrigin: 'none', costUsd: null,
    reviewVerdict: null, ciState: null, specVerdict: null, prOutcome: null, reworked: false,
    evaluation: {
      provenance: 'controlled_replay', suiteVersion: 'v2', scoringVersion: 'score-v2', caseId, configId, trial: 1, runId: `fx-r${seq}`, result,
      v2: { category, split, graderId: `${category}-v1`, failureClass, ...extra },
    },
  } as ComparisonRow;
}

function rows(): ComparisonRow[] {
  const out: ComparisonRow[] = [];
  CONFIGS.forEach((cfg, ci) => {
    CATEGORIES.forEach((cat, k) => {
      for (let i = 0; i < 6; i++) {
        const result = (i + k + ci) % 3 === 0 ? 'fail' : (i === 5 && ci === 0 && k === 1) ? 'error' : 'pass';
        const extra: Record<string, unknown> = {};
        if (cat === 'find-by-behaviour' && result === 'fail') extra.flags = ['fabrication', 'wrong_abstention'], extra.absenceClaimed = true;
        if (cat === 'code-review') extra.detail = { precision: 0.62, recall: 0.48 };
        if (cat === 'long-context-retention') extra.detail = { retention: [0.9, 0.7, 0.55] };
        out.push(run(cfg, cat, 'dev', `${cat}-${i}`, result, extra));
      }
      for (let i = 0; i < 2; i++) out.push(run(cfg, cat, 'sealed-holdout', `${cat}-sealed-${i}`, (i + ci) % 2 ? 'pass' : 'fail'));
    });
  });
  return out;
}

export default function ReplayProfileFixture() {
  const data = buildModelComparison(rows(), {});
  return (
    <div className="max-w-3xl mx-auto p-4" data-testid="replay-profile-fixture">
      <ReplayProfile replay={data.replay} />
    </div>
  );
}
