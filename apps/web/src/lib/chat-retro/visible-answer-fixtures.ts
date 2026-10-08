/**
 * Controlled shapes of the visible-answer failures, for tests and for the
 * end-to-end check `bun run chat-retro:visible-fixture`
 * (scripts/chat-retro-visible-fixture.ts), which runs every shape through the
 * real retro pass and proposal planning with no DB and no model.
 *
 * Each shape is one conversation window as the store would load it: stored
 * messages, with the client's turn signal on the user message exactly as the
 * turn-signal route merges it. The question text is a marker the tests look
 * for in every output, to prove it never leaves the skeleton.
 */
import type { TurnSignal } from '@/lib/chat/turn-signal';
import type { RetroMessage, RetroWindowInput } from './skeleton';
import type { VisibleCandidateKind } from './vocab';
import type { LessonRow } from './lesson';
import { HIGH_CONFIDENCE_EVIDENCE, type Cluster } from './proposals';
import { FIRST_OCCURRENCE_KINDS } from './visible-answer';

/** Planted in every fixture question: must never appear in a lesson, evidence, proposal or signal. */
export const FIXTURE_SECRET = 'zebra-quartz-pineapple';

export interface VisibleFixture {
  name: string;
  /** What the classifier must find, by kind (empty: nothing). */
  expect: VisibleCandidateKind[];
  input: RetroWindowInput;
}

const BASE = Date.UTC(2026, 9, 1, 9, 0, 0);
let seq = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

function user(atSec: number, text: string, turn?: TurnSignal): RetroMessage {
  return {
    id: nextId(), role: 'user', parts: [{ type: 'text', text }], tier: null,
    createdAt: new Date(BASE + atSec * 1000),
    usage: { inputTokens: 300, outputTokens: 4, costUsd: 0.0001, ...(turn ? { turn } : {}) },
  };
}

function assistant(atSec: number, text: string | null, id = nextId()): RetroMessage {
  return {
    id, role: 'assistant',
    parts: text === null ? [{ type: 'step-start' }] : [{ type: 'text', text }],
    tier: 'standard', createdAt: new Date(BASE + atSec * 1000),
    usage: { inputTokens: 4000, outputTokens: 250, costUsd: 0.01 },
  };
}

const win = (messages: RetroMessage[]): RetroWindowInput => ({ messages, thumbsDown: new Map(), deniedApprovalMessageIds: new Set() });

/** A foreground client that stayed to the end of the turn and saw content, but never confirmed it on screen. */
function foregroundNoRender(ref: string, assistantId: string, extra: TurnSignal = {}): TurnSignal {
  return { ref, at: BASE, startMs: 900, contentMs: 2400, endMs: 6100, outcome: 'ready', assistantId, ...extra };
}

/** Every shape, fresh ids each call. */
export function visibleAnswerFixtures(): VisibleFixture[] {
  const q = `What is stuck right now? ${FIXTURE_SECRET}`;
  const out: VisibleFixture[] = [];

  // Backend empty: the first question's turn ended with nothing saved.
  out.push({ name: 'backend_empty_first_question', expect: ['no_output'], input: win([user(0, q, { ref: 'c1', at: BASE, startMs: 800, endMs: 9000, outcome: 'error' })]) });

  // Backend empty: an assistant row with tool rows only and no answer text.
  {
    const a = assistant(8, null);
    out.push({ name: 'backend_empty_tools_only', expect: ['no_output'], input: win([user(0, q), a]) });
  }

  // Render gap: saved answer, foreground client to the end, never on screen.
  {
    const aId = nextId();
    out.push({ name: 'render_gap_foreground', expect: ['render_gap'], input: win([user(0, q, foregroundNoRender('c2', aId)), assistant(7, 'Two tasks are waiting on review.', aId)]) });
  }

  // Same shape, but the page went to the background / away: suppressed.
  for (const flag of ['hidden', 'pagehide', 'offline', 'left', 'stopped', 'paneHidden'] as const) {
    const aId = nextId();
    out.push({ name: `render_gap_suppressed_${flag}`, expect: [], input: win([user(0, q, foregroundNoRender('c3', aId, { [flag]: true })), assistant(7, 'Two tasks are waiting on review.', aId)]) });
  }

  // No end record (the page died mid-turn): unknown, not a gap.
  {
    const aId = nextId();
    const s = foregroundNoRender('c4', aId);
    delete s.endMs;
    out.push({ name: 'render_gap_no_end_record', expect: [], input: win([user(0, q, s), assistant(7, 'Answer.', aId)]) });
  }

  // Rendered: healthy turn.
  {
    const aId = nextId();
    out.push({ name: 'rendered_ok', expect: [], input: win([user(0, q, foregroundNoRender('c5', aId, { renderMs: 2600 })), assistant(7, 'Answer.', aId)]) });
  }

  // Blank then a rapid re-ask: no_output, then blank_retry on the second question.
  out.push({
    name: 'blank_then_retry',
    expect: ['no_output', 'blank_retry'],
    input: win([user(0, q), user(60, q, { ref: 'c6', at: BASE + 60_000, endMs: 5000, renderMs: 3000 }), assistant(66, 'Answer.')]),
  });

  return out;
}

/**
 * The store's cluster query (store.ts loadClusters), in memory, for the
 * no-DB end-to-end path: group signed lessons by signature and count the
 * high-confidence visible evidence the same way the SQL does.
 */
export function clusterLessonsInMemory(rows: LessonRow[]): Cluster[] {
  const by = new Map<string, LessonRow[]>();
  for (const r of rows) if (r.signature) by.set(r.signature, [...(by.get(r.signature) ?? []), r]);
  return [...by.entries()].map(([signature, rs]) => ({
    signature,
    primaryCause: rs[0].primaryCause!,
    fixClass: rs[0].fixClass!,
    toolName: rs[0].toolName,
    sessions: rs.length,
    days: new Set(rs.map(r => r.toMessageAt.toISOString().slice(0, 10))).size,
    wastedTokens: rs.reduce((s, r) => s + r.wastedTokens, 0),
    satisfiedYes: rs.filter(r => r.satisfied === 'yes').length,
    satisfiedPartly: rs.filter(r => r.satisfied === 'partly').length,
    satisfiedNo: rs.filter(r => r.satisfied === 'no').length,
    highConfidence: rs.filter(r => r.evidence.some(e => (FIRST_OCCURRENCE_KINDS as readonly string[]).includes(e.kind) && (e.conf ?? 0) >= HIGH_CONFIDENCE_EVIDENCE)).length,
    workspaceId: rs[0].workspaceId,
    lessonIds: rs.map((_, i) => `00000000-0000-4000-8000-${String(900 + i).padStart(12, '0')}`),
    conversationIds: [...new Set(rs.map(r => r.conversationId))],
  }));
}
