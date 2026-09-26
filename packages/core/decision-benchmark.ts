/**
 * Pure scoring for offline decision-call benchmarks.
 *
 * A decision question is only as good as its label definitions, and the only
 * way to know whether a definition works — or which confidence threshold is
 * safe to act on — is to run it over labelled examples the definitions were
 * NOT tuned on. This module does the bookkeeping; `scripts/decision-benchmark.ts`
 * does the I/O. No DB, no network.
 *
 * Labelled data is a local JSONL file that is never committed (see
 * `.gitignore` → `.decision-data/`): it is the reader's own tasks.
 */

export interface LabeledExample {
  /** Stable id; drives the train/held-out split. Falls back to the line number. */
  id: string;
  /** Gold label. */
  label: string;
  /** Free-form fields the question set turns into `state` (e.g. title, description). */
  fields: Record<string, unknown>;
}

export interface ScoredExample {
  id: string;
  gold: string;
  predicted: string | null;
  confidence: number | null;
  /** Optional incumbent (e.g. the keyword classifier) on the same example. */
  baseline?: string | null;
  error?: string;
}

/** Parse JSONL. Each line: `{ "label": "...", "id"?: "...", ...fields }`. */
export function parseLabeledJsonl(text: string): { examples: LabeledExample[]; skipped: number } {
  const examples: LabeledExample[] = [];
  let skipped = 0;
  text.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) return;
    try {
      const row = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof row.label !== 'string' || row.label === '') { skipped++; return; }
      const { id, label, ...fields } = row;
      examples.push({ id: typeof id === 'string' && id ? id : `line-${i + 1}`, label, fields });
    } catch {
      skipped++;
    }
  });
  return { examples, skipped };
}

/**
 * FNV-1a plus a murmur3 finalizer, so the split is deterministic across runs
 * and machines. The finalizer matters: raw FNV-1a mixes the high bits poorly for
 * ids that differ only in a trailing digit, which skews the split badly.
 */
function hash01(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 0x100000000;
}

/**
 * Deterministic split by id. Tune label definitions on `train`; report on
 * `heldOut`. Changing `seed` reshuffles; keep it fixed while comparing wordings.
 */
export function splitHeldOut<T extends { id: string }>(
  items: T[],
  opts: { heldOutFraction?: number; seed?: string } = {},
): { train: T[]; heldOut: T[] } {
  const fraction = opts.heldOutFraction ?? 0.3;
  const seed = opts.seed ?? 'decision-benchmark';
  const train: T[] = [];
  const heldOut: T[] = [];
  for (const item of items) (hash01(`${seed}:${item.id}`) < fraction ? heldOut : train).push(item);
  return { train, heldOut };
}

export interface ThresholdRow {
  threshold: number;
  /** Share of examples with confidence ≥ threshold (the auto-apply rate). */
  coverage: number;
  /** Accuracy among covered examples. Null when nothing is covered. */
  accuracy: number | null;
  covered: number;
}

export interface BenchmarkSummary {
  total: number;
  answered: number;
  errors: number;
  /** Accuracy over every example; an error counts as wrong. */
  accuracy: number;
  baselineAccuracy: number | null;
  thresholds: ThresholdRow[];
  perLabel: Record<string, { gold: number; predicted: number; correct: number; precision: number | null; recall: number | null }>;
  /** gold → predicted → count. */
  confusion: Record<string, Record<string, number>>;
}

export const DEFAULT_THRESHOLDS = [0, 0.5, 0.7, 0.8, 0.9, 0.95] as const;

export function summarizeBenchmark(
  scored: ScoredExample[],
  thresholds: readonly number[] = DEFAULT_THRESHOLDS,
): BenchmarkSummary {
  const total = scored.length;
  const answered = scored.filter(s => s.predicted !== null && s.confidence !== null);
  const correct = answered.filter(s => s.predicted === s.gold).length;
  const withBaseline = scored.filter(s => s.baseline !== undefined);

  const perLabel: BenchmarkSummary['perLabel'] = {};
  const confusion: BenchmarkSummary['confusion'] = {};
  const bump = (label: string) => (perLabel[label] ??= { gold: 0, predicted: 0, correct: 0, precision: null, recall: null });
  for (const s of scored) {
    bump(s.gold).gold++;
    const p = s.predicted ?? '(error)';
    if (s.predicted !== null) bump(s.predicted).predicted++;
    if (s.predicted === s.gold) bump(s.gold).correct++;
    (confusion[s.gold] ??= {})[p] = ((confusion[s.gold] ??= {})[p] ?? 0) + 1;
  }
  for (const row of Object.values(perLabel)) {
    row.precision = row.predicted ? row.correct / row.predicted : null;
    row.recall = row.gold ? row.correct / row.gold : null;
  }

  return {
    total,
    answered: answered.length,
    errors: total - answered.length,
    accuracy: total ? correct / total : 0,
    baselineAccuracy: withBaseline.length
      ? withBaseline.filter(s => s.baseline === s.gold).length / withBaseline.length
      : null,
    thresholds: thresholds.map(threshold => {
      const covered = answered.filter(s => (s.confidence ?? 0) >= threshold);
      return {
        threshold,
        covered: covered.length,
        coverage: total ? covered.length / total : 0,
        accuracy: covered.length ? covered.filter(s => s.predicted === s.gold).length / covered.length : null,
      };
    }),
    perLabel,
    confusion,
  };
}

const pct = (n: number | null) => (n === null ? '   —  ' : `${(n * 100).toFixed(1).padStart(5)}%`);

export function formatBenchmarkSummary(title: string, s: BenchmarkSummary): string {
  const lines = [
    `== ${title} ==`,
    `examples ${s.total}  answered ${s.answered}  errors ${s.errors}`,
    `accuracy ${pct(s.accuracy)}` + (s.baselineAccuracy !== null ? `   baseline ${pct(s.baselineAccuracy)}` : ''),
    '',
    'confidence ≥   coverage   accuracy',
    ...s.thresholds.map(t => `      ${t.threshold.toFixed(2)}     ${pct(t.coverage)}     ${pct(t.accuracy)}`),
    '',
    'label          gold  pred  precision  recall',
    ...Object.entries(s.perLabel).sort().map(([label, r]) =>
      `${label.padEnd(14)} ${String(r.gold).padStart(4)}  ${String(r.predicted).padStart(4)}   ${pct(r.precision)}   ${pct(r.recall)}`),
  ];
  return lines.join('\n');
}
