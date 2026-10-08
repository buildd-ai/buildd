/**
 * bun run chat-retro:visible-fixture  (from apps/web)
 *
 * End-to-end check of the visible-answer failure shapes, no DB and no model:
 *
 * 1. Drives the browser tracker (components/chat/turn-signal-tracker.ts) through
 *    a foreground turn that never paints its answer, and the same turn sent to
 *    the background; pushes each record through the route's parser and merge
 *    (twice, as a reconnect would).
 * 2. Runs every controlled shape (lib/chat-retro/visible-answer-fixtures.ts),
 *    plus the two from step 1, through the real retro pass, once as a dogfood
 *    team and once as an ordinary opted-in team, with proposals on.
 * 3. Prints what each produced and exits 1 if anything differs from what the
 *    shape declares, a signature drifts, or the planted question text shows up
 *    in any lesson, proposal or signal.
 */
import { mergeTurnSignal, parseTurnSignalPost, type TurnSignal } from '../src/lib/chat/turn-signal';
import { TurnSignalTracker, type ProbeResult } from '../src/components/chat/turn-signal-tracker';
import { runChatRetroPass, type PassDeps } from '../src/lib/chat-retro/run';
import type { LessonRow } from '../src/lib/chat-retro/lesson';
import { retroSignature } from '../src/lib/chat-retro/lesson';
import type { Cluster } from '../src/lib/chat-retro/proposals';
import { classifyVisibleAnswers } from '../src/lib/chat-retro/visible-answer';
import { clusterLessonsInMemory, FIXTURE_SECRET, visibleAnswerFixtures, type VisibleFixture } from '../src/lib/chat-retro/visible-answer-fixtures';
import type { RetroMessage } from '../src/lib/chat-retro/skeleton';

const failures: string[] = [];
const check = (ok: boolean, what: string) => { if (!ok) failures.push(what); };
const U = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

// ── 1. browser tracker → route parser → merge ─────────────────────────────────
function trackedSignal(goBackground: boolean): TurnSignal {
  let t = Date.UTC(2026, 9, 1, 9);
  const sent: TurnSignal[] = [];
  const tr = new TurnSignalTracker({
    now: () => t, probe: (): ProbeResult => 'not_visible', docHidden: () => false, online: () => true,
    post: (ref, signal) => { sent.push(signal); void ref; },
  });
  tr.submit('client-msg-1');
  t += 800; tr.streaming();
  t += 1500; tr.content(U(7001));
  if (goBackground) tr.flag('hidden');
  tr.check();
  t += 3000; tr.end('ready');
  tr.finalize();
  let stored: TurnSignal = { ref: 'client-msg-1' };
  for (let i = 0; i < 2; i++) {
    const p = parseTurnSignalPost({ ref: 'client-msg-1', signal: sent[0] });
    if (!p.ok) { failures.push(`tracker post refused: ${p.error}`); break; }
    stored = mergeTurnSignal(stored, p.signal);
  }
  return stored;
}

function trackedFixture(name: string, signal: TurnSignal, expect: VisibleFixture['expect']): VisibleFixture {
  const at = Date.UTC(2026, 9, 1, 9);
  const messages: RetroMessage[] = [
    { id: U(7000), role: 'user', parts: [{ type: 'text', text: `first question ${FIXTURE_SECRET}` }], tier: null, createdAt: new Date(at), usage: { inputTokens: 300, outputTokens: 4, turn: signal } },
    { id: U(7001), role: 'assistant', parts: [{ type: 'text', text: 'An answer that was saved.' }], tier: 'standard', createdAt: new Date(at + 6000), usage: { inputTokens: 4000, outputTokens: 200 } },
  ];
  return { name, expect, input: { messages, thumbsDown: new Map(), deniedApprovalMessageIds: new Set() } };
}

const foreground = trackedSignal(false);
const background = trackedSignal(true);
check(JSON.stringify(foreground).indexOf(FIXTURE_SECRET) < 0, 'signal carries text');

const fixtures = [
  ...visibleAnswerFixtures(),
  trackedFixture('tracked_foreground_never_painted', foreground, ['render_gap']),
  trackedFixture('tracked_backgrounded', background, []),
];

console.log('Shapes (classifier):');
for (const f of fixtures) {
  const got = classifyVisibleAnswers(f.input.messages).map(x => `${x.kind}@${x.conf}`);
  const ok = JSON.stringify(got.map(g => g.split('@')[0])) === JSON.stringify(f.expect);
  check(ok, `${f.name}: expected [${f.expect}] got [${got}]`);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${f.name.padEnd(36)} ${got.join(', ') || '(nothing)'}`);
}

// ── 2. the pass, dogfood vs ordinary ──────────────────────────────────────────
async function pass(dogfood: boolean, only: string[]) {
  const lessons: LessonRow[] = [];
  const filed: Cluster[] = [];
  const shapes = only.map(n => fixtures.find(f => f.name === n)!);
  const deps: PassDeps = {
    env: {},
    now: () => new Date('2026-10-02T14:00:00Z'),
    deadlineAt: Date.now() + 60_000,
    listOptedInTeams: async () => [{ teamId: U(1), settings: { lessons: true, proposals: true }, dogfood }],
    listPendingConversations: async () => shapes.map((_, i) => ({ id: U(500 + i), workspaceId: U(2), dataClass: null })),
    loadWindow: async (_t, conv) => shapes[Number(conv.slice(-3)) - 500].input,
    judgedToday: async () => 0,
    decide: async () => ({
      ok: true, model: 'fixture',
      answers: { satisfied: { type: 'choice', choice: 'no', confidence: 0.95, probabilities: {} }, intent: { type: 'choice', choice: 'status_check', confidence: 0.9, probabilities: {} } } as never,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, latencyMs: 1, attempts: 1,
    }),
    insertLessons: async rows => { lessons.push(...rows); },
    receipts: async () => {},
    loadClusters: async () => clusterLessonsInMemory(lessons),
    proposalsFiledToday: async () => 0,
    priorFiling: async () => null,
    insertProposalTask: async ({ cluster, title, description }) => {
      check(!`${title}${description}`.includes(FIXTURE_SECRET), 'proposal carries text');
      filed.push(cluster);
      return 'fixture-task';
    },
    appendToProposal: async () => {},
    gate: () => {},
    pruneExpiredLessons: async () => 0,
    lessonsUrl: 'https://example.test/lessons',
  };
  await runChatRetroPass(deps);
  check(!JSON.stringify(lessons).includes(FIXTURE_SECRET), 'lesson carries text');
  return { lessons, filed };
}

const NO_ANSWER = retroSignature('no_answer', 'turn_pipeline', null);
const RENDER_GAP = retroSignature('render_gap', 'ui', null);
check(NO_ANSWER === 'chat-retro:no_answer-turn_pipeline-none-e2ac0e', `no_answer signature drifted: ${NO_ANSWER}`);
check(RENDER_GAP === 'chat-retro:render_gap-ui-none-845fd4', `render_gap signature drifted: ${RENDER_GAP}`);

const shapes = ['backend_empty_first_question', 'tracked_foreground_never_painted', 'tracked_backgrounded', 'render_gap_suppressed_pagehide', 'rendered_ok'];
const dog = await pass(true, shapes);
const plain = await pass(false, shapes);

console.log('\nLessons (dogfood team):');
for (const [i, l] of dog.lessons.entries()) console.log(`  ${shapes[i].padEnd(36)} ${l.status.padEnd(8)} ${l.signature ?? '-'}`);
check(dog.lessons.map(l => l.signature).join() === [NO_ANSWER, RENDER_GAP, null, null, null].join(), 'lesson signatures differ from the shapes');

console.log(`\nProposals filed: dogfood team ${dog.filed.length} [${dog.filed.map(c => c.signature).join(', ')}], ordinary team ${plain.filed.length}`);
check(dog.filed.length === 2, 'dogfood should file both high-confidence failures on first occurrence');
check(plain.filed.length === 0, 'an ordinary team should file nothing on a first occurrence');

if (failures.length) {
  console.error(`\nFAILED:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('\nAll visible-answer shapes behaved as declared; no text in any signal, lesson or proposal.');
