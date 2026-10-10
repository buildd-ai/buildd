/**
 * A member without manage_workspace_settings reads every workspace setting as
 * plain text: no form controls at all (disabled or not), and no per-section
 * line saying who may change it. The page says that once, at the top
 * (SettingsPage readOnly). Controls the member can genuinely use stay, and each
 * test names them. Fixtures are illustrative.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/workspace/ws-1', width: 1280, height: 900 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

mock.module('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {}, prefetch: () => {} }),
  usePathname: () => '/app/settings/workspace/ws-1',
  useSearchParams: () => new URLSearchParams(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { describeControls } = await import('../../_lib/form-controls');
const { GitConfigForm } = await import('./GitConfigForm');
const { default: MemberRepoAccessSection } = await import('./MemberRepoAccessSection');
const { default: MergePolicyEditor } = await import('./MergePolicyEditor');
const { default: BranchStrategySection } = await import('./BranchStrategySection');
const { default: CiRetrySection } = await import('./CiRetrySection');
const { default: CopyReviewSection } = await import('./CopyReviewSection');
const { default: ReleaseSection } = await import('./ReleaseSection');
const { default: SubjectPolicySection } = await import('./SubjectPolicySection');
const { default: ExecutorSection } = await import('./ExecutorSection');
const { default: RunnerSizeSection } = await import('./RunnerSizeSection');
const { default: WorkTrackerSection } = await import('./WorkTrackerSection');
const { RepoAccessCard } = await import('./RepoAccessCard');

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  // Every read these sections make on mount answers with an empty result.
  globalThis.fetch = mock(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  globalThis.fetch = realFetch;
});

async function mount(node: React.ReactNode) {
  await act(async () => { root.render(node); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const WHO_CAN_CHANGE = /Admins can|admins can|Only a team owner|Only workspace admins|can change this|A workspace admin can/;

function expectReadOnly() {
  expect(describeControls(host)).toEqual([]);
  expect(host.querySelector('fieldset[disabled]')).toBeNull();
  expect(host.textContent ?? '').not.toMatch(WHO_CAN_CHANGE);
}

describe('workspace settings, read by a member', () => {
  it('GitConfigForm: every git setting as text', async () => {
    await mount(
      <GitConfigForm
        workspaceId="ws-1"
        workspaceName="app"
        canEdit={false}
        initialConfig={{
          defaultBranch: 'dev',
          branchingStrategy: 'gitflow',
          commitStyle: 'conventional',
          requiresPR: true,
          targetBranch: 'staging',
          autoCreatePR: true,
          useClaudeMd: true,
          agentInstructions: 'Run the linter first.',
          effort: 'high',
          criteriaGrader: 'runner',
        }}
      />,
    );
    expectReadOnly();
    const text = host.textContent ?? '';
    for (const v of ['dev', 'GitFlow', 'Conventional Commits', 'staging', 'Run the linter first.', 'High']) {
      expect(text).toContain(v);
    }
    // Goal grading left the UI; a stored value stays in gitConfig.
    expect(text).not.toMatch(/criteria grading|goal grading/i);
    expect(host.querySelector('[data-testid="git-config-merge-policy"]')).not.toBeNull();
  });

  it('MemberRepoAccessSection: on or off as text', async () => {
    await mount(<MemberRepoAccessSection workspaceId="ws-1" mode="require_read" repoFullName="acme/web" canManage={false} viewer={null} />);
    expectReadOnly();
    expect(host.querySelector('[data-testid="member-repo-access-value"]')!.textContent).toBe('On');
  });

  it('MemberRepoAccessSection: no "link a repository to turn this on" for someone who cannot turn it on', async () => {
    await mount(<MemberRepoAccessSection workspaceId="ws-1" mode="off" repoFullName={null} canManage={false} viewer={null} />);
    expectReadOnly();
    expect(host.querySelector('[data-testid="member-repo-access-value"]')!.textContent).toBe('Off');
    expect(host.textContent).not.toContain('to turn this on');
  });

  it('MergePolicyEditor: tier, limit, paths and suggestions as text; mission overrides keep their own actions', async () => {
    await mount(
      <MergePolicyEditor
        workspaceId="ws-1"
        workspaceName="app"
        initial={{ tier: 'auto-threshold', threshold: { maxLines: 500 }, stallNotifyMinutes: 45 }}
        policyConfig={{ preset: 'balanced', riskClasses: [{ name: 'ci_deploy_config', detectedPaths: ['.github/workflows/'] }] }}
        policySuggestions={[{ path: 'lib/auth/session.ts', class: 'auth_and_secrets' }]}
        roles={[]}
        missionOverrides={[]}
        canEdit={false}
      />,
    );
    expectReadOnly();
    const text = host.textContent ?? '';
    for (const v of ['Auto-threshold', '500', '.github/workflows/', 'lib/auth/session.ts', '45 minutes']) expect(text).toContain(v);
    expect(text).not.toContain('Re-scan to detect');
  });

  it('MergePolicyEditor: agent review shows the reviewer role by name', async () => {
    await mount(
      <MergePolicyEditor
        workspaceId="ws-1"
        workspaceName="app"
        initial={{ tier: 'agent-review', agentReview: { reviewerRole: 'reviewer', gateCondition: 'approve-only' }, dataMigrations: 'agent-review' }}
        policyConfig={null}
        roles={[{ slug: 'reviewer', name: 'Reviewer' }]}
        missionOverrides={[{ id: 'm-1', title: 'Checkout redesign', policy: { tier: 'human' } }]}
        canEdit={false}
      />,
    );
    // Mission overrides are mission settings any member may change.
    expect(describeControls(host)).toEqual(['button "Edit"', 'button "Remove"']);
    const text = host.textContent ?? '';
    for (const v of ['Agent review', 'Reviewer', 'Approve only', 'Reviewer agent decides']) expect(text).toContain(v);
    expect(text).not.toMatch(WHO_CAN_CHANGE);
  });

  it('BranchStrategySection: the strategy as text', async () => {
    await mount(<BranchStrategySection workspaceId="ws-1" effectiveBranchStrategy="direct" defaultBranch="dev" canEdit={false} />);
    expectReadOnly();
    expect(host.querySelector('[data-testid="branch-strategy-value"]')!.textContent).toBe('Direct');
    expect(host.querySelector('[data-testid="branch-strategy-description"]')!.textContent).toContain('dev');
  });

  it('CiRetrySection: on or off as text', async () => {
    await mount(<CiRetrySection workspaceId="ws-1" initial={true} canEdit={false} />);
    expectReadOnly();
    expect(host.querySelector('[data-testid="ci-retry-value"]')!.textContent).toBe('On');
  });

  it('CopyReviewSection: the mode, voice guide and lint command as text', async () => {
    await mount(<CopyReviewSection workspaceId="ws-1" initial={{ mode: 'gate', voiceGuide: 'VOICE.md', lintCommand: 'bun run copy:check' }} canEdit={false} />);
    expectReadOnly();
    const text = host.textContent ?? '';
    for (const v of ['Required', 'VOICE.md', 'bun run copy:check']) expect(text).toContain(v);
  });

  it('ReleaseSection: strategy, fields and trigger as text, with no invitation to add a token', async () => {
    await mount(
      <ReleaseSection
        workspaceId="ws-1"
        teamId="team-1"
        initialReleaseConfig={{ enabled: true, strategy: 'workflow_dispatch', workflowFile: 'ship.yml', ref: 'dev', trigger: 'manual' }}
        hasRepo={true}
        canEdit={false}
      />,
    );
    expectReadOnly();
    const text = host.textContent ?? '';
    for (const v of ['Workflow dispatch', 'ship.yml', 'dev', 'Manual only', 'Not configured']) expect(text).toContain(v);
    expect(text).not.toContain('Add one');
    expect(text).not.toContain('Every merge');
  });

  it('SubjectPolicySection: each policy value as text', async () => {
    await mount(<SubjectPolicySection workspaceId="ws-1" initialPolicy={{ autoCloseBuilddSupersededPrs: true, conflictDeadDays: 10 }} canEdit={false} />);
    expectReadOnly();
    const text = host.textContent ?? '';
    expect(text).toContain('Prior-work injection');
    expect(text).toContain('10 days');
  });

  it('ExecutorSection: where tasks run, with no picker', async () => {
    await mount(<ExecutorSection workspaceId="ws-1" explicit="host" effective="host" source="explicit" canEdit={false} />);
    expectReadOnly();
    expect(host.querySelector('[data-testid="workspace-executor-effective"]')!.textContent).toBe('Host');
  });

  it('RunnerSizeSection: the size, with no picker', async () => {
    await mount(<RunnerSizeSection workspaceId="ws-1" explicit={null} effective="large" source="derived" reason="low_disk" canEdit={false} />);
    expectReadOnly();
    expect(host.querySelector('[data-testid="workspace-runner-size-effective"]')!.textContent).toBe('Large');
  });

  it('WorkTrackerSection: the linked tracker as text', async () => {
    await mount(<WorkTrackerSection workspaceId="ws-1" initialWorkTrackerConfig={{ provider: 'github', inboundLabel: 'triage' }} canEdit={false} />);
    expectReadOnly();
    const text = host.textContent ?? '';
    expect(text).toContain('GitHub (repo App)');
    expect(text).toContain('triage');
  });

  it('WorkTrackerSection: none linked reads as None', async () => {
    await mount(<WorkTrackerSection workspaceId="ws-1" initialWorkTrackerConfig={null} canEdit={false} />);
    expectReadOnly();
    expect(host.querySelector('[data-testid="work-tracker-value"]')!.textContent).toBe('None');
  });

  it('RepoAccessCard: a broken connection says what is wrong, with no line about who fixes it', async () => {
    await mount(
      <RepoAccessCard
        workspaceId="ws-1"
        canCheck={false}
        initialView={{
          ok: false,
          repo: 'acme/web',
          waitingTasks: 0,
          remediation: { reason: 'stale_link', title: 'Connection needs checking', message: 'The saved link is out of date.', action: { kind: 'check_connection', label: 'Check connection', url: null }, adminInstructions: null, githubUrl: null },
        } as never}
      />,
    );
    expectReadOnly();
    expect(host.textContent).toContain('The saved link is out of date.');
  });

  it('RepoAccessCard: no "choose a repository" button for someone who cannot link one', async () => {
    await mount(
      <RepoAccessCard
        workspaceId="ws-1"
        canCheck={false}
        initialView={{
          ok: false,
          repo: null,
          waitingTasks: 0,
          remediation: { reason: 'no_repo', title: 'No repository linked', message: 'This workspace has no repository.', action: { kind: 'link_repo', label: 'Choose a repository', url: null }, adminInstructions: null, githubUrl: null },
        } as never}
      />,
    );
    expectReadOnly();
  });
});
