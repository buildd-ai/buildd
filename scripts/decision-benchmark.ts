#!/usr/bin/env bun
/**
 * Offline benchmark for a decision-call question set.
 *
 * Runs a question set over YOUR labelled examples and reports accuracy overall
 * and at confidence thresholds, on a deterministic held-out split. Use it to
 * pick a confidence gate, and to compare label wordings (tune on `--split train`,
 * judge on the default held-out split — never the other way round).
 *
 *   OPENROUTER_API_KEY=sk-or-... bun run scripts/decision-benchmark.ts \
 *     --set task_category --file .decision-data/task-category.jsonl
 *
 * Input is JSONL, one example per line, e.g. for `task_category`:
 *   {"id":"t1","label":"bug","title":"...","description":"..."}
 *
 * The data file stays local: `.decision-data/` is gitignored, and this repo is
 * public. Nothing here touches the database; the key comes from the env.
 *
 * `task_role` (role-routing §6(b)) builds its question per row, from the
 * row's own candidate set, the way the live shadow does:
 *   {"id":"t1","role":"builder","category":"feature","title":"...","description":"...",
 *    "kind":null,"candidates":["builder","researcher","writer"]}
 * Candidates are slugs resolved through `--roles <file>` (a JSON array of
 * {slug,name,whenToUse,notFor?}: the workspace's routing text, kept local), or
 * full objects inline. Gold `none` means "no role should take this"; it is
 * never an option, so it only counts against a gate that applies it. The same
 * file serves `--set task_category --label-field category`, so role and
 * category are labelled on one sample. The output adds the gate table and the
 * picked TASK_ROLE_MIN_CONFIDENCE.
 *
 * Flags:
 *   --set <name>          question set (default task_category)
 *   --label-field <key>   which field holds the gold (default: the set's own)
 *   --roles <path>        task_role: routing text for slug candidates
 *   --file <path>         labelled JSONL (default .decision-data/<set>.jsonl)
 *   --split heldout|train|all   (default heldout)
 *   --held-out <0..1>     held-out fraction (default 0.3)
 *   --seed <s>            split seed (default decision-benchmark)
 *   --model <id>          model override (default: the client's pinned model)
 *   --concurrency <n>     parallel requests (default 4)
 *   --limit <n>           cap examples (for a quick smoke run)
 *   --json                print the summary as JSON
 */
import { readFileSync } from 'node:fs';
import { decisionCall, describeDecisionError, type DecisionQuestions } from '../packages/core/decision-client';
import {
  parseLabeledJsonl,
  splitHeldOut,
  summarizeBenchmark,
  formatBenchmarkSummary,
  type LabeledExample,
  type ScoredExample,
} from '../packages/core/decision-benchmark';
import { TASK_CATEGORY_QUESTIONS, buildTaskCategoryState } from '../apps/web/src/lib/task-category-decision';
import { classifyTask } from '../apps/web/src/lib/task-category';
import { HEARTBEAT_TRIAGE_QUESTIONS, buildHeartbeatTriageState } from '../apps/web/src/lib/heartbeat-triage';
import { buildRoleQuestion, buildTaskRoleState, type RoleCandidate } from '../apps/web/src/lib/task-role-decision';
import { pickGateThreshold, formatGateTable } from '../packages/core/decision-benchmark';

interface QuestionSet {
  questions: DecisionQuestions;
  /** Per-row questions (a dynamic label set). Returns the questions and how to read the answer back. */
  questionsFor?(fields: Record<string, unknown>): { questions: DecisionQuestions; toLabel(choice: string): string } | null;
  /** The field the gold is read from when --label-field is not given. */
  labelField?: string;
  /** Print the apply-gate table (a wrong answer is worse than none). */
  gate?: boolean;
  /** Which choice question's answer is compared with the gold label. */
  answerKey: string;
  toState(fields: Record<string, unknown>): Record<string, unknown> | string;
  /** The incumbent logic, for a side-by-side accuracy line. */
  baseline?(fields: Record<string, unknown>): string | null;
  /**
   * A label whose wrong picks are the expensive ones: its precision is printed
   * at each confidence threshold, which is what its gate is read from.
   */
  gatedLabel?: string;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Routing text for slug candidates (`--roles`). Loaded once in main(). */
let ROLE_TEXT: Map<string, RoleCandidate> = new Map();

function roleCandidates(fields: Record<string, unknown>): RoleCandidate[] {
  const raw = Array.isArray(fields.candidates) ? fields.candidates : [];
  const out: RoleCandidate[] = [];
  for (const c of raw) {
    if (typeof c === 'string') {
      const known = ROLE_TEXT.get(c);
      if (!known) throw new Error(`candidate "${c}" has no routing text; pass --roles <file> or inline the candidate`);
      out.push(known);
    } else if (c && typeof c === 'object' && typeof (c as RoleCandidate).slug === 'string') {
      const r = c as RoleCandidate;
      out.push({ slug: r.slug, name: r.name ?? r.slug, whenToUse: r.whenToUse, ...(r.notFor ? { notFor: r.notFor } : {}), connectorRefs: [] });
    }
  }
  return out;
}

const SETS: Record<string, QuestionSet> = {
  task_category: {
    questions: TASK_CATEGORY_QUESTIONS,
    answerKey: 'category',
    toState: f => buildTaskCategoryState(str(f.title), str(f.description)),
    baseline: f => classifyTask(str(f.title), str(f.description)),
  },
  // {"id":"…","label":"wait"|"act","description":"<the cycle's heartbeat description>"}
  // Gold is what the organizer did on that cycle (see docs/design/heartbeat-triage.md).
  heartbeat_triage: {
    questions: HEARTBEAT_TRIAGE_QUESTIONS,
    answerKey: 'next',
    toState: f => buildHeartbeatTriageState(str(f.description)),
    // Today every cycle that reaches this point dispatches the organizer.
    baseline: () => 'act',
    gatedLabel: 'wait',
  },
  task_role: {
    questions: {},
    labelField: 'role',
    answerKey: 'role',
    gate: true,
    questionsFor: f => {
      const q = buildRoleQuestion(roleCandidates(f));
      if (!q) return null;
      return { questions: { role: q.question }, toLabel: choice => q.slugFor.get(choice) ?? choice };
    },
    toState: f => buildTaskRoleState({
      title: str(f.title),
      label: typeof f.taskLabel === 'string' ? f.taskLabel : null,
      kind: typeof f.kind === 'string' ? f.kind : null,
      description: str(f.description),
      pathManifest: Array.isArray(f.paths) ? f.paths as string[] : null,
      pathManifestIsConcrete: Array.isArray(f.paths) && f.paths.length > 0,
      creationSource: typeof f.source === 'string' ? f.source : null,
      inMission: f.inMission === true,
      outputRequirement: typeof f.output === 'string' ? f.output : null,
    }),
    // Today every role-less task stays role-less.
    baseline: () => 'none',
  },
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const setName = arg('set') ?? 'task_category';
  const set = SETS[setName];
  if (!set) throw new Error(`unknown --set ${setName}; known: ${Object.keys(SETS).join(', ')}`);

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is required');

  const rolesFile = arg('roles');
  if (rolesFile) {
    const roles = JSON.parse(readFileSync(rolesFile, 'utf8')) as Array<{ slug: string; name?: string; whenToUse: string; notFor?: string }>;
    ROLE_TEXT = new Map(roles.map(r => [r.slug, { slug: r.slug, name: r.name ?? r.slug, whenToUse: r.whenToUse, ...(r.notFor ? { notFor: r.notFor } : {}), connectorRefs: [] }]));
  }

  const file = arg('file') ?? `.decision-data/${setName.replace(/_/g, '-')}.jsonl`;
  const { examples, skipped } = parseLabeledJsonl(readFileSync(file, 'utf8'), { labelField: arg('label-field') ?? set.labelField });
  const { train, heldOut } = splitHeldOut(examples, {
    heldOutFraction: arg('held-out') ? Number(arg('held-out')) : undefined,
    seed: arg('seed'),
  });
  const split = arg('split') ?? 'heldout';
  let chosen: LabeledExample[] = split === 'train' ? train : split === 'all' ? examples : heldOut;
  const limit = arg('limit') ? Number(arg('limit')) : undefined;
  if (limit) chosen = chosen.slice(0, limit);

  console.error(`${file}: ${examples.length} examples (${skipped} skipped), train ${train.length}, held-out ${heldOut.length}; running ${split} (${chosen.length})`);

  const concurrency = Math.max(1, Number(arg('concurrency') ?? 4));
  const scored: ScoredExample[] = new Array(chosen.length);
  let next = 0;
  let costUsd = 0;
  let latencyTotal = 0;

  async function worker() {
    while (next < chosen.length) {
      const i = next++;
      const ex = chosen[i];
      const baseline = set.baseline ? set.baseline(ex.fields) : undefined;
      const dynamic = set.questionsFor ? set.questionsFor(ex.fields) : null;
      if (set.questionsFor && !dynamic) {
        // Fewer than two candidates: the live path makes no call and leaves the role null.
        scored[i] = { id: ex.id, gold: ex.label, predicted: null, confidence: null, baseline, error: 'too_few_candidates' };
        continue;
      }
      const res = await decisionCall({
        capability: 'task_category_shadow',
        teamId: 'offline',
        apiKey,
        model: arg('model'),
        state: set.toState(ex.fields),
        questions: dynamic ? dynamic.questions : set.questions,
        timeoutMs: 10_000,
      });
      if (res.ok) {
        const a = res.answers[set.answerKey] as { choice?: string; confidence?: number };
        const predicted = a.choice == null ? null : dynamic ? dynamic.toLabel(a.choice) : a.choice;
        scored[i] = { id: ex.id, gold: ex.label, predicted, confidence: a.confidence ?? null, baseline };
        costUsd += res.usage.costUsd ?? 0;
        latencyTotal += res.latencyMs;
      } else {
        scored[i] = { id: ex.id, gold: ex.label, predicted: null, confidence: null, baseline, error: describeDecisionError(res.error) };
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  const summary = summarizeBenchmark(scored);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ set: setName, split, costUsd, summary, ...(set.gate ? { gate: pickGateThreshold(scored) } : {}) }, null, 2));
  } else {
    console.log(formatBenchmarkSummary(`${setName} / ${split}`, summary));
    const ok = scored.filter(s => !s.error).length;
    console.log(`\ncost $${costUsd.toFixed(6)}   mean latency ${ok ? Math.round(latencyTotal / ok) : 0}ms`);
    const errors = scored.filter(s => s.error);
    if (errors.length) console.log(`errors (first 5): ${errors.slice(0, 5).map(e => `${e.id}: ${e.error}`).join(' | ')}`);
    if (set.gate) {
      const gate = pickGateThreshold(scored);
      console.log(`\napply gate (precision >= 0.95 on every label with >= 10 picks):\n${formatGateTable(gate.rows, gate.threshold)}`);
    }
    if (set.gatedLabel) {
      console.log(`\n'${set.gatedLabel}' picks by confidence (precision = gold agrees):`);
      for (const t of [0.5, 0.7, 0.8, 0.9, 0.95]) {
        const picks = scored.filter(s => s.predicted === set.gatedLabel && (s.confidence ?? 0) >= t);
        const right = picks.filter(s => s.gold === set.gatedLabel).length;
        const gold = scored.filter(s => s.gold === set.gatedLabel).length;
        console.log(`  >=${t.toFixed(2)}  picks ${picks.length}  precision ${picks.length ? (right / picks.length).toFixed(2) : '-'}  covers ${gold ? (right / gold).toFixed(2) : '-'} of gold`);
      }
    }
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
