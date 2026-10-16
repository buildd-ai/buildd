/**
 * Fake data for the runner consent fixture (/app/dev/runner-consent). The page
 * is the real one: the same renderer GET /api/auth/cli, /api/auth/device/consent
 * and /api/auth/runner-picks use, fed placeholder teams through the same
 * filters the routes apply (runnerPickerTeams, the edit's removed-pick filter,
 * initialRunnerState). Nothing here touches the database, a session or the
 * signing secret, and the form posts to a path that does not exist.
 */
import type { ConsentTeam, ConsentWorkspace } from '@/lib/oauth/account-consent';
import { initialRunnerState, renderRunnerConsentHtml, type RunnerConsentFlow } from '@/lib/runner-consent';
import { runnerPickerTeams } from '@/lib/runner-picks-plan';

export const FIXTURE_ACTION = '/app/dev/runner-consent/not-a-real-endpoint';
const FIXTURE_TOKEN = 'fixture';

export const RUNNER_CONSENT_FIXTURE_STATES = ['cli', 'single', 'device', 'edit', 'error'] as const;
export type RunnerConsentFixtureState = (typeof RUNNER_CONSENT_FIXTURE_STATES)[number];

function ws(id: string, name: string, repo: string | null, accessMode = 'open'): ConsentWorkspace {
  return { id, name, repo, accessMode };
}

/**
 * Three teams. The person administers Northwind, so its restricted workspace
 * is offered; they are a plain member of Harbor, so Harbor's restricted one is
 * not. Teams also have an internal coordination workspace the picker hides.
 */
export const FIXTURE_TEAMS: ConsentTeam[] = [
  {
    id: 'team-northwind', name: 'Northwind Studio', role: 'admin', workspaces: [
      { id: 'nw-coord', name: '__coordination', repo: null, system: true },
      ws('nw-api', 'api', 'northwind/api'),
      ws('nw-billing', 'billing', 'northwind/billing', 'restricted'),
      ws('nw-long', 'customer-onboarding-experience-redesign-and-migration', 'northwind/customer-onboarding-experience-redesign-and-migration'),
      ws('nw-web', 'web', 'northwind/web'),
    ],
  },
  {
    id: 'team-harbor', name: 'Harbor Labs', role: 'member', workspaces: [
      { id: 'hb-coord', name: '__coordination', repo: null, system: true },
      ws('hb-docs', 'docs', null),
      ws('hb-infra', 'infra', 'harbor/infra', 'restricted'),
      ws('hb-mobile', 'mobile', 'harbor/mobile'),
    ],
  },
  {
    id: 'team-solo', name: 'Side projects', role: 'owner', workspaces: [
      ws('solo-notes', 'notes', 'jo/notes'),
    ],
  },
];

/** One team with one workspace: the page ticks it for them. */
export const SINGLE_TEAM: ConsentTeam[] = [
  { id: 'team-solo', name: 'Side projects', role: 'owner', workspaces: [ws('solo-notes', 'notes', 'jo/notes')] },
];

/**
 * The key being edited. Its picks include one a team admin removed (not
 * offered again, named in the lede) and one on a team the person has since
 * left (no longer reachable, so it is simply not ticked).
 */
export const EDIT_PICKS = ['nw-api', 'nw-web', 'hb-mobile', 'nw-legacy', 'gone-reports'];
export const EDIT_REMOVED: ConsentWorkspace = ws('nw-legacy', 'legacy-api', 'northwind/legacy-api');

const CLI_FLOW: RunnerConsentFlow = {
  kind: 'cli', callback: 'http://127.0.0.1:41776/callback', client: 'runner', accountName: null, level: 'worker', machine: 'studio-laptop',
};

export function isRunnerConsentFixtureState(value: string): value is RunnerConsentFixtureState {
  return (RUNNER_CONSENT_FIXTURE_STATES as readonly string[]).includes(value);
}

function editTeams(): ConsentTeam[] {
  // What runnerConsentTeams would offer if the removed pick were still listed...
  const offered = runnerPickerTeams(FIXTURE_TEAMS.map((t) => t.id === 'team-northwind'
    ? { ...t, workspaces: [...t.workspaces, EDIT_REMOVED].sort((a, b) => a.name.localeCompare(b.name)) }
    : t));
  // ...then, as editConsentTeams does, a pick a team admin removed is dropped.
  return offered
    .map((t) => ({ ...t, workspaces: t.workspaces.filter((w) => w.id !== EDIT_REMOVED.id) }))
    .filter((t) => t.workspaces.length > 0);
}

export function renderRunnerConsentFixture(state: RunnerConsentFixtureState): string {
  const common = { csrfToken: FIXTURE_TOKEN, action: FIXTURE_ACTION };
  if (state === 'single') {
    const teams = runnerPickerTeams(SINGLE_TEAM);
    return renderRunnerConsentHtml({ ...common, flow: CLI_FLOW, teams, state: initialRunnerState(teams, null) });
  }
  if (state === 'edit') {
    const teams = editTeams();
    return renderRunnerConsentHtml({
      ...common,
      flow: { kind: 'edit', accountId: 'fixture-key', accountName: 'studio-laptop', removedNames: [EDIT_REMOVED.name] },
      teams,
      state: initialRunnerState(teams, EDIT_PICKS),
    });
  }
  const teams = runnerPickerTeams(FIXTURE_TEAMS);
  if (state === 'device') {
    return renderRunnerConsentHtml({ ...common, flow: { kind: 'device', code: 'WDJB-MJHT' }, teams, state: initialRunnerState(teams, null) });
  }
  return renderRunnerConsentHtml({
    ...common,
    flow: CLI_FLOW,
    teams,
    state: initialRunnerState(teams, null),
    // What the CLI route shows for an approval with nothing ticked.
    error: state === 'error' ? 'Choose at least one workspace.' : null,
  });
}
