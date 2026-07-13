/**
 * Card builders for auto-indexing agent work product.
 *
 * A "card" is a concise, synthesized text representation of an agent work
 * artifact (a completed task, a PR, an artifact, an approved plan) — NOT a raw
 * dump. Each builder produces a single `UpsertChunk` ready to be written into
 * the KnowledgeStore. These functions are pure (no DB / network) so they can be
 * unit-tested in isolation; the mirroring wiring in `mcp-tools.ts` calls them.
 *
 * Conventions:
 * - `id` / `sourceId` is stable per entity so re-runs upsert in place:
 *   `task:{taskId}`, `pr:{prNumber}`, `artifact:{artifactId}`, `plan:{taskId}`.
 * - `metadata` always carries a `phase` (plan | implementation | outcome) and a
 *   linkage key (`taskId` and `missionId` when available).
 * - Very large content is truncated to a sane cap so we never embed full diffs
 *   or megabyte artifacts.
 */
import type { UpsertChunk } from './types';

/** Max characters of free-form content embedded in a single card. ~8KB. */
export const CARD_CONTENT_CAP = 8000;

export function truncate(text: string, cap = CARD_CONTENT_CAP): string {
  if (text.length <= cap) return text;
  return text.slice(0, cap) + `\n\n…[truncated ${text.length - cap} chars]`;
}

/** Drop nullish / empty values so cards stay concise. */
function joinSections(sections: Array<string | null | undefined>): string {
  return sections
    .map(s => (s == null ? '' : String(s).trim()))
    .filter(s => s.length > 0)
    .join('\n\n');
}

// ── complete_task → corpus `task`, phase `outcome` ──────────────────────────

export interface TaskCardInput {
  taskId: string;
  title?: string | null;
  description?: string | null;
  summary?: string | null;
  /** true = success, false = failed. */
  success: boolean;
  prUrl?: string | null;
  missionId?: string | null;
  sourceUrl?: string | null;
}

export function buildTaskCard(input: TaskCardInput): UpsertChunk {
  const status = input.success ? 'SUCCESS' : 'FAILED';
  const content = joinSections([
    input.title ? `# Task: ${input.title}` : `# Task ${input.taskId}`,
    input.description ? `## Description\n${input.description}` : null,
    input.summary ? `## Outcome (${status})\n${input.summary}` : `## Outcome\n${status}`,
    input.prUrl ? `## PR\n${input.prUrl}` : null,
  ]);

  const metadata: Record<string, unknown> = {
    phase: 'outcome',
    taskId: input.taskId,
    success: input.success,
  };
  if (input.missionId) metadata.missionId = input.missionId;
  if (input.prUrl) metadata.prUrl = input.prUrl;

  return {
    id: `task:${input.taskId}`,
    content: truncate(content),
    lexicalText: truncate(joinSections([input.title, input.description, input.summary])),
    sourceType: 'task',
    sourceUrl: input.sourceUrl ?? `/app/tasks/${input.taskId}`,
    metadata,
  };
}

// ── complete_task → corpus `session`, phase `session` ───────────────────────

export interface SessionCardInput {
  taskId: string;
  /** Distinguishes the working session; falls back to taskId for the source id. */
  workerId?: string | null;
  title?: string | null;
  /** The agent's own outcome summary — what it did, tried, decided. */
  summary?: string | null;
  /** Follow-up the agent suggested — signals unfinished threads. */
  nextSuggestion?: string | null;
  /** true = success, false = failed/aborted. */
  success: boolean;
  /** Effort signal (agentic turns) when available. */
  turns?: number | null;
  missionId?: string | null;
  sourceUrl?: string | null;
}

/**
 * A session card is the recency-weighted, process-oriented counterpart to the
 * durable task-outcome card. It answers "did anyone work this area recently,
 * and how did it go?" at claim time — hence corpus `session` (low authority,
 * 7-day half-life). Distinct from `buildTaskCard`: that records the settled
 * outcome; this records the working session and any loose threads it left.
 *
 * Keyed by taskId so a re-worked task upserts to its latest session (recency is
 * exactly what this corpus is for). Best-effort at the call site — a failure to
 * write it must never fail task completion.
 */
export function buildSessionCard(input: SessionCardInput): UpsertChunk {
  const status = input.success ? 'completed' : 'failed/aborted';
  const heading = input.title
    ? `# Session: ${input.title}`
    : `# Session on task ${input.taskId}`;
  const effort = typeof input.turns === 'number' && input.turns > 0
    ? `${input.turns} turns`
    : null;

  const content = joinSections([
    heading,
    `Status: ${status}${effort ? ` · ${effort}` : ''}`,
    input.summary ? `## What happened\n${input.summary}` : null,
    input.nextSuggestion ? `## Left to do / next\n${input.nextSuggestion}` : null,
  ]);

  const metadata: Record<string, unknown> = {
    phase: 'session',
    taskId: input.taskId,
    success: input.success,
  };
  if (input.workerId) metadata.workerId = input.workerId;
  if (input.missionId) metadata.missionId = input.missionId;

  return {
    id: `session:${input.taskId}`,
    content: truncate(content),
    lexicalText: truncate(joinSections([input.title, input.summary, input.nextSuggestion])),
    sourceType: 'session',
    sourceUrl: input.sourceUrl ?? `/app/tasks/${input.taskId}`,
    metadata,
  };
}

// ── create_pr → corpus `pr`, phase `implementation` ─────────────────────────

export interface PrCardInput {
  prNumber: number | string;
  title: string;
  body?: string | null;
  url?: string | null;
  /** Optional summary of changed files (NOT full diffs). */
  changedFiles?: string[] | null;
  taskId?: string | null;
  missionId?: string | null;
}

export function buildPrCard(input: PrCardInput): UpsertChunk {
  const filesSection =
    input.changedFiles && input.changedFiles.length > 0
      ? `## Changed files\n${input.changedFiles.map(f => `- ${f}`).join('\n')}`
      : null;

  const content = joinSections([
    `# PR #${input.prNumber}: ${input.title}`,
    input.body ? `## Description\n${input.body}` : null,
    filesSection,
  ]);

  const metadata: Record<string, unknown> = {
    phase: 'implementation',
    prNumber: input.prNumber,
  };
  if (input.taskId) metadata.taskId = input.taskId;
  if (input.missionId) metadata.missionId = input.missionId;

  return {
    id: `pr:${input.prNumber}`,
    content: truncate(content),
    lexicalText: truncate(joinSections([input.title, input.body])),
    sourceType: 'pr',
    sourceUrl: input.url ?? null,
    metadata,
  };
}

// ── create_artifact → corpus `artifact` ─────────────────────────────────────

export interface ArtifactCardInput {
  artifactId: string;
  title: string;
  artifactType?: string | null;
  content?: string | null;
  url?: string | null;
  shareUrl?: string | null;
  taskId?: string | null;
  missionId?: string | null;
}

export function buildArtifactCard(input: ArtifactCardInput): UpsertChunk {
  const content = joinSections([
    `# Artifact: ${input.title}${input.artifactType ? ` (${input.artifactType})` : ''}`,
    input.content ? truncate(input.content) : null,
    input.url ? `Link: ${input.url}` : null,
  ]);

  const metadata: Record<string, unknown> = {
    phase: 'artifact',
    artifactId: input.artifactId,
  };
  if (input.artifactType) metadata.artifactType = input.artifactType;
  if (input.taskId) metadata.taskId = input.taskId;
  if (input.missionId) metadata.missionId = input.missionId;

  return {
    id: `artifact:${input.artifactId}`,
    content: truncate(content),
    lexicalText: truncate(joinSections([input.title, input.content])),
    sourceType: 'artifact',
    sourceUrl: input.shareUrl ?? input.url ?? null,
    metadata,
  };
}

// ── approve_plan → corpus `plan`, phase `plan` ──────────────────────────────

export interface PlanCardInput {
  taskId: string;
  title?: string | null;
  plan: string;
  missionId?: string | null;
  sourceUrl?: string | null;
}

/** A single step from a planning task's structured output. */
export interface PlanStepLike {
  ref?: string;
  title?: string;
  description?: string;
  dependsOn?: string[];
}

/**
 * Render a planning task's structured `plan` (array of steps) into concise
 * markdown for a plan card. Returns null when there is nothing to render.
 */
export function renderPlanText(plan: unknown): string | null {
  if (!Array.isArray(plan) || plan.length === 0) return null;
  const lines = (plan as PlanStepLike[]).map((step, i) => {
    const ref = step.ref ? `${step.ref}: ` : '';
    const title = step.title ?? `Step ${i + 1}`;
    const deps =
      step.dependsOn && step.dependsOn.length > 0
        ? ` (depends on: ${step.dependsOn.join(', ')})`
        : '';
    const desc = step.description ? `\n  ${step.description}` : '';
    return `${i + 1}. ${ref}${title}${deps}${desc}`;
  });
  return lines.join('\n');
}

export function buildPlanCard(input: PlanCardInput): UpsertChunk {
  const content = joinSections([
    input.title ? `# Plan: ${input.title}` : `# Plan for task ${input.taskId}`,
    input.plan,
  ]);

  const metadata: Record<string, unknown> = {
    phase: 'plan',
    taskId: input.taskId,
  };
  if (input.missionId) metadata.missionId = input.missionId;

  return {
    id: `plan:${input.taskId}`,
    content: truncate(content),
    lexicalText: truncate(joinSections([input.title, input.plan])),
    sourceType: 'plan',
    sourceUrl: input.sourceUrl ?? `/app/tasks/${input.taskId}`,
    metadata,
  };
}
