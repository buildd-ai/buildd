import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { db } from '@buildd/core/db';
import {
  workspaces, workspaceSkills, missions, tasks,
  type WorkspaceGitConfig, type WorkspaceReleaseConfig, type WorkspaceWorkTrackerConfig,
} from '@buildd/core/db/schema';
import { resolveReleaseTrigger } from '@buildd/core/release-strategy';
import { resolveBranchStrategy } from '@buildd/core/branch-strategy';
import { eq, and, isNotNull, gte, desc, sql } from 'drizzle-orm';
import { isRunnerSize, isWorkspaceExecutor, resolveWorkspaceExecutor } from '@buildd/shared';
import Section from '@/components/ui/Section';
import { MoveToTeamButton } from '@/components/MoveToTeamDialog';
import { collectPolicySuggestions } from '@/lib/policy-suggestions';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess, getUserTeamsWithDetails } from '@/lib/team-access';
import { resolvePolicy } from '@/lib/merge-policy';
import { getTeamsPermissionOverrides, getTeamPermissionOverrides, roleHas } from '@/lib/permissions';
import { loadWorkspaceRepoFacts, memberHasRepoAccess } from '@/lib/member-repo-access';
import { getRepoAccessView } from '@/lib/github-repo-access-store';
import { checkWorkspaceHealth } from '@/lib/workspace-health';
import { resolveWorkspaceRunnerSize } from '@/lib/runner-size-store';
import { workspaceHostedRunnerMonth } from '@/lib/hosted-runner-usage-store';
import { workspaceRunnerMonthLine } from '@/lib/hosted-runner-usage';
import SettingsPage from '../../_components/SettingsPage';
import SettingsSection from '../../SettingsSection';
import { moveTargets } from '../../workspaces/rows';
import { WorkspaceHealthCard } from './WorkspaceHealthCard';
import { readinessNotices } from './readiness-notices';
import { ReadinessCard } from './ReadinessCard';
import { RepoAccessCard } from './RepoAccessCard';
import { GitConfigForm } from './GitConfigForm';
import MemberRepoAccessSection from './MemberRepoAccessSection';
import MergePolicyEditor from './MergePolicyEditor';
import BranchStrategySection from './BranchStrategySection';
import CiRetrySection from './CiRetrySection';
import ReleaseSection from './ReleaseSection';
import SubjectPolicySection from './SubjectPolicySection';
import ExecutorSection from './ExecutorSection';
import RunnerSizeSection from './RunnerSizeSection';
import ConcurrencySection from './ConcurrencySection';
import WorkTrackerSection from './WorkTrackerSection';
import DeleteWorkspaceButton from './DeleteWorkspaceButton';

export const dynamic = 'force-dynamic';

const SUGGESTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Hairline-divided rows inside one group; each row component carries its own py-4. */
const ROWS = 'divide-y divide-border-default';

/**
 * Everything about one workspace, in one place: readiness, repository,
 * delivery, where work runs, integrations, and the danger zone. What used to
 * be split between this page (merge policy) and /app/workspaces/[id]/config
 * (now a redirect here).
 */
export default async function WorkspaceSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  const access = await verifyWorkspaceAccess(user.id, workspaceId);
  if (!access) notFound();
  const overrides = await getTeamPermissionOverrides(access.teamId);

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: {
      id: true,
      name: true,
      repo: true,
      teamId: true,
      gitConfig: true,
      configStatus: true,
      accessMode: true,
      releaseConfig: true,
      workTrackerConfig: true,
      webhookConfig: true,
      maxConcurrentTasks: true,
    },
  });
  if (!workspace) notFound();

  const gitConfig = workspace.gitConfig as WorkspaceGitConfig | null;
  const canManageSettings = roleHas(access.role, 'manage_workspace_settings', overrides);

  // Roles a reviewer can be picked from (skills with isRole = true).
  const roles = await db.query.workspaceSkills.findMany({
    where: and(
      eq(workspaceSkills.workspaceId, workspaceId),
      eq(workspaceSkills.isRole, true),
    ),
    columns: { slug: true, name: true },
  });

  // Missions with their own merge policy.
  const missionsWithOverrides = await db.query.missions.findMany({
    where: and(
      eq(missions.workspaceId, workspaceId),
      isNotNull(missions.mergePolicy),
    ),
    columns: { id: true, title: true, mergePolicy: true },
  });

  // Paths recent reviews flagged outside every risk class. Best-effort: the
  // page renders without them.
  const policyConfig = gitConfig?.policyConfig ?? null;
  const policySuggestions = policyConfig
    ? await db
        .select({ context: tasks.context })
        .from(tasks)
        .where(and(
          eq(tasks.workspaceId, workspaceId),
          eq(tasks.category, 'review'),
          gte(tasks.createdAt, new Date(Date.now() - SUGGESTION_WINDOW_MS)),
          sql`${tasks.context}->'policySuggestions' is not null`,
        ))
        .orderBy(desc(tasks.createdAt))
        .limit(200)
        .then(rows => collectPolicySuggestions(rows.map(r => r.context), policyConfig))
        .catch(() => [])
    : [];

  const userTeams = await getUserTeamsWithDetails(user.id).catch(() => []);
  const moveTeams = moveTargets(user.id, userTeams, workspace.teamId, await getTeamsPermissionOverrides(userTeams.map((t) => t.id)));

  // Read-only diagnosis; a failure here must not take the settings page down.
  const repoAccessView = await getRepoAccessView(workspaceId, user.id).catch((err) => {
    console.error('[workspace-settings] repo access view failed:', err);
    return null;
  });

  // Opt-in GitHub repo check (lib/member-repo-access.ts): the setting, and the
  // viewer's own result while it is on.
  const repoFacts = await loadWorkspaceRepoFacts(workspaceId).catch(() => null);
  const repoAccessMode = repoFacts?.mode ?? 'off';
  const viewerRepoAccess = repoAccessMode === 'off' ? null : await memberHasRepoAccess(user.id, workspaceId);

  const missionOverrides = missionsWithOverrides
    .filter(m => m.mergePolicy != null)
    .map(m => ({ id: m.id, title: m.title, policy: m.mergePolicy! }));

  // Where its tasks run: the stored value and the one the claim route applies.
  const storedExecutor = (workspace.gitConfig as { executor?: unknown } | null)?.executor;
  const executor = resolveWorkspaceExecutor(workspace.gitConfig as { executor?: unknown } | null, workspace.webhookConfig);
  // Cloud container size: only where cloud runs can take its tasks. Read-only
  // here; the dispatch route is the one that stores a fresh derivation.
  const storedRunnerSize = (workspace.gitConfig as { runnerSize?: unknown } | null)?.runnerSize;
  const runnerSize = executor.executor === 'host' ? null : await resolveWorkspaceRunnerSize(workspace);
  const runnerMonth = runnerSize ? await workspaceHostedRunnerMonth(workspace.id).catch(() => null) : null;

  const canDelete = roleHas(access.role, 'delete_workspace', overrides);

  // One notice per problem above the settings (readiness-notices.ts). Every
  // health action, the scaffold and the spec routes are admin writes, so
  // members only see the repo access row, and only when it is broken.
  const notices = readinessNotices({
    canManage: canManageSettings,
    repoAccessView,
    healthItems: checkWorkspaceHealth({
      name: workspace.name,
      repo: workspace.repo,
      configStatus: workspace.configStatus,
      accessMode: workspace.accessMode,
      gitConfig: workspace.gitConfig as Record<string, unknown> | null,
    }),
  });

  return (
    <SettingsPage
      title={workspace.name}
      titleOnMobile
      description={
        <>
          {workspace.repo
            ? <span className="font-mono text-text-primary break-all">{workspace.repo}</span>
            : 'No repository linked.'}
          {/* The phone header says "Workspaces"; the h1 and repo carry it there. */}
          <span className="hidden md:inline">{' '}How agents work in this workspace: git, merging, releases and where tasks run.</span>
        </>
      }
    >
      {(notices.health.length > 0 || notices.readiness || notices.repoAccess) && (
        <Section title="Readiness" id="readiness">
          <div className={ROWS}>
            {notices.health.length > 0 && (
              <WorkspaceHealthCard
                workspace={{ id: workspace.id, name: workspace.name }}
                items={notices.health}
              />
            )}
            {notices.readiness && <ReadinessCard workspaceId={workspace.id} />}
            {notices.repoAccess && repoAccessView && (
              <RepoAccessCard
                workspaceId={workspace.id}
                initialView={repoAccessView}
                canCheck={canManageSettings}
              />
            )}
          </div>
        </Section>
      )}

      <Section title="Repository" id="repository">
        <div className={ROWS}>
          <GitConfigForm
            workspaceId={workspace.id}
            workspaceName={workspace.name}
            initialConfig={gitConfig}
          />
          <MemberRepoAccessSection
            workspaceId={workspaceId}
            mode={repoAccessMode}
            repoFullName={repoFacts?.repoFullName ?? null}
            canManage={canManageSettings}
            viewer={viewerRepoAccess}
          />
        </div>
      </Section>

      <Section title="Delivery" id="delivery">
        <div className={ROWS}>
          <MergePolicyEditor
            workspaceId={workspaceId}
            workspaceName={workspace.name}
            initial={resolvePolicy(workspace)}
            policyConfig={policyConfig}
            policySuggestions={policySuggestions}
            roles={roles.map(r => ({ slug: r.slug, name: r.name }))}
            missionOverrides={missionOverrides}
            canEdit={canManageSettings}
          />
          <BranchStrategySection
            workspaceId={workspace.id}
            effectiveBranchStrategy={resolveBranchStrategy(gitConfig)}
            defaultBranch={gitConfig?.defaultBranch || 'main'}
          />
          <CiRetrySection
            workspaceId={workspace.id}
            initial={gitConfig?.enforceGreenCI === true}
            canEdit={canManageSettings}
          />
          <ReleaseSection
            workspaceId={workspace.id}
            teamId={workspace.teamId}
            initialReleaseConfig={workspace.releaseConfig as WorkspaceReleaseConfig | null}
            effectiveTrigger={resolveReleaseTrigger(workspace.releaseConfig as WorkspaceReleaseConfig | null)}
            hasRepo={Boolean(workspace.repo)}
          />
          <SubjectPolicySection
            workspaceId={workspace.id}
            initialPolicy={(workspace.gitConfig as any)?.subjectPolicy ?? null}
          />
        </div>
      </Section>

      <Section title="Where work runs" id="where-work-runs">
        <div className={ROWS}>
          <ExecutorSection
            workspaceId={workspace.id}
            explicit={isWorkspaceExecutor(storedExecutor) ? storedExecutor : null}
            effective={executor.executor}
            source={executor.source}
          />
          {runnerSize && (
            <RunnerSizeSection
              workspaceId={workspace.id}
              explicit={isRunnerSize(storedRunnerSize) ? storedRunnerSize : null}
              effective={runnerSize.size}
              source={runnerSize.source}
              reason={runnerSize.reason}
              monthLine={runnerMonth && runnerMonth.wallSeconds > 0 ? workspaceRunnerMonthLine(runnerMonth) : null}
            />
          )}
          <ConcurrencySection
            workspaceId={workspace.id}
            initialMaxConcurrentTasks={workspace.maxConcurrentTasks}
          />
          <p className="py-4 last:pb-0 text-xs text-text-secondary" data-testid="workspace-runners-pointer">
            Runners and their sign-ins are set up in{' '}
            <Link href="/app/settings/runners" className="text-text-primary underline">Settings › Runners</Link>.
          </p>
        </div>
      </Section>

      <Section title="Integrations" id="integrations">
        <WorkTrackerSection
          workspaceId={workspace.id}
          initialWorkTrackerConfig={workspace.workTrackerConfig as WorkspaceWorkTrackerConfig | null}
        />
      </Section>

      {/* Destructive actions sit at the bottom, away from everything else.
          Moving needs manage rights in both teams (moveTargets); DELETE is
          owner-only, so other roles would get a button that always fails. */}
      {(moveTeams || canDelete) && (
        <SettingsSection title="Danger zone" id="danger-zone" tone="danger">
          <div className={ROWS}>
            {moveTeams && (
              <div className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <h3 className="text-sm font-medium text-text-primary">Move to another team</h3>
                  <p className="text-xs text-text-secondary mt-0.5">Hands this workspace to a team you manage.</p>
                </div>
                <MoveToTeamButton
                  workspace={{ id: workspace.id, name: workspace.name, teamId: workspace.teamId }}
                  teams={moveTeams}
                  className="btn min-h-11 shrink-0"
                />
              </div>
            )}
            {roleHas(access.role, 'delete_workspace', overrides) && (
              <div
                data-testid="workspace-danger-zone"
                className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <h3 className="text-sm font-medium text-status-error">Delete workspace</h3>
                  <p className="text-xs text-text-secondary mt-0.5">
                    Deletes the workspace and its tasks and workers. You can&apos;t undo this.
                  </p>
                </div>
                <DeleteWorkspaceButton workspaceId={workspace.id} workspaceName={workspace.name} />
              </div>
            )}
          </div>
        </SettingsSection>
      )}
    </SettingsPage>
  );
}
