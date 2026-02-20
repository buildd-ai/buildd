# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.0] - 2026-02-19

### Added

- Per-task PR target branch override
- Show PR target branch in task creation UI
- Schedule deduplication and MCP taskTemplate support
- Make skills prominent on dashboard with custom task picker
- Enhance MCP register_skill and update_schedule, add sdk-ecosystem-research skill
- Mobile UX fixes for task creation, worker monitoring, plan review

### Fixed

- Use workspace gitConfig.targetBranch for PR base branch
- Remove problematic unique index, use query-based dedup, default PRs to dev
- Wrap skills stats query in try/catch

## [0.8.0] - 2026-02-19

### Added
- Pass image attachments to Claude Agent SDK session
- Organizer agent with workspace review capability
- Integration tests for team invitations and member management
- Session logging, improved error display, and plan retry for planning mode
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
- Integration tests for skills API and schedule management API
- Comprehensive unit tests for error handling paths and tool call tracking
- Integration tests for auth API routes and observation system
- Neon branch management for schema-change PRs (CI)

### Fixed
- Prevent infinite loop in error-handling test
- Add missing fs mock exports and checkpointEvents guard
- Use namespace import for fs to fix Bun named export compatibility
- Allow follow-up messages after agent completes task in local UI
- Swap theme toggle icons to show current state in local UI

### Changed
- Bump claude-agent-sdk from >=0.2.44 to >=0.2.45

### Documentation
- Update claude-agent-sdk docs with CLI v2.1.45 / SDK v0.2.45 changes

## [0.7.0] - 2026-02-18

_Release PR only — changes included in v0.6.0 and v0.8.0._

## [0.6.0] - 2026-02-17

_Release PR only — changes accumulated in v0.5.0 through v0.8.0._

## [0.5.0] - 2026-02-17

### Added
- Integrate Claude SDK v0.2.44 features

## [0.4.0] - 2026-02-16

### Added
- Plugin support for workspace configuration
- File checkpointing and rollback support for worker sessions

## [0.3.2] - 2026-02-16

### Added
- TeammateIdle and TaskCompleted hooks for agent team visibility

### Changed
- Upgrade claude-agent-sdk to >=0.2.44 in packages/core and apps/agent

### Documentation
- Update claude-agent-sdk docs to v0.2.44

## [0.3.1] - 2026-02-16

_Patch release._

## [0.3.0] - 2026-02-15

_Release PR._

## [0.2.0] - 2026-02-15

_Release PR._

## [0.1.1] - 2026-02-15

### Added
- Initial release with full task coordination system
- Monorepo setup with Turborepo (apps/web, apps/agent, apps/local-ui, apps/mcp-server)
- Next.js 16 web dashboard with app router and subdomain routing
- Drizzle ORM with Postgres (Neon) for persistence
- Google OAuth with NextAuth v5
- Dual auth model: API key (pay-per-token) and OAuth (seat-based)
- Worker claim/execute/report API flow
- Real-time updates via Pusher
- MCP server for Claude Code integration
- Local UI (Bun) standalone worker runner with web UI
- GitHub App integration for repository management
- Workspace-scoped skills with local scanning and dashboard management
- Agent teams and skills-as-subagents
- Planning mode with plan submission and approval
- Workspace memory system for persistent observations
- Task scheduling with cron support
- Image paste support for task creation
- Worker instructions, git stats tracking
- CI workflows with auto-merge to main
- E2E dogfood tests for dashboard dispatch, lifecycle, and concurrent limits

[Unreleased]: https://github.com/buildd-ai/buildd/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/buildd-ai/buildd/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/buildd-ai/buildd/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/buildd-ai/buildd/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/buildd-ai/buildd/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/buildd-ai/buildd/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/buildd-ai/buildd/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/buildd-ai/buildd/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/buildd-ai/buildd/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/buildd-ai/buildd/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/buildd-ai/buildd/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/buildd-ai/buildd/releases/tag/v0.1.1
