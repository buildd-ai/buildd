# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Display project roots in local-ui settings (was reading wrong field name)

## [0.14.0] - 2026-02-25

### Added

- Repo-based workspace resolution for HTTP MCP server (#197)
- Retry action for failed tasks across web dashboard (#190)
- Connection popover and enhanced empty state in local-ui (#189)
- Tabbed worker detail with Logs, Cost, and Commits tabs in local-ui (#188)
- SQLite history, session archive, and UX improvements in local-ui (#187)
- Claim flow diagnostics and reassign worker awareness (#186)

### Fixed

- Installer and updater use main branch, self-heal corrupted checkouts (#184)
- sync-dev recreates dev branch when auto-deleted after merge
- Pass BUILDD_API_KEY to test instance screen session (CI)

### Changed

- Remove grandfathering patterns and squash migrations (#185)

### Documentation

- Update claude-agent-sdk docs with v0.2.50–v0.2.52 / CLI v2.1.50–v2.1.52 changes

### Tests

- Unit tests for local-ui history store
- Add missing mocks in reassign route tests

## [0.13.0] - 2026-02-22

### Added

- Auto-merge PRs and PR-aware task context (#180)
- UX refinements — onboarding, API key flow, design tokens, smart repo detection (#175)
- Mobile-first UX overhaul for local-ui (#177)
- Custom Select component replacing all native selects (#174)

### Fixed

- Align workspace detail page with design system (#178)
- Add bare .env to gitignore

### Tests

- Project scoping tests (#176)
- Session resume, eviction, and disk persistence tests (#179)

## [0.12.0] - 2026-02-22

### Added

- Start Task mobile UX and View All fixes (#171)
- Version display, safe auto-update & CI version bump (#170)
- Simplify mobile UX — hide header, compact stats, clean detail view
- Streamable HTTP MCP setup in settings with copy-to-clipboard
- Dynamic model list from Anthropic API

### Fixed

- Remove Request Plan button from task detail view (#169)
- Detect offline worker runners via heartbeat and DB cross-reference (#167)

### CI

- Sync dev from main after merges, run integration tests on dev PRs

## [0.11.0] - 2026-02-21

### Added

- MCP server — shared tools, dynamic toolsets, memory CRUD, resources, HTTP server (#161)
- Skills UX overhaul — separate pipelines, slash discovery, mobile form (#160)
- Interactive agent steering — abort, interrupt, plan tracker, action milestones (#159)
- Enforce PR-or-artifact on completion + artifact integration tests (#158)
- Support `background: true` on SDK agent definitions (#151)
- Display permission suggestions in local-ui worker detail view (#148)
- Unify app header and add mobile page headers (#157)

### Fixed

- Remove duplicate hooks and fix blockConfigChanges toggle (#146)

### Documentation

- Update claude-agent-sdk docs with v0.2.49 / CLI v2.1.49 changes (#147)

## [0.10.0] - 2026-02-20

### Added

- Workspace-level artifact addressing with key-based upsert (#143)
- Worktree isolation support for subagent definitions (#124)
- Model capability discovery (SDK v0.2.49) (#123)
- ConfigChange hook for config file audit trail (#121, #127)
- Update 1M context beta references for Sonnet 4.6 support (#122)

### Fixed

- Preserve worktree for session resume on completed workers (#144)
- Add PR dedup checks to prevent double PR creation (#129)
- Clean up test tasks in afterAll to avoid polluting server
- Add dedup protocol to sdk-ecosystem-research skill

### Changed

- Bump @anthropic-ai/claude-agent-sdk pin to >=0.2.49 (#120, #128)

### Documentation

- Update claude-agent-sdk docs with v0.2.49 / CLI v2.1.49 changes (#119)
- Add v0.9.0 release entry to CHANGELOG.md (#125)

### Tests

- Session resume integration test with diagnostics (#131)

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

[Unreleased]: https://github.com/buildd-ai/buildd/compare/v0.14.0...HEAD
[0.14.0]: https://github.com/buildd-ai/buildd/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/buildd-ai/buildd/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/buildd-ai/buildd/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/buildd-ai/buildd/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/buildd-ai/buildd/compare/v0.9.0...v0.10.0
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
