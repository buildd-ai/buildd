# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Per-task PR target branch override
- Show PR target branch in task creation UI
- Schedule deduplication and MCP taskTemplate support

### Fixed

- Use workspace gitConfig.targetBranch for PR base branch
- Remove problematic unique index, use query-based dedup, default PRs to dev

## [0.8.0] - 2026-02-19

### Added

- Generic webhook source type and ingest handler
- Pipeline UI, dependency management, and pipeline skill templates
- Expose prompt suggestions in local-ui via Stop hook
- Use SDK last_assistant_message in Stop/SubagentStop hooks for worker summaries
- Extract tool_use_id from task_notification events (SDK v0.2.47)
- Auto-scroll to bottom on task open with smart content compression in local-ui
- Thinking and effort controls for worker sessions
- FallbackModel support to workspace config and worker runners

### Changed

- Bump SDK version pins from >=0.2.45 to >=0.2.47

### Documentation

- Update claude-agent-sdk docs with v0.2.47 / CLI v2.1.47 changes
- Add SDK ecosystem research and recurring scan schedule
- Evaluate Python Agent SDK for Buildd workers
- Update claude-agent-sdk docs with SDK rename, Python SDK, and integration status

## [0.7.0] - 2026-02-18

### Added

- MaxTurns configuration to local-ui workspace settings
- 1M context beta support for Sonnet 4.x models
- Async hooks for observational worker hooks

### Changed

- Bump local-ui SDK pin from >=0.2.44 to >=0.2.45

### Documentation

- Update claude-agent-sdk docs with v0.2.45 integration status
- Update claude-agent-sdk docs with v0.2.45 API reference alignment

## [0.6.0] - 2026-02-17

### Added

- Pass image attachments to Claude Agent SDK session
- Organizer agent with workspace review capability
- Integration tests for team invitations and member management
- Session logging, improved error display, and plan retry for planning mode
- Integration tests for skills API and schedule management API
- Replace percentage progress with meaningful milestone checkpoints
- Seed scripts for error, completed, multi-user, and concurrent scenarios
- Handle SDKRateLimitEvent in worker-runner and local-ui
- Handle SDKTaskStartedMessage for subagent lifecycle tracking
- Claude Sonnet 4.6 to local-ui model allowlist
- Debug and debugFile options to WorkspaceGitConfig
- PermissionRequest hook for tool permission analytics
- PreCompact hook to archive transcripts before context compaction
- SessionStart and SessionEnd hooks to worker-runner
- Notification hook for agent status messages
- MCP tool annotations to buildd and buildd_memory tools
- SubagentStart and SubagentStop hook events
- Integration tests for auth API routes and observation system
- Unit tests for tool call tracking and error handling paths

### Fixed

- Prevent infinite loop in error-handling test
- Add missing fs mock exports and checkpointEvents guard
- Allow follow-up messages after agent completes task in local UI
- Swap theme toggle icons to show current state in local UI

### Changed

- Bump claude-agent-sdk from >=0.2.44 to >=0.2.45
- Add Neon branch management for schema-change PRs

### Documentation

- Update claude-agent-sdk docs with CLI v2.1.45 / SDK v0.2.45 changes

## [0.5.0] - 2026-02-17

### Added

- Integrate Claude SDK v0.2.44 features

## [0.4.0] - 2026-02-16

### Added

- Plugin support for workspace configuration
- File checkpointing and rollback support for worker sessions
- Durable task discovery via heartbeat and triggerValue interpolation in description

### Fixed

- Use line splitting instead of regex for SSE init test parsing
- Make SSE init test robust against chunked reads in CI
- Fix undefined task variable in startFromClaim
- Add dynamic base path for SPA routes behind reverse proxies
- Remove interactive prompt from sync-dev script

### Documentation

- Rewrite README to focus on product over self-hosting

## [0.3.2] - 2026-02-16

### Added

- TeammateIdle and TaskCompleted hooks for agent team visibility

### Fixed

- Add dynamic base path for SPA routes behind reverse proxies
- Remove interactive prompt from sync-dev script

### Changed

- Upgrade claude-agent-sdk to >=0.2.44 in packages/core and apps/agent

### Documentation

- Update claude-agent-sdk docs to v0.2.44

## [0.3.1] - 2026-02-16

### Fixed

- Add missing migration for schedule trigger columns

### Changed

- Add preview deploy tests and hotfix release workflow

## [0.3.0] - 2026-02-15

### Added

- Trigger-based conditional schedules

## [0.2.0] - 2026-02-15

### Added

- Self-managing scheduled tasks via MCP
- API key auth to schedule endpoints
- Pass skill slugs through scheduled task templates
- Branch cleanup to release script

### Fixed

- Require admin-level API key for schedule endpoints
- Prevent vim editor popup in sync-dev cherry-pick

## [0.1.1] - 2026-02-15

### Fixed

- Plan approval flow and post-task git branch sync
- Make task creation submit bar inline to prevent footer overlay

## [0.1.0] - 2026-02-15

### Added

- Worker environment profiles
- Remote skill installation on workers
- Persist worker state to disk for crash recovery
- Git worktree isolation for workers
- Sync-dev script for post-release workflow

### Fixed

- Add caching headers to static file serving
- Show plan content inline in local-ui and auto-approve EnterPlanMode
- Prevent completed/failed tasks from showing as needs input
- Improve mobile UI layout, z-index layering, and worker selection UX
