/**
 * Task classifier — calls Haiku to tag a task with `kind` and `complexity`.
 *
 * Used when a task is created outside a mission (direct API/dashboard) and
 * therefore doesn't come pre-classified by the Organizer. One ~$0.001 Haiku
 * call per task. Result is persisted on the task row and never re-classified.
 *
 * The classifier is an opt-in helper. Callers decide whether the savings
 * justify the latency and cost. For missions, prefer the Organizer's output.
 */

import { resolveModelName } from './model-aliases';

export type TaskKind =
  | 'coordination'
  | 'engineering'
  | 'research'
  | 'writing'
  | 'design'
  | 'analysis'
  | 'observation';

export type TaskComplexity = 'simple' | 'normal' | 'complex';

export interface ClassificationInput {
  title: string;
  description?: string | null;
  roleSlug?: string | null;
  /** Anthropic API key override. Falls back to env ANTHROPIC_API_KEY. */
  apiKey?: string;
  /** Override the fetch implementation (used in tests). */
  fetcher?: typeof fetch;
}

export interface ClassificationResult {
  kind: TaskKind;
  complexity: TaskComplexity;
  reason: string;
  classifiedBy: 'classifier';
  model: string;
}

const CLASSIFICATION_SYSTEM = `You are a task classifier for a coding-agent coordination platform.

Given a task title and description, output ONE JSON object with these fields:
- kind: one of ["coordination", "engineering", "research", "writing", "design", "analysis", "observation"]
- complexity: one of ["simple", "normal", "complex"]
- reason: one short sentence explaining your choices

Classification guide:
- coordination: planning, delegation, mission decomposition
- engineering: code edits, refactors, bug fixes, tests
- research: reading docs/repos, summarisation, competitive intel
- writing: PR descriptions, release notes, user docs, changelogs
- design: UI/visual design work (multimodal)
- analysis: SQL pulls, metrics interpretation, reports
- observation: pure-observation heartbeats, health checks (no fan-out)

Complexity guide:
- simple: typo fix, dep bump, one-file doc edit, trivial rename, short lookup
- normal: bounded feature, fix-with-clear-repro, single-component refactor, structured research
- complex: architecture change, ambiguous bug, multi-file refactor, open-ended research

Favour "normal" when unsure. Output JSON only — no prose.`;

export async function classifyTask(input: ClassificationInput): Promise<ClassificationResult> {
  const apiKey = input.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('classifyTask: no ANTHROPIC_API_KEY available');
  }

  const model = await resolveModelName('haiku');
  const fetcher = input.fetcher || fetch;

  const userMsg = [
    `Title: ${input.title}`,
    input.description ? `Description: ${input.description}` : '',
    input.roleSlug ? `Assigned role: ${input.roleSlug}` : '',
  ].filter(Boolean).join('\n\n');

  const res = await fetcher('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 200,
      system: CLASSIFICATION_SYSTEM,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`classifyTask: Anthropic API ${res.status} ${text}`);
  }

  const body = await res.json() as {
    content?: Array<{ type: string; text?: string }>;
  };

  const text = (body.content || [])
    .filter(b => b.type === 'text' && b.text)
    .map(b => b.text)
    .join('')
    .trim();

  // Strip optional markdown fences the model sometimes adds despite the prompt.
  const json = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  let parsed: { kind?: string; complexity?: string; reason?: string };
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`classifyTask: could not parse JSON from model: ${text.slice(0, 200)}`);
  }

  return {
    kind: normaliseKind(parsed.kind),
    complexity: normaliseComplexity(parsed.complexity),
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    classifiedBy: 'classifier',
    model,
  };
}

const VALID_KINDS: TaskKind[] = ['coordination', 'engineering', 'research', 'writing', 'design', 'analysis', 'observation'];
const VALID_COMPLEXITIES: TaskComplexity[] = ['simple', 'normal', 'complex'];

function normaliseKind(value: unknown): TaskKind {
  if (typeof value === 'string' && (VALID_KINDS as string[]).includes(value)) {
    return value as TaskKind;
  }
  return 'engineering';
}

function normaliseComplexity(value: unknown): TaskComplexity {
  if (typeof value === 'string' && (VALID_COMPLEXITIES as string[]).includes(value)) {
    return value as TaskComplexity;
  }
  return 'normal';
}
