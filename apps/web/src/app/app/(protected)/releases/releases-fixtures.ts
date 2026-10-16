/**
 * `?state=` fixtures for `/app/releases`, so the visual audit can capture the
 * list with candidate rows (a pending candidate as the Next release card, and
 * a history of healthy, degraded, failed and superseded releases). The CI QA
 * clone has no release-enabled workspace, so it only reaches the empty state
 * (docs/specs/qa-capture-steps.md).
 *
 * Dev-server only: Visual QA runs `bun dev`, production ignores the param.
 */
import type { ReleasesListData } from './ReleasesList';

export const RELEASES_FIXTURE_STATES = ['candidates', 'history', 'multi-workspace'] as const;
export type ReleasesFixtureState = (typeof RELEASES_FIXTURE_STATES)[number];

export function resolveReleasesFixtureState(
  raw: string | string[] | undefined,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): ReleasesFixtureState | null {
  if (nodeEnv !== 'development') return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && (RELEASES_FIXTURE_STATES as readonly string[]).includes(value) ? (value as ReleasesFixtureState) : null;
}

const WS = 'qa-fixture-workspace';
const WS2 = 'qa-fixture-workspace-2';
const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000);
const sha = (n: number) => `${n.toString(16).padStart(4, '0')}a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8`;

type Row = ReleasesListData['releases'][number];

function row(i: number, state: Row['state'], version: string, minutesAgo: number, over: Partial<Row> = {}): Row {
  return {
    id: `qa-fixture-release-${i}`,
    workspaceId: WS,
    state,
    version,
    dispatchedAt: ago(minutesAgo),
    deployedAt: state === 'healthy' || state === 'degraded' ? ago(minutesAgo - 6) : null,
    commitsAheadAtDispatch: 4 + (i % 5) * 3,
    previousSha: sha(i + 1),
    headSha: sha(i),
    failureReason: null,
    ...over,
  };
}

const PENDING_CANDIDATE = row(0, 'pending_external', 'v1.42.0', 12);
const HISTORY: Row[] = [
  row(1, 'healthy', 'v1.41.0', 60 * 26),
  row(2, 'degraded', 'v1.40.1', 60 * 50),
  row(3, 'failed', 'v1.40.0', 60 * 52, { failureReason: 'candidate integration failed on 3f9c2a71b' }),
  row(4, 'failed', 'v1.39.1', 60 * 75, { failureReason: 'superseded by release qa-fixture-release-1' }),
  row(5, 'healthy', 'v1.39.0', 60 * 98),
];

export function releasesFixture(state: ReleasesFixtureState): ReleasesListData {
  const releases = state === 'history' ? HISTORY : [PENDING_CANDIDATE, ...HISTORY];
  const all =
    state === 'multi-workspace'
      ? [...releases, row(10, 'pending_external', 'v0.9.0', 30, { workspaceId: WS2 }), row(11, 'healthy', 'v0.8.2', 60 * 30, { workspaceId: WS2 })]
          .sort((a, b) => new Date(b.dispatchedAt!).getTime() - new Date(a.dispatchedAt!).getTime())
      : releases;
  const gitConfig = { fullName: 'example/app' };
  return {
    releases: all,
    total: all.length,
    workspaces: new Map([
      [WS, { name: 'Sample workspace', gitConfig }],
      [WS2, { name: 'Sample mobile app', gitConfig }],
    ]),
    metrics: new Map(all.map((r, i) => [r.id, { taskCount: 3 + i * 2, missionCount: 1 + (i % 3) }])),
    supersededVersions: new Map([['qa-fixture-release-1', 'v1.41.0']]),
    composeWorkspaceId: WS,
  };
}
