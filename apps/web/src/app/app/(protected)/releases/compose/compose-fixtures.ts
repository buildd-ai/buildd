/**
 * `?state=` fixtures for `/app/releases/compose`, so the visual audit can reach
 * the flow's CTAs and error states that the CI QA clone can't produce: it has
 * no workspace with frozen release candidates turned on, and no GitHub App
 * (docs/specs/qa-capture-steps.md).
 *
 * Static views only: ReleaseFlow never POSTs while a fixture is shown.
 * Dev-server only: Visual QA runs `bun dev`, production ignores the param.
 */
import {
  candidateVerdict,
  defaultSelection,
  missionKey,
  prKey,
  REQUIRED_CANDIDATE_CHECKS,
  releaseLede,
  type CandidateCheck,
  type ComposeMission,
  type ComposePr,
  type Composition,
} from '@buildd/core/release-compose';
import type { NoticeTone } from '@/components/ui/Notice';
import type { CandidateState, FlowRecordEntry, ReleaseFlowView } from '@/lib/release/compose-source';

export const COMPOSE_FIXTURE_STATES = [
  'compose',
  'compose-empty',
  'confirm',
  'reply-error',
  'review-failing',
  'review-exclude',
  'review-refused',
  'review-ready',
  'release',
  'error',
] as const;
export type ComposeFixtureState = (typeof COMPOSE_FIXTURE_STATES)[number];

export function resolveComposeFixtureState(
  raw: string | string[] | undefined,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): ComposeFixtureState | null {
  if (nodeEnv !== 'development') return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && (COMPOSE_FIXTURE_STATES as readonly string[]).includes(value) ? (value as ComposeFixtureState) : null;
}

/** What ReleaseFlow shows on first paint that would otherwise need a server reply. */
export interface ReleaseFlowFixture {
  confirming?: { text: string; action: string };
  reply?: { tone: NoticeTone; text: string };
}

export type ComposeFixture =
  | { kind: 'flow'; view: ReleaseFlowView; flowFixture: ReleaseFlowFixture }
  | { kind: 'error'; message: string };

const REPO = 'example/app';
const SOURCE_SHA = '3f9c2a71be04d5a6c8e1f2b3a4c5d6e7f8091a2b';
const CANDIDATE_SHA = '8b1e44d09c2f7a3e5d6c1b0a9f8e7d6c5b4a3f21';
const PREVIOUS_CANDIDATE_SHA = 'c47a0e9d2b1f3c5a6e8d0b2a4c6e8f0a1b3c5d7e';
const MERGE_SHA = 'e2d5b8a1c4f7e0d3b6a9c2f5e8d1b4a7c0f3e6d9';
const VERSION = '1.42.0';
const AT = '2026-10-12T09:30:00.000Z';

const pr = (number: number, title: string, missionId: string | null): ComposePr => ({
  number,
  title,
  url: `https://github.com/${REPO}/pull/${number}`,
  mergeSha: `${String(number).padStart(4, '0')}a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8`,
  missionId,
});

const mission = (id: string, title: string, met: number, total: number, missionPr: ComposeMission['missionPr'] = null): ComposeMission => ({
  id: `qa-fixture-mission-${id}`,
  title,
  criteria: { met, total },
  missionPr,
});

const missionPr = (number: number, title: string, approved: boolean, checks: 'passing' | 'failing' | 'pending') => ({
  number,
  title,
  url: `https://github.com/${REPO}/pull/${number}`,
  state: 'open' as const,
  approved,
  checks,
});

const billing = mission('billing', 'Usage-based billing', 5, 5, { ...missionPr(812, 'Mission: usage-based billing', true, 'passing'), state: 'merged' });
const search = mission('search', 'Search across workspaces', 4, 4, { ...missionPr(820, 'Mission: workspace search', true, 'passing'), state: 'merged' });
const exports = mission('exports', 'CSV exports for reports', 3, 3, missionPr(831, 'Mission: CSV exports', true, 'passing'));
const audit = mission('audit', 'Audit log retention', 2, 4, missionPr(835, 'Mission: audit retention', false, 'failing'));
const sso = mission('sso', 'SAML single sign-on', 1, 6, missionPr(838, 'Mission: SAML SSO', false, 'pending'));

const billingPrs = [pr(806, 'Meter API calls per workspace', billing.id), pr(809, 'Invoice line items for metered usage', billing.id)];
const searchPrs = [pr(814, 'Index workspace names and task titles', search.id)];
const otherPrs = [pr(817, 'Bump Next.js to 16.2', null), pr(822, 'Fix flaky timezone test in reports', null)];

const FULL: Composition = {
  onDev: [
    { key: missionKey(billing.id), kind: 'on_dev', mission: billing, prs: billingPrs },
    { key: missionKey(search.id), kind: 'on_dev', mission: search, prs: searchPrs },
  ],
  ready: [{ key: missionKey(exports.id), kind: 'ready', mission: exports, prs: [pr(831, 'Mission: CSV exports', exports.id)] }],
  notReady: [
    { key: missionKey(audit.id), kind: 'ready', mission: audit, prs: [pr(835, 'Mission: audit retention', audit.id)] },
    { key: missionKey(sso.id), kind: 'ready', mission: sso, prs: [pr(838, 'Mission: SAML SSO', sso.id)] },
  ],
  other: otherPrs.map((p) => ({ key: prKey(p.number), pr: p })),
};

/** The candidate froze what was on dev: no ready or not-ready rows. */
const FROZEN: Composition = { onDev: FULL.onDev, ready: [], notReady: [], other: FULL.other };

const EMPTY: Composition = { onDev: [], ready: [], notReady: [], other: [] };

const record = (id: string, step: string, outcome: string, detail: Record<string, unknown> | null, minutesAgo: number, version: string | null = null): FlowRecordEntry => ({
  id: `qa-fixture-record-${id}`,
  step,
  outcome,
  actor: 'Sample Owner',
  at: new Date(Date.parse(AT) - minutesAgo * 60_000).toISOString(),
  version,
  candidateSha: version ? CANDIDATE_SHA : null,
  prNumber: null,
  detail,
});

const CUT_RECORD = record('cut', 'cut', 'succeeded', { sourceSha: SOURCE_SHA }, 40, VERSION);
const AMEND_RECORD = record('exclude', 'exclude', 'succeeded', { leftOut: [{ label: 'Bump Next.js to 16.2 (#817)' }] }, 25, VERSION);

const check = (name: string, state: CandidateCheck['state'], sha = CANDIDATE_SHA): CandidateCheck => ({
  name,
  sha,
  state,
  url: `https://github.com/${REPO}/actions/runs/1`,
});

function candidate(checks: CandidateCheck[], approvals: number, opts: Partial<CandidateState> = {}): CandidateState {
  const reviews = [
    ...Array.from({ length: approvals }, (_, i) => ({ author: `reviewer-${i}`, state: 'APPROVED' as const, sha: CANDIDATE_SHA })),
    { author: 'earlier-reviewer', state: 'APPROVED' as const, sha: PREVIOUS_CANDIDATE_SHA },
  ];
  return {
    prNumber: 840,
    url: `https://github.com/${REPO}/pull/840`,
    version: VERSION,
    candidateSha: CANDIDATE_SHA,
    sourceSha: SOURCE_SHA,
    amendment: 1,
    previousCandidateSha: PREVIOUS_CANDIDATE_SHA,
    reverted: [],
    verdict: candidateVerdict({ candidateSha: CANDIDATE_SHA, required: REQUIRED_CANDIDATE_CHECKS, checks, reviews }),
    refusal: null,
    deltaUrl: `https://github.com/${REPO}/compare/${PREVIOUS_CANDIDATE_SHA}...${CANDIDATE_SHA}`,
    ...opts,
  };
}

const [BUILD, VERIFIED, DRIFT] = REQUIRED_CANDIDATE_CHECKS;
const FAILING_CHECKS = [check(BUILD, 'failing'), check(VERIFIED, 'pending'), check('lint', 'passing')]; // DRIFT: not run on this SHA
const PASSING_CHECKS = [check(BUILD, 'passing'), check(VERIFIED, 'passing'), check(DRIFT, 'passing'), check('lint', 'passing')];

function view(over: Partial<ReleaseFlowView> & Pick<ReleaseFlowView, 'composition' | 'step'>): ReleaseFlowView {
  const c = over.composition;
  const cand = over.candidate ?? null;
  const counts = { missions: c.onDev.length, other: c.other.length };
  return {
    workspace: { id: 'qa-fixture-workspace', name: 'Sample workspace', repoFullName: REPO },
    sourceBranch: 'dev',
    prodBranch: 'main',
    compositionSha: SOURCE_SHA,
    defaultSelected: [...defaultSelection(c)],
    leftOut: [],
    candidate: null,
    merged: null,
    counts,
    lede: releaseLede({ version: cand?.version ?? null, step: over.step, ...counts, verdict: cand?.verdict ?? null }),
    record: [],
    truncated: false,
    ...over,
  };
}

export function composeFixture(state: ComposeFixtureState): ComposeFixture {
  const flow = (v: ReleaseFlowView, flowFixture: ReleaseFlowFixture = {}): ComposeFixture => ({ kind: 'flow', view: v, flowFixture });
  switch (state) {
    case 'compose':
      return flow(view({ composition: FULL, step: 'compose' }));
    case 'compose-empty':
      return flow(view({ composition: EMPTY, step: 'compose' }));
    case 'confirm':
      return flow(view({ composition: FULL, step: 'compose' }), {
        confirming: {
          text: 'Cut v1.42.0 from dev at 3f9c2a71b with 2 missions and 2 other changes? The candidate branch is frozen at that SHA; only an amendment changes it.',
          action: 'Cut the candidate',
        },
      });
    case 'reply-error':
      return flow(view({ composition: FULL, step: 'compose' }), {
        reply: { tone: 'err', text: 'dev moved since this page loaded (now at 5c0d1e2f3). Nothing was cut; the list below is current.' },
      });
    case 'review-failing': {
      const cand = candidate(FAILING_CHECKS, 0);
      const selected = [...defaultSelection(FROZEN)].filter((k) => k !== prKey(817));
      return flow(view({ composition: FROZEN, step: 'review', candidate: cand, leftOut: [prKey(817)], defaultSelected: selected, record: [AMEND_RECORD, CUT_RECORD] }));
    }
    case 'review-exclude': {
      const cand = candidate(PASSING_CHECKS, 1);
      const selected = [...defaultSelection(FROZEN)].filter((k) => k !== missionKey(search.id));
      return flow(view({ composition: FROZEN, step: 'review', candidate: cand, defaultSelected: selected, record: [CUT_RECORD] }));
    }
    case 'review-refused': {
      const cand = candidate(PASSING_CHECKS, 0, {
        refusal: { sha: searchPrs[0].mergeSha!, files: ['apps/web/src/lib/search.ts', 'packages/core/db/schema.ts'], candidateSha: CANDIDATE_SHA, at: AT },
      });
      return flow(view({ composition: FROZEN, step: 'review', candidate: cand, record: [record('refused', 'exclude', 'failed', { leftOut: [{ label: 'Search across workspaces' }], error: 'the revert conflicts' }, 5, VERSION), CUT_RECORD] }));
    }
    case 'review-ready': {
      // Amended once to leave out #817; that row reads as left out and is locked.
      const cand = candidate(PASSING_CHECKS, 1);
      const selected = [...defaultSelection(FROZEN)].filter((k) => k !== prKey(817));
      return flow(view({ composition: FROZEN, step: 'review', candidate: cand, leftOut: [prKey(817)], defaultSelected: selected, record: [AMEND_RECORD, CUT_RECORD] }));
    }
    case 'release':
      return flow(
        view({
          composition: FROZEN,
          step: 'release',
          merged: { prNumber: 840, url: `https://github.com/${REPO}/pull/840`, version: VERSION, mergeSha: MERGE_SHA, mergedAt: AT, deployedSha: SOURCE_SHA, production: 'awaiting_production', confirmed: false },
          record: [record('release', 'release', 'succeeded', null, 3, VERSION), CUT_RECORD],
        }),
      );
    case 'error':
      return { kind: 'error', message: 'Could not read the release from GitHub: GitHub returned 502 for /repos/example/app/compare/main...3f9c2a71b' };
  }
}
