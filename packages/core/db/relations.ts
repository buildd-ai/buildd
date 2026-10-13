// Relations for drizzle's relational query API (db.query.*), RQB v2.
// Generated from the relations() blocks schema.ts used to hold, by
// scripts/codemods/rqb-v2.ts; edit it by hand from here on.
//
// `optional: false` marks a relation whose `from` columns are all NOT NULL,
// which RQB v1 typed as non-null. A `many` names the columns of the `one` it
// pairs with; `alias` keeps v1's relationName where there was one.

// The subpath, not 'drizzle-orm': route tests mock.module('drizzle-orm') with
// only the operators they use, and this module loads with the db client.
import { defineRelations } from 'drizzle-orm/relations';
import * as schema from './schema';

export const relations = defineRelations(schema, (r) => ({
  teams: {
    members: r.many.teamMembers({ from: r.teams.id, to: r.teamMembers.teamId }),
    accounts: r.many.accounts({ from: r.teams.id, to: r.accounts.teamId }),
    workspaces: r.many.workspaces({ from: r.teams.id, to: r.workspaces.teamId }),
    missions: r.many.missions({ from: r.teams.id, to: r.missions.teamId }),
    initiatives: r.many.initiatives({ from: r.teams.id, to: r.initiatives.teamId }),
    invitations: r.many.teamInvitations({ from: r.teams.id, to: r.teamInvitations.teamId }),
    workspaceSkills: r.many.workspaceSkills({ from: r.teams.id, to: r.workspaceSkills.teamId }),
    connectors: r.many.connectors({ from: r.teams.id, to: r.connectors.teamId }),
    memories: r.many.memories({ from: r.teams.id, to: r.memories.teamId }),
  },
  teamMembers: {
    team: r.one.teams({ from: r.teamMembers.teamId, to: r.teams.id, optional: false }),
    user: r.one.users({ from: r.teamMembers.userId, to: r.users.id, optional: false }),
  },
  teamInvitations: {
    team: r.one.teams({ from: r.teamInvitations.teamId, to: r.teams.id, optional: false }),
    inviter: r.one.users({ from: r.teamInvitations.invitedBy, to: r.users.id }),
  },
  users: {
    teamMembers: r.many.teamMembers({ from: r.users.id, to: r.teamMembers.userId }),
    deviceCodes: r.many.deviceCodes({ from: r.users.id, to: r.deviceCodes.userId }),
  },
  accounts: {
    team: r.one.teams({ from: r.accounts.teamId, to: r.teams.id, optional: false }),
    accountWorkspaces: r.many.accountWorkspaces({ from: r.accounts.id, to: r.accountWorkspaces.accountId }),
    tasks: r.many.tasks({ from: r.accounts.id, to: r.tasks.claimedBy, alias: 'claimedTasks' }),
    workers: r.many.workers({ from: r.accounts.id, to: r.workers.accountId }),
    createdTasks: r.many.tasks({ from: r.accounts.id, to: r.tasks.createdByAccountId, alias: 'accountCreatedTasks' }),
    heartbeats: r.many.workerHeartbeats({ from: r.accounts.id, to: r.workerHeartbeats.accountId }),
  },
  accountWorkspaces: {
    account: r.one.accounts({ from: r.accountWorkspaces.accountId, to: r.accounts.id, optional: false }),
    workspace: r.one.workspaces({ from: r.accountWorkspaces.workspaceId, to: r.workspaces.id, optional: false }),
  },
  missions: {
    team: r.one.teams({ from: r.missions.teamId, to: r.teams.id, optional: false }),
    workspace: r.one.workspaces({ from: r.missions.workspaceId, to: r.workspaces.id }),
    createdByUser: r.one.users({ from: r.missions.createdByUserId, to: r.users.id }),
    parentMission: r.one.missions({ from: r.missions.parentMissionId, to: r.missions.id, alias: 'subMissions' }),
    subMissions: r.many.missions({ from: r.missions.id, to: r.missions.parentMissionId, alias: 'subMissions' }),
    initiative: r.one.initiatives({ from: r.missions.initiativeId, to: r.initiatives.id }),
    dependsOnMission: r.one.missions({ from: r.missions.dependsOnMissionId, to: r.missions.id, alias: 'dependentMissions' }),
    dependentMissions: r.many.missions({ from: r.missions.id, to: r.missions.dependsOnMissionId, alias: 'dependentMissions' }),
    tasks: r.many.tasks({ from: r.missions.id, to: r.tasks.missionId }),
    schedule: r.one.taskSchedules({ from: r.missions.scheduleId, to: r.taskSchedules.id }),
    artifacts: r.many.artifacts({ from: r.missions.id, to: r.artifacts.missionId }),
    notes: r.many.missionNotes({ from: r.missions.id, to: r.missionNotes.missionId }),
  },
  workspaces: {
    team: r.one.teams({ from: r.workspaces.teamId, to: r.teams.id, optional: false }),
    tasks: r.many.tasks({ from: r.workspaces.id, to: r.tasks.workspaceId }),
    workers: r.many.workers({ from: r.workspaces.id, to: r.workers.workspaceId }),
    accountWorkspaces: r.many.accountWorkspaces({ from: r.workspaces.id, to: r.accountWorkspaces.workspaceId }),
    artifacts: r.many.artifacts({ from: r.workspaces.id, to: r.artifacts.workspaceId }),
    taskSchedules: r.many.taskSchedules({ from: r.workspaces.id, to: r.taskSchedules.workspaceId }),
    workspaceSkills: r.many.workspaceSkills({ from: r.workspaces.id, to: r.workspaceSkills.workspaceId }),
    missions: r.many.missions({ from: r.workspaces.id, to: r.missions.workspaceId }),
    initiatives: r.many.initiatives({ from: r.workspaces.id, to: r.initiatives.workspaceId }),
    githubRepo: r.one.githubRepos({ from: r.workspaces.githubRepoId, to: r.githubRepos.id }),
    githubInstallation: r.one.githubInstallations({ from: r.workspaces.githubInstallationId, to: r.githubInstallations.id }),
    connectorWorkspaces: r.many.connectorWorkspaces({ from: r.workspaces.id, to: r.connectorWorkspaces.workspaceId }),
    specDiscrepancies: r.many.specDiscrepancies({ from: r.workspaces.id, to: r.specDiscrepancies.workspaceId }),
  },
  tasks: {
    workspace: r.one.workspaces({ from: r.tasks.workspaceId, to: r.workspaces.id, optional: false }),
    account: r.one.accounts({ from: r.tasks.claimedBy, to: r.accounts.id, alias: 'claimedTasks' }),
    mission: r.one.missions({ from: r.tasks.missionId, to: r.missions.id }),
    schedule: r.one.taskSchedules({ from: r.tasks.scheduleId, to: r.taskSchedules.id }),
    workers: r.many.workers({ from: r.tasks.id, to: r.workers.taskId, alias: 'taskWorkers' }),
    // Creator tracking relations
    creatorAccount: r.one.accounts({ from: r.tasks.createdByAccountId, to: r.accounts.id, alias: 'accountCreatedTasks' }),
    creatorWorker: r.one.workers({ from: r.tasks.createdByWorkerId, to: r.workers.id, alias: 'workerCreatedTasks' }),
    parentTask: r.one.tasks({ from: r.tasks.parentTaskId, to: r.tasks.id, alias: 'subTasks' }),
    subTasks: r.many.tasks({ from: r.tasks.id, to: r.tasks.parentTaskId, alias: 'subTasks' }),
    subjectReports: r.many.taskSubjectReports({ from: r.tasks.id, to: r.taskSubjectReports.taskId }),
    subjectClaims: r.many.taskSubjectClaims({ from: r.tasks.id, to: r.taskSubjectClaims.canonicalTaskId }),
  },
  taskSubjectReports: {
    task: r.one.tasks({ from: r.taskSubjectReports.taskId, to: r.tasks.id, optional: false }),
    reporter: r.one.accounts({ from: r.taskSubjectReports.reporterId, to: r.accounts.id }),
  },
  taskSubjectClaims: {
    workspace: r.one.workspaces({ from: r.taskSubjectClaims.workspaceId, to: r.workspaces.id, optional: false }),
    canonicalTask: r.one.tasks({ from: r.taskSubjectClaims.canonicalTaskId, to: r.tasks.id }),
  },
  specDiscrepancies: {
    workspace: r.one.workspaces({ from: r.specDiscrepancies.workspaceId, to: r.workspaces.id, optional: false }),
    promotedMission: r.one.missions({ from: r.specDiscrepancies.promotedMissionId, to: r.missions.id }),
    docFixTask: r.one.tasks({ from: r.specDiscrepancies.docFixTaskId, to: r.tasks.id }),
  },
  workers: {
    task: r.one.tasks({ from: r.workers.taskId, to: r.tasks.id, alias: 'taskWorkers' }),
    workspace: r.one.workspaces({ from: r.workers.workspaceId, to: r.workspaces.id, optional: false }),
    account: r.one.accounts({ from: r.workers.accountId, to: r.accounts.id }),
    artifacts: r.many.artifacts({ from: r.workers.id, to: r.artifacts.workerId }),
    createdTasks: r.many.tasks({ from: r.workers.id, to: r.tasks.createdByWorkerId, alias: 'workerCreatedTasks' }),
  },
  artifacts: {
    worker: r.one.workers({ from: r.artifacts.workerId, to: r.workers.id }),
    workspace: r.one.workspaces({ from: r.artifacts.workspaceId, to: r.workspaces.id }),
    mission: r.one.missions({ from: r.artifacts.missionId, to: r.missions.id }),
    initiative: r.one.initiatives({ from: r.artifacts.initiativeId, to: r.initiatives.id }),
  },
  initiatives: {
    team: r.one.teams({ from: r.initiatives.teamId, to: r.teams.id, optional: false }),
    workspace: r.one.workspaces({ from: r.initiatives.workspaceId, to: r.workspaces.id }),
    createdByUser: r.one.users({ from: r.initiatives.createdByUserId, to: r.users.id }),
    ownerUser: r.one.users({ from: r.initiatives.ownerUserId, to: r.users.id }),
    missions: r.many.missions({ from: r.initiatives.id, to: r.missions.initiativeId }),
    artifacts: r.many.artifacts({ from: r.initiatives.id, to: r.artifacts.initiativeId }),
  },
  evidenceBackends: {
    team: r.one.teams({ from: r.evidenceBackends.teamId, to: r.teams.id, optional: false }),
    workspace: r.one.workspaces({ from: r.evidenceBackends.workspaceId, to: r.workspaces.id }),
    credentialSecret: r.one.secrets({ from: r.evidenceBackends.credentialSecretId, to: r.secrets.id }),
  },
  evidenceObjects: {
    workspace: r.one.workspaces({ from: r.evidenceObjects.workspaceId, to: r.workspaces.id, optional: false }),
    task: r.one.tasks({ from: r.evidenceObjects.taskId, to: r.tasks.id }),
    rootTask: r.one.tasks({ from: r.evidenceObjects.rootTaskId, to: r.tasks.id }),
    worker: r.one.workers({ from: r.evidenceObjects.workerId, to: r.workers.id }),
    backend: r.one.evidenceBackends({ from: r.evidenceObjects.backendId, to: r.evidenceBackends.id }),
  },
  missionNotes: {
    mission: r.one.missions({ from: r.missionNotes.missionId, to: r.missions.id }),
  },
  workerHeartbeats: {
    account: r.one.accounts({ from: r.workerHeartbeats.accountId, to: r.accounts.id, optional: false }),
  },
  taskSchedules: {
    workspace: r.one.workspaces({ from: r.taskSchedules.workspaceId, to: r.workspaces.id }),
    createdByUser: r.one.users({ from: r.taskSchedules.createdByUserId, to: r.users.id }),
    tasks: r.many.tasks({ from: r.taskSchedules.id, to: r.tasks.scheduleId }),
  },
  githubInstallations: {
    repos: r.many.githubRepos({ from: r.githubInstallations.id, to: r.githubRepos.installationId }),
    workspaces: r.many.workspaces({ from: r.githubInstallations.id, to: r.workspaces.githubInstallationId }),
  },
  githubRepos: {
    installation: r.one.githubInstallations({ from: r.githubRepos.installationId, to: r.githubInstallations.id, optional: false }),
    workspaces: r.many.workspaces({ from: r.githubRepos.id, to: r.workspaces.githubRepoId }),
  },
  workspaceSkills: {
    team: r.one.teams({ from: r.workspaceSkills.teamId, to: r.teams.id, optional: false }),
    workspace: r.one.workspaces({ from: r.workspaceSkills.workspaceId, to: r.workspaces.id }),
    account: r.one.accounts({ from: r.workspaceSkills.accountId, to: r.accounts.id }),
  },
  watchedProjects: {
    workspace: r.one.workspaces({ from: r.watchedProjects.workspaceId, to: r.workspaces.id, optional: false }),
    events: r.many.watcherEvents({ from: r.watchedProjects.id, to: r.watcherEvents.projectId }),
  },
  watcherEvents: {
    project: r.one.watchedProjects({ from: r.watcherEvents.projectId, to: r.watchedProjects.id, optional: false }),
  },
  deviceCodes: {
    user: r.one.users({ from: r.deviceCodes.userId, to: r.users.id }),
  },
  secrets: {
    team: r.one.teams({ from: r.secrets.teamId, to: r.teams.id, optional: false }),
    account: r.one.accounts({ from: r.secrets.accountId, to: r.accounts.id }),
    workspace: r.one.workspaces({ from: r.secrets.workspaceId, to: r.workspaces.id }),
    lease: r.many.credentialLeases({ from: r.secrets.id, to: r.credentialLeases.credentialId }),
  },
  credentialLeases: {
    credential: r.one.secrets({ from: r.credentialLeases.credentialId, to: r.secrets.id, optional: false }),
  },
  notificationPreferences: {
    team: r.one.teams({ from: r.notificationPreferences.teamId, to: r.teams.id, optional: false }),
  },
  userFeedback: {
    user: r.one.users({ from: r.userFeedback.userId, to: r.users.id, optional: false }),
    team: r.one.teams({ from: r.userFeedback.teamId, to: r.teams.id, optional: false }),
  },
  actionQueueSnoozes: {
    user: r.one.users({ from: r.actionQueueSnoozes.userId, to: r.users.id, optional: false }),
    team: r.one.teams({ from: r.actionQueueSnoozes.teamId, to: r.teams.id, optional: false }),
  },
  tenantBudgets: {
    team: r.one.teams({ from: r.tenantBudgets.teamId, to: r.teams.id, optional: false }),
  },
  backendPauses: {
    team: r.one.teams({ from: r.backendPauses.teamId, to: r.teams.id, optional: false }),
    workspace: r.one.workspaces({ from: r.backendPauses.workspaceId, to: r.workspaces.id }),
  },
  oauthBudgetEpisodes: {
    account: r.one.accounts({ from: r.oauthBudgetEpisodes.accountId, to: r.accounts.id, optional: false }),
  },
  connectors: {
    team: r.one.teams({ from: r.connectors.teamId, to: r.teams.id, optional: false }),
    connectorWorkspaces: r.many.connectorWorkspaces({ from: r.connectors.id, to: r.connectorWorkspaces.connectorId }),
    shares: r.many.connectorShares({ from: r.connectors.id, to: r.connectorShares.connectorId }),
  },
  connectorWorkspaces: {
    connector: r.one.connectors({ from: r.connectorWorkspaces.connectorId, to: r.connectors.id, optional: false }),
    workspace: r.one.workspaces({ from: r.connectorWorkspaces.workspaceId, to: r.workspaces.id, optional: false }),
  },
  connectorShares: {
    connector: r.one.connectors({ from: r.connectorShares.connectorId, to: r.connectors.id, optional: false }),
    sharedWithTeam: r.one.teams({ from: r.connectorShares.sharedWithTeamId, to: r.teams.id, optional: false }),
  },
  externalLinks: {
    team: r.one.teams({ from: r.externalLinks.teamId, to: r.teams.id, optional: false }),
  },
  modelTierRegistry: {
    team: r.one.teams({ from: r.modelTierRegistry.teamId, to: r.teams.id, optional: false }),
    workspace: r.one.workspaces({ from: r.modelTierRegistry.workspaceId, to: r.workspaces.id }),
  },
  migrationLog: {
    workspace: r.one.workspaces({ from: r.migrationLog.workspaceId, to: r.workspaces.id, optional: false }),
  },
  changeIntents: {
    workspace: r.one.workspaces({ from: r.changeIntents.workspaceId, to: r.workspaces.id, optional: false }),
    task: r.one.tasks({ from: r.changeIntents.taskId, to: r.tasks.id }),
  },
  pathClaims: {
    workspace: r.one.workspaces({ from: r.pathClaims.workspaceId, to: r.workspaces.id, optional: false }),
    task: r.one.tasks({ from: r.pathClaims.taskId, to: r.tasks.id, optional: false }),
  },
  pathClaimWaiters: {
    workspace: r.one.workspaces({ from: r.pathClaimWaiters.workspaceId, to: r.workspaces.id, optional: false }),
    blockingTask: r.one.tasks({ from: r.pathClaimWaiters.blockingTaskId, to: r.tasks.id, optional: false, alias: 'blockingClaims' }),
    waitingTask: r.one.tasks({ from: r.pathClaimWaiters.waitingTaskId, to: r.tasks.id, optional: false, alias: 'waitingClaims' }),
  },
  releases: {
    workspace: r.one.workspaces({ from: r.releases.workspaceId, to: r.workspaces.id, optional: false }),
    releaseTasks: r.many.releaseTasks({ from: r.releases.id, to: r.releaseTasks.releaseId }),
  },
  releaseTasks: {
    release: r.one.releases({ from: r.releaseTasks.releaseId, to: r.releases.id, optional: false }),
    task: r.one.tasks({ from: r.releaseTasks.taskId, to: r.tasks.id, optional: false }),
  },
  memories: {
    team: r.one.teams({ from: r.memories.teamId, to: r.teams.id, optional: false }),
  },
  gateEvents: {
    workspace: r.one.workspaces({ from: r.gateEvents.workspaceId, to: r.workspaces.id }),
    mission: r.one.missions({ from: r.gateEvents.missionId, to: r.missions.id }),
    task: r.one.tasks({ from: r.gateEvents.taskId, to: r.tasks.id }),
    worker: r.one.workers({ from: r.gateEvents.workerId, to: r.workers.id }),
  },
  workerTerminalRecords: {
    worker: r.one.workers({ from: r.workerTerminalRecords.workerId, to: r.workers.id, optional: false }),
    task: r.one.tasks({ from: r.workerTerminalRecords.taskId, to: r.tasks.id }),
    workspace: r.one.workspaces({ from: r.workerTerminalRecords.workspaceId, to: r.workspaces.id }),
  },
  failureIncidents: {
    workspace: r.one.workspaces({ from: r.failureIncidents.workspaceId, to: r.workspaces.id }),
    linkedFixTask: r.one.tasks({ from: r.failureIncidents.linkedFixTaskId, to: r.tasks.id }),
  },
}));
