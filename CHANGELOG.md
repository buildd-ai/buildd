# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add missionId filter to list_artifacts MCP action (#696)
- Share a single branch + PR across mission tasks (#698)
- Per-mission maxConcurrentTasks to cap seat consumption (#695)
- Surface seat utilization and deferral reasons in missions UI (#694)
- Seat-aware priority scheduling for cron scheduler (#693)
- Make active hours opt-in and rename to Quiet Hours (#692)
- Smart model routing + release-free model upgrades (#684)
- AI feedback buttons with memory integration (#681)
- Team badges on mission cards + remember last team (#528)

### Changed

- Bump @anthropic-ai/claude-agent-sdk to ^0.2.114

### Fixed

- Fix update_schedule 500 caused by raw workspaceId in PATCH body (#700)
- Ensure bun is on PATH in launcher script for non-interactive shells (#701)
- Dedupe concurrent /missions/:id/run into existing in-flight planner (#687)
- Per-runner cooldown in claim route prevents burn-loop dispatch (#686)
- Scoped claim circuit breaker prevents Pusher-driven burn loop
- Heartbeat missions now complete instead of looping forever (#673)
- Mark ALL working workers as error on startup, not just zero-activity ones (#623)
- Scope secrets by workspace team to prevent cross-team leakage (#529)
- Claim pending tasks on runner startup (#527)
- Use task terminology on task creation page
- Remove task CTA from no-agents state on home page
- Add New Mission CTA to home page, simplify no-agents text
- Restore "Create a task" CTA on home page
- Simplify "no agents running" message on home page

### CI

- Distinguish Claude quota exhaustion from real E2E failures (#688)
- Dump runner/server logs on E2E failure for diagnosis

### Docs

- Add Missions section to CLAUDE.md

## [0.36.2] - 2026-03-11

### Fixed

- Treat workers with deliverables as completed even when SDK errors

## [0.36.1] - 2026-03-11

### Changed

- Drop Vercel from integration tests, run Next.js on Coder (#359)

## [0.36.0] - 2026-03-11

### Added

- Auto-create artifacts on heartbeat/schedule task completion
- Global notification UI for tasks needing input

### Fixed

- Reliable task completion with deliverable-aware resolution + audit trail
- Hide idle workspaces behind quiet count to reduce empty-state noise (sidebar)
- Remove ignoreCommand — let dashboard 'Only build production' control builds
- Make checkWorkerDeliverables a pure function to fix mock collision in CI

### Changed

- Redesign objectives list — drop progress bars, add inline pause toggle, show last deliverable
- Unify card elevation style + remove objectives from tasks sidebar

### CI

- Bump bun to 1.3.10 — fixes mock.module isolation bug
- Write JSON payload to file to avoid shell escaping issues
- Use project-level preview env vars instead of branch-scoped

### Tests

- Inline pure function to avoid mock.module pollution
- Re-register real module to prevent mock.module leak

## [0.35.0] - 2026-03-11

### Added

- Global notification UI for tasks needing input

## [0.34.1] - 2026-03-11

### CI

- Use Vercel API for env vars, skip migrate on preview via VERCEL_ENV

## [0.34.0] - 2026-03-11

### Added

- Unified /app/schedules page + nav entry
- Workspace swim lanes + collapse recurring tasks

### Fixed

- Prevent worker-runner from overwriting completed task status
- Prevent auth() from crashing API routes on preview deploys
- Remove ignoreCommand, use Vercel dashboard 'Only build production' setting
- Use valid UUID for dev mock user id
- Collapsed recurring tiles link to objective instead of last task

### CI

- On-demand Neon branch for integration tests
- Skip db:migrate on CI preview deploys via SKIP_MIGRATE flag
- Pass DATABASE_URL and AUTH_SECRET as runtime env to preview deploy
- Run migrations on Neon clone before deploying preview
- Build Vercel preview locally to guarantee DATABASE_URL
- Detect failed Vercel deployments instead of accepting HTTP 200
- Cleanup both ci/ and preview/ Neon branches, remove redundant neon-preview
- Use regular vercel deploy with SKIP_MIGRATE for previews

## [0.33.0] - 2026-03-10

### Added

- Workspace swim lanes + collapse recurring tasks
- Track public endpoint events via OTEL to Axiom

### Fixed

- Use model aliases instead of hardcoded model IDs in objectives config
- Extract PrLink client component to fix onClick in server component
- Build Vercel previews on PRs, skip plain branch pushes
- Only build production on Vercel, skip all preview deploys

### Changed

- Bump @anthropic-ai/claude-agent-sdk to 0.2.72
- Remove disabled preview-tests workflow

### CI

- On-demand Neon branches per PR, remove shared dev branch
- Use Vercel API v10 for env creation

## [0.32.1] - 2026-03-09

### Fixed

- Return 405 for MCP GET/SSE endpoint to stop polling loop

## [0.32.0] - 2026-03-09

### Added

- Worker recovery system with server-orchestrated diagnose/complete/restart
- Adaptive idle timeout and graduated stale recovery (runner)
- Replace empty tasks index with visual task grid
- Desktop top nav with centered links, hide bottom nav on md+

### Documentation

- Weekly SDK ecosystem research update (2026-03-09)
- Add claude-code-by-agents assessment to SDK ecosystem research

### CI

- Deploy preview to Vercel before integration tests
- Use --yes instead of deprecated --confirm for vercel deploy
- Extract Vercel deploy URL with grep instead of tail

## [0.31.0] - 2026-03-08

### Added

- Heartbeat objective fields for MCP manage_objectives action
- Heartbeat objectives with smart suppression, active hours, and checklist protocol
- Enhance objectives with editable fields, scheduling wizard, run-now, one-shot schedules, and config panel
- Redesign objective detail with markdown rendering and structured layout

### Fixed

- Add planner dedup guidance and repetitive result detection to objective context

## [0.30.0] - 2026-03-08

### Added

- Axiom dependency for OTEL trace export (#326)
- In-memory caching for API auth and workspace permissions (#324)
- Periodic reconciliation of local workers against remote state (#321)
- Configurable inputPolicy for worker communication (#323)

### Fixed

- Block AskUserQuestion in autonomous mode via PreToolUse hook (#328)
- Narrow proxy.ts matcher to install paths only
- Update app.buildd.dev URLs to buildd.dev (#325)
- Enable Layer 2 fallthrough when SDK resume fails on worker input response (#322)
- Prevent duplicate worker claims on same task (#320)

### Documentation

- Update testing docs to reflect current state (#319)

### CI

- Only run integration tests on PRs to main

## [0.29.0] - 2026-03-08

_Release PR only — no additional changes._

## [0.28.0] - 2026-03-08

_Release PR only — no additional changes._

## [0.27.0] - 2026-03-08

### Added

- Active objective planning loop with model routing (#299)
- Objectives UI — inline cron editor and bottom nav (#300)

## [0.26.0] - 2026-03-08

### Added

- Runner workspace header button and replace native selects with custom dropdowns (#297)

### Fixed

- Runner: normalize GitHub slugs to full URLs when cloning workspaces

### Tests

- Gracefully handle 429 when server count exceeds pre-flight check in concurrency test
- Skip remaining tests gracefully if runner becomes unavailable mid-test

## [0.25.0] - 2026-03-07

### Added

- Integrate objectives as core UI element across dashboard, sidebar, and task creation (#290)
- Pusher channel prefix and workspace info in task payload (#293)
- Buildd-workflow skill for agent task lifecycle (#292)
- Pushover notifications for task lifecycle and split apps
- Alert via Pushover on large API payloads (>100KB)
- Vercel OpenTelemetry instrumentation with payload size tracking

### Fixed

- Reduce GET /api/tasks payload from ~1MB to ~few KB (#295)
- Fetch single task instead of full list for claim/reassign (#296)
- Improve claim error message with workspace/task context
- Add missing WorkflowSelector component
- Resolve Drizzle relation ambiguity breaking objectives detail page (#291)
- Runner: use -B flag for branch checkout in shallow clones

### CI

- Pass secrets via env instead of relying on container env vars
- Run branch code instead of stale global binary for E2E tests
- Remove buildd-preview kill (no longer runs on Coder)

## [0.24.0] - 2026-03-07

### Added

- Runner: support BUILDD_BRANCH env var for tracking non-main branches (#288)
- Runner: support custom BUILDD_HOME directory (#287)

### Fixed

- Runner: exit with code 75 after update so launcher restarts (#286)

## [0.23.0] - 2026-03-07

### Added

- Runner: add POST /api/workers/purge to clear completed workers (#283)

### Fixed

- Runner: fetch before changelog check so auto-update works (#281)

### Changed

- Bump @anthropic-ai/claude-agent-sdk to >=0.2.71
- Remove workflow UI, expose as MCP resource for agents (#284)

## [0.22.1] - 2026-03-07

### Fixed

- Runner: queue server 5xx errors in outbox for retry
- Runner: prevent ghost workers and log spam from unresolvable workspaces
- Always broadcast TASK_ASSIGNED to local runners
- Prevent ghost workers stuck in "running" state on server

## [0.22.0] - 2026-03-06

### Added

- Refine creation flows and UI/UX improvements (#272)

### Fixed

- Move dependency filtering into SQL query in claim endpoint (#273)
- Improve visual polish and color consistency (#271)

## [0.21.1] - 2026-03-06

### Fixed

- Resolve MCP memory client via account teamId fallback (#269)
- Remove runner detail tabs and hide zero cost

## [0.21.0] - 2026-03-06

### Added

- Auto-close tasks on PR merge — new pull_request webhook handler (#265)
- MCP update_task status updates for tasks without active workers (#265)
- Hide worker-only fields for trigger token accounts (#267)

### Fixed

- Flaky concurrency test — account for existing active workers (#265)

## [0.20.0] - 2026-03-06

### Added

- Auto-resolve workspace for API task creation (#264)
- Trigger token level for service accounts (#262)
- Allow workspace binding during account creation (#263)

### Fixed

- Resolve workerId from context when not passed explicitly (#259)
- Normalize priority strings to integers in MCP tools

### Changed

- Simplify skills feature — remove scan/sync, CLI, and Pusher install (#260)

## [0.19.0] - 2026-03-06

### Added

- MCP workspace resolution by repo name and aggregate list tools (#247)

### Fixed

- Prevent auto-mode output validation from blocking task completion
- Objectives page error handling and status filter
- Prevent waiting_input options from reappearing after answer sent

### Changed

- Bump @anthropic-ai/claude-agent-sdk to >=0.2.70

## [0.18.2] - 2026-03-05

### Fixed

- Resolve MCP workspace for create_task (#245)

## [0.18.1] - 2026-03-05

### Added

- Enrich objectives UI with create form, activity feed, and artifacts (#239)

### Fixed

- Sync main into dev before creating release PR (#238)

### Tests

- Handle flaky task completion assertion on preview deploys
- Remove obsolete heartbeat checklist test and fix artifact race
- Add missing beforeAll timeouts in integration tests
- Retry claim with taskId in worker-state-machine beforeAll
- Retry runner connection in integration-config beforeAll

## [0.18.0] - 2026-03-05

### Added

- First-class objectives replacing heartbeat checklist (#236)
- Replace GitHub native auto-merge with Buildd-managed merging (#235)
- Workspace management improvements (#232)

### Fixed

- Exclude waiting_input workers from stale expiry (#234)
- Auto-detect PRs on worker completion and validate before task update (#233)
- Update banner overlapping header and auto-update not triggering in runner (#231)
- Deduplicate heartbeat checklist and improve UX in settings (#227)
- Remove erroneous `--` separator from MCP install commands (#230)

### Changed

- Bump @anthropic-ai/claude-agent-sdk to >=0.2.68 (#229)

### CI

- Force-reset dev to main when ff-only fails (#225)

### Documentation

- Weekly SDK ecosystem research (Mar 4, 2026) (#228)

## [0.17.0] - 2026-03-03

### Added

- Planning mode UX, blocked task display, and runner indicators (#222)
- Phase 5 artifact expansion + Phase 6 Slack and Discord gateway (#218)
- Phase 4 task recipes (#217)
- Phase 3 heartbeat + dependency selector UI (#216)
- Phase 1+2 aggregation, MCP tools, plan review UI, and dependency display (#215)
- Planning loop and workflow DAG support

### Fixed

- Display project roots in local-ui settings (was reading wrong field name)
- Make migrations idempotent to prevent deploy failures (#220)
- Remove duplicate migration files from Phase 5+6 merge (#219)

### Tests

- Add Phase 3-6 verification tests (#221)

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

[Unreleased]: https://github.com/buildd-ai/buildd/compare/v0.36.2...HEAD
[0.36.2]: https://github.com/buildd-ai/buildd/compare/v0.36.1...v0.36.2
[0.36.1]: https://github.com/buildd-ai/buildd/compare/v0.36.0...v0.36.1
[0.36.0]: https://github.com/buildd-ai/buildd/compare/v0.35.0...v0.36.0
[0.35.0]: https://github.com/buildd-ai/buildd/compare/v0.34.1...v0.35.0
[0.34.1]: https://github.com/buildd-ai/buildd/compare/v0.34.0...v0.34.1
[0.34.0]: https://github.com/buildd-ai/buildd/compare/v0.33.0...v0.34.0
[0.33.0]: https://github.com/buildd-ai/buildd/compare/v0.32.1...v0.33.0
[0.32.1]: https://github.com/buildd-ai/buildd/compare/v0.32.0...v0.32.1
[0.32.0]: https://github.com/buildd-ai/buildd/compare/v0.31.0...v0.32.0
[0.31.0]: https://github.com/buildd-ai/buildd/compare/v0.30.0...v0.31.0
[0.30.0]: https://github.com/buildd-ai/buildd/compare/v0.29.0...v0.30.0
[0.29.0]: https://github.com/buildd-ai/buildd/compare/v0.28.0...v0.29.0
[0.28.0]: https://github.com/buildd-ai/buildd/compare/v0.27.0...v0.28.0
[0.27.0]: https://github.com/buildd-ai/buildd/compare/v0.26.0...v0.27.0
[0.26.0]: https://github.com/buildd-ai/buildd/compare/v0.25.0...v0.26.0
[0.25.0]: https://github.com/buildd-ai/buildd/compare/v0.24.0...v0.25.0
[0.24.0]: https://github.com/buildd-ai/buildd/compare/v0.23.0...v0.24.0
[0.23.0]: https://github.com/buildd-ai/buildd/compare/v0.22.1...v0.23.0
[0.22.1]: https://github.com/buildd-ai/buildd/compare/v0.22.0...v0.22.1
[0.22.0]: https://github.com/buildd-ai/buildd/compare/v0.21.1...v0.22.0
[0.21.1]: https://github.com/buildd-ai/buildd/compare/v0.21.0...v0.21.1
[0.21.0]: https://github.com/buildd-ai/buildd/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/buildd-ai/buildd/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/buildd-ai/buildd/compare/v0.18.2...v0.19.0
[0.18.2]: https://github.com/buildd-ai/buildd/compare/v0.18.1...v0.18.2
[0.18.1]: https://github.com/buildd-ai/buildd/compare/v0.18.0...v0.18.1
[0.18.0]: https://github.com/buildd-ai/buildd/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/buildd-ai/buildd/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/buildd-ai/buildd/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/buildd-ai/buildd/compare/v0.14.0...v0.15.0
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
