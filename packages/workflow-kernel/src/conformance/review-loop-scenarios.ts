/**
 * One review loop (Living Spec fa62b865 §11, revision 9): findings routed by who can fix them,
 * and a restated finding read as the same finding. Each scenario drives one delivery as a host
 * does; the in-memory runner and buildd's Postgres runner both run this list (all.ts).
 *
 *  - AC-54: a round whose only open finding is evidence files no fix and spends no round; buildd
 *    captures (`dispatch_capture`) and the delivery reads as collecting evidence.
 *  - AC-55: the #5727 sequence (screen-named criteria, design comparison asked every round, no code
 *    finding) never spends a builder round and never reaches `review_exhausted`.
 *  - AC-56: a code finding goes to the fix loop alone; the person's finding escalates once the fix
 *    is verified.
 *  - AC-57: a capture that fails turns its finding into `capability_gap` and escalates, budget unchanged.
 *  - AC-58 / AC-59 (kernel half): a restatement counts on the finding, and a round that only
 *    restates names no finding for a GitHub review.
 */
import type { CommandResult } from '../ports';
import { spentReviewRounds } from '../reducer';
import { ConformanceFailure, Delivery, eq, type ConformanceHost, type ConformanceScenario } from './scenarios';

function ok(cond: unknown, label: string): void {
  if (!cond) throw new ConformanceFailure(label);
}

function applied(r: CommandResult, to: string, label: string): void {
  const got = { result: r.result, ...('reason' in r ? { reason: r.reason } : {}), ...(r.result === 'applied' ? { to: r.decision.toState } : {}) };
  eq(got, { result: 'applied', to }, label);
}

const evidenceFinding = (screen: string, criterionId: string) => ({
  title: `compare ${screen} with its design on the real route`, remedyClass: 'evidence' as const,
  evidence: { criterionId, screen, route: '/app/tasks/x' },
});

/** The capture effect the delivery owes now, if any. */
async function owedCapture(host: ConformanceHost, s: Delivery) {
  return (await host.effects(s.deliveryId)).filter((e) => e.kind === 'dispatch_capture').at(-1) ?? null;
}

/** Buildd's capture came back for every finding of the current evidence round. */
async function captured(s: Delivery): Promise<CommandResult> {
  const view = await s.view();
  const round = view.rounds.at(-1)!;
  const ids = ((round.scope?.evidence as { findingIds: string[] } | undefined)?.findingIds) ?? [];
  return s.submit({ type: 'EvidenceRecorded', actor: 'kernel', roundId: round.id, captures: ids.map((findingId, i) => ({ findingId, artifactId: `art-${round.round}-${i}` })) });
}

export const REVIEW_LOOP_SCENARIOS: ConformanceScenario[] = [
  {
    name: '§11 AC-54: an evidence-only request for changes files no fix, spends no round and owes a capture',
    async run(host) {
      const s = await new Delivery(host, 5401).open();
      applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'owner pushed');
      applied(await s.verdictWith('request_changes', { findings: [evidenceFinding('s1', 'AC-1')] }), 'AWAITING_REVIEW', 'routed to evidence');
      const d = await s.d();
      eq(d.stateReason, 'evidence', 'the delivery is collecting evidence');
      eq(await s.count('dispatch_fix'), 0, 'no fix filed');
      eq(spentReviewRounds(await s.view()), 0, 'no round spent');
      const cap = await owedCapture(host, s);
      ok(cap, 'a capture is owed');
      eq((cap!.payload.findings as Array<{ screen: string }>).map((f) => f.screen), ['s1'], 'the capture names the screen');
      eq(cap!.payload.headSha, 'H1', 'at the round head');
      // The reviewer is not asked before the capture is in.
      eq(await s.count('dispatch_review'), 1, 'only round 1 was dispatched to a reviewer');
      const f = (await s.view()).findings![0]!;
      eq({ remedyClass: f.remedyClass, screen: f.evidence?.screen }, { remedyClass: 'evidence', screen: 's1' }, 'the finding is evidence for s1');
    },
  },
  {
    name: '§11 AC-54: the capture attaches, the evidence round goes to a reviewer, and its approval resolves the finding',
    async run(host) {
      const s = await new Delivery(host, 5402).open();
      applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'owner pushed');
      applied(await s.verdictWith('request_changes', { findings: [evidenceFinding('s1', 'AC-1')] }), 'AWAITING_REVIEW', 'routed to evidence');
      applied(await captured(s), 'AWAITING_REVIEW', 'capture recorded');
      eq((await s.d()).stateReason, null, 'no longer collecting');
      eq(await s.count('dispatch_review'), 2, 'the evidence round is dispatched to a reviewer');
      const f = (await s.view()).findings![0]!;
      ok(f.evidence?.artifactId && f.evidence.capturedAt === 'H1', `the capture is attached at H1: ${JSON.stringify(f.evidence)}`);
      applied(await s.verdict('approve'), 'APPROVED', 'the reviewer approves with the capture');
      eq((await s.view()).findings![0]!.status, 'resolved', 'the evidence finding is resolved');
      eq(spentReviewRounds(await s.view()), 0, 'neither the evidence-only round nor the evidence round counted');
    },
  },
  {
    name: '§11 AC-55: the #5727 sequence spends no builder round and never reaches review_exhausted',
    async run(host) {
      const s = await new Delivery(host, 5727).open({ maxRounds: 3 });
      applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'owner pushed');
      // Round 1: the reviewer finds the build sound but asks for design comparisons on the real route.
      const asks = [evidenceFinding('desk-a', 'AC-28'), evidenceFinding('desk-b', 'AC-29'), evidenceFinding('phone-a', 'AC-30')];
      applied(await s.verdictWith('request_changes', { findings: asks }), 'AWAITING_REVIEW', 'round 1 routed to evidence');
      applied(await captured(s), 'AWAITING_REVIEW', 'buildd captured all three');
      // The evidence round restates one comparison as still missing at this head: a person decides, nothing exhausts.
      const view = await s.view();
      const again = view.findings!.find((f) => f.evidence?.screen === 'desk-b')!;
      applied(await s.verdictWith('request_changes', { findings: [{ id: again.id, ...evidenceFinding('desk-b', 'AC-29') }], resolvedFindings: view.findings!.filter((f) => f.id !== again.id).map((f) => f.id) }), 'ESCALATED', 'still missing after capture: a person decides');
      const d = await s.d();
      eq(d.stateReason, 'review_escalated', 'escalated to a person, not exhausted');
      eq(await s.count('dispatch_fix'), 0, 'no builder fix was ever filed');
      eq(spentReviewRounds(await s.view()), 0, 'no review round was spent');
      eq((await host.transitions(s.deliveryId)).some((t) => t.toState === 'ESCALATED' && t.command === 'ReviewBudgetExhausted'), false, 'never review_exhausted');
    },
  },
  {
    name: '§11 AC-56: a code and a person finding: the fix lists only the code, then the person decides',
    async run(host) {
      const s = await new Delivery(host, 5403).open();
      applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'owner pushed');
      applied(await s.verdictWith('request_changes', {
        findings: [{ path: 'src/a.ts', line: 4, title: 'off by one' }, { title: 'which plan tier gets this?', remedyClass: 'person_decision' }],
      }), 'CHANGES_REQUESTED', 'the code finding goes to the fix loop');
      eq(await s.count('dispatch_fix'), 1, 'one fix');
      const fix = await s.startFix();
      applied(await s.fixEnded(fix, { localHeadSha: 'H2', commitCount: 1, live: s.live('H2'), proof: { liveContainsLocal: true } }), 'AWAITING_REVIEW', 'fix pushed');
      applied(await s.verdict('approve'), 'ESCALATED', 'the code is verified; the person finding remains');
      const d = await s.d();
      eq(d.stateReason, 'review_escalated', 'a person decides');
      const open = (await s.view()).findings!.filter((f) => f.status === 'open').map((f) => f.remedyClass);
      eq(open, ['person_decision'], 'only the person finding is open');
    },
  },
  {
    name: '§11 AC-57: a failed capture turns its finding into capability_gap and escalates, budget unchanged',
    async run(host) {
      const s = await new Delivery(host, 5404).open();
      applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'owner pushed');
      applied(await s.verdictWith('request_changes', { findings: [evidenceFinding('s1', 'AC-1')] }), 'AWAITING_REVIEW', 'routed to evidence');
      const round = (await s.view()).rounds.at(-1)!;
      applied(await s.submit({ type: 'EvidenceRecorded', actor: 'kernel', roundId: round.id, failure: 'Visual QA is not set up for this workspace' }), 'ESCALATED', 'capture failed');
      eq((await s.d()).stateReason, 'review_escalated', 'a person decides');
      const f = (await s.view()).findings![0]!;
      eq({ remedyClass: f.remedyClass, failure: f.evidence?.failure }, { remedyClass: 'capability_gap', failure: 'Visual QA is not set up for this workspace' }, 'the missing capability is named');
      eq(spentReviewRounds(await s.view()), 0, 'no round spent');
    },
  },
  {
    name: '§11 AC-58/AC-59: a restatement counts on the finding and names nothing new for a GitHub review',
    async run(host) {
      const s = await new Delivery(host, 5405).open({ maxRounds: 3 });
      applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'owner pushed');
      applied(await s.verdictWith('request_changes', { findings: [{ path: 'src/a.ts', title: 'off by one' }] }), 'CHANGES_REQUESTED', 'round 1');
      const reviews = async () => (await host.effects(s.deliveryId)).filter((e) => e.kind === 'post_review').map((e) => e.payload.findingIds);
      const id = await s.findingId('src/a.ts');
      eq(await reviews(), [[id]], 'round 1 names its new finding');
      const fix = await s.startFix();
      applied(await s.fixEnded(fix, { localHeadSha: 'H2', commitCount: 1, live: s.live('H2'), proof: { liveContainsLocal: true } }), 'AWAITING_REVIEW', 'fix pushed');
      applied(await s.verdictWith('request_changes', { findings: [{ id, path: 'src/a.ts', title: 'off by one' }] }), 'CHANGES_REQUESTED', 'round 2 restates it unchanged');
      const f = (await s.view()).findings!.find((x) => x.id === id)!;
      eq({ restatedCount: f.restatedCount, title: f.title, n: (await s.view()).findings!.length }, { restatedCount: 1, title: 'off by one', n: 1 }, 'one finding, restated once');
      eq((await reviews()).at(-1), [], 'round 2 names nothing new');
    },
  },
];
