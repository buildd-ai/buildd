# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]


## [0.180.0] - 2026-08-27

### Changed

- Reframe `create_task` pending status as queued with `get_task` hint

### Added

- Initiative verdict derivation — motion ladder + confidence for surface IA (#1707)
- Concurrency cap UX — queue messaging, one-time cap override, raise-limit stepper, MCP exposure (#1675)
- Execution attempt nesting — CI retries and reviewer runs nest under parent task in Activity and mission progress (#1674)
- Subagent span persistence at worker completion; expose backgroundAgentMs for mission agent-time (#1656)
- Serialize concurrent agents to prevent PR collisions in orchestrator
- Agent-facing task observability — `get_task` action + OAuth artifact reads via MCP
- Connect Claude card with copy-paste connector setup in settings
- claude.ai connector via workspace-scoped MCP OAuth
- Make routines discoverable via trigger/worker tokens in MCP
- `get_skill` action to read full skill body by slug via MCP

### Fixed

- MobilePageHeader right-side cluster overflows at 320pt (#1821)
- Suppress redundant in-page h1 title on Missions, Activity, Health, and Team (#1820)
- Budget Forecast honesty — confidence label and learning rows (#1822)
- TeamGrid header scaling at 320pt viewport (#1819)
- Initiative thrash count: pass task mode to deriveTaskType correctly (#1709)
- Spawned builder tasks count as deliverables, not attempts (#1706)
- Runner writes .credentials.json in the shape Claude Code expects (#1682)
- Budget reset-time parser honours timezone and stops rollover overshoot (#1681)
- Task page crash on label-stripped milestones (#1680)
- Activity feed NULLS-FIRST ordering + archived missions filling limit (re-fix)
- Auto-link githubRepoId when updating workspace repoUrl via API
- Scoped claim circuit breaker prevents Pusher-driven burn loop
- Use task terminology on task creation page
- Remove task CTA from no-agents state on home page
- Add New Mission CTA to home page, simplify no-agents text
- Restore "Create a task" CTA on home page
- Simplify "no agents running" message on home page

### CI

- Visual QA PR runs label-gated behind 'visual-qa' label
- Dump runner/server logs on E2E failure for diagnosis

### Docs

- Add Missions section to CLAUDE.md
## [0.168.0] - 2026-08-16

### Added

- Activity grouping model — StageChip, GroupSection, DependencyRail, MissionProgressBar components (#1699)

### Changed

- Initiative effort loader consolidated into single shared path (#1701)

### Fixed

- NOT_EVALUATED verdict for description criteria; fix all_prs_merged default (#1705)
- Reopen completed mission when open work is added (latch fix) (#1704)
- Connector token aud validated against declared resource identifier (#1703)
- computeMissionProgress no longer collapses execution-mode tasks (#1702)
- Attempt tasks excluded from team role stats and health usage counts (#1695)

### Docs

- Surface IA spec — Home, Missions, Initiatives (#1700)
## [0.167.0] - 2026-08-15

### Added

- Auto-dispatch conflict-resolution task when PR has merge conflicts (#1689)
- Dark-check detection — alert when required CI check consistently skips and bypasses merge gates (#1688)
- Near-duplicate open task surface in MCP create_task response (#1692)
- Task type badge glyph replacing title-prefix convention (#1684)
- MCP warning when update_task material edit lands on active worker (#1686)

### Changed

- Activity IA controls consolidated — single chip row with initiative scope, Group dropdown removed (#1685)

### Fixed

- MCP validates UUID format on taskId parameters (#1694)
- Activity Re-runs/Reviews chips match legacy attempt tasks (#1693)
- Mission card status collapsed to one pill; removed redundant progress% and task count (#1691)
- Dedupe large-payload alert via reportOps; server-side pagination on GET /api/tasks (#1687)
- Deferral reasons sticky — stale badge, no re-arm, wrong mission grouping all fixed (#1683)
- Release activeSessions seat on every terminal worker transition (#1678)
- Replace 30s countdown with optimistic start handshake on task claim (#1677)
## [0.166.0] - 2026-08-14

### Added

- Change-intent mechanism — pre-flight lock on shared surfaces (schema, migrations, lockfiles) to prevent concurrent PR collisions (#1671)
- Read-through PR merge-state reconciliation, no cron needed (#1657, #1659, #1664)
- Mission skyline chart replacing progress bar on completed mission cards (#1660, #1661)
- Initiative triage surface refinements (#1654)
- Initiative triage surface with effort sparklines: SparklineBar component, /api/initiatives/effort endpoint, InitiativeTriageRow and InitiativeTriage components (#1647, #1648, #1649, #1650)
- Tier-first ModelPicker replacing hardcoded model selects (#1599)
- LLM-based goalCriteria evaluation — evidence assembly + description type (#1592)
- Runner-anchored credential broker Phase 2: Postgres leases, unix-socket token endpoint, and bootstrap credential pull (#1624, #1632, #1639)
- Broker-driven worker credential injection live path (#1641)
- Lease-expiry-guard — alert + optional fallback refresh on runner death (#1634)
- Periodic credential-refresh sweep and runner-offline guard for runners (#1619, #1620)
- Gate direct credential refresh loops behind BUILDD_ALLOW_CONTROL_PLANE_REFRESH flag (#1621)
- runner/credential-refresh control-plane endpoint (#1617)
- merge_pr + get_pr MCP actions with GitHub App merge 403 fix (#1612)

### Changed

- Memory recall unified across memory and task corpus; legacy summary corpus cleaned (#1670)
- Replace InitiativesStrip double-render with InitiativeTriage surface (#1650)
- Health page signal-first restructure, remove Watched Projects section (#1578)
- Remove server-side claim-gate refresh; runner is now sole credential refresh origin (#1622)

### Fixed

- Retry workers resume existing branch instead of cutting a fresh one (#1667)
- PR live-refresh: stamp prLastCheckedAt, log errors, cap and dedup concurrent refreshes (#1665)
- Promote task to completed when heartbeat-expired worker has delivered a PR (#1594)
- Exclude revoked Codex credentials from fallback candidate check (#1640)
- Register lease-expiry-guard in vercel.json + await notifyTeam (#1638)
- Confirm-state overlaps card content on mobile (#1629)
- Surface PR number on escalation cards and task detail (#1628)
- Home screen merge panel, initiative rail, and right-now card layout on mobile (#1627)
- Activity view header + task row readability on mobile (#1625)
- Goal criteria rows now show descriptions and are tappable on mobile (#1623)
- Content-hash dedup for PR corpus to eliminate cross-PR near-duplicates (#1618)
- Runner CBM memory budget bumped from 512 to 1024 MB (#1613)
## [0.163.0] - 2026-08-09

### Added

- GET /api/models route with Anthropic model list (#1598)
- Recency signals on missions/initiatives landing page (#1593)

### Fixed

- Initiative status uses DB lifecycle, not rollup from mission counts (#1596)
## [0.162.0] - 2026-08-06

### Added

- enforceGreenCI workspace policy + mergeable_state check (#1571)
- Priority indicator on mission cards, move detail header to inline edit (#1569)
- Flatten mission Settings IA, fix contrast on mission config panel (#1568)
- Initiative-mission linkage UI (#1567)
- Add per-task CBM observability metrics (#1559)
- Enforce codebase-memory MCP as default across all repo-backed roles (#1555, #1556)
- Build CBM index during worker bootstrap (#1551)

### Fixed

- Define ack/dismiss actions in activity feed, add swipe affordance, and declutter rows (#1563)
- Eliminate trailing-action / ⋯ menu overlap in SwipeableRow (#1558)
- Resolve PR merge "Not Found" via githubRepos path, guard against workspace ambiguity (#1557)
## [0.157.0] - 2026-07-30

### Added

- Subject anchors 6/7 — dead-PR shutdown behind autoCloseBuilddSupersededPrs flag (#1507)
- Subject anchors 5/7 — reconciliation sweep and pre-claim liveness gate (#1506)

### Fixed

- Update @openai/codex-sdk to ^0.146.0 (#1505)
## [0.155.0] - 2026-07-26

### Added

- Surface 403 GitHub App permission gap as connector_permission_insufficient (#1501)

### Fixed

- Terminate agent review leases safely (#1487)
## [0.149.0] - 2026-07-22

### Added

- Add status badge to Activity feed rows (#1377)
- Infer pathManifest on friction tasks at creation time (#1380)

### Fixed

- Scope MCP list_tasks and openclaw fetches to active/workspace (#1386)
- Scope GET /api/tasks by workspace and status (#1386)
- Closed PRs no longer block dependent tasks or overlap-guard siblings (#1384)
## [0.140.0] - 2026-07-19

### Added

- Mount TaskCard across Home, Activity, and Mission timeline with consistent chain, health, and worker data (#1309)

### Fixed

- Suppress schedule countdown and ON SCHEDULE badge for manual-mode missions (#1312)
- Decouple Codex-backend workers from Claude OAuth token to prevent cross-backend auth failures (#1308)
- Use refresh grant to verify Codex OAuth credentials instead of GET /v1/models (#1305)
- Runner worktree disambiguation and split claim error messages (#1304)

### CI

- Remove deprecated spec-sync workflow — knowledge-ingest supersedes it (#1311)
## [0.134.2] - 2026-07-16

### Fixed

- Deduplicate code corpus during knowledge ingest with hash-skip and backfill enqueue guard (#1220)
## [0.134.0] - 2026-07-13

### Added

- Work-tracker outbound dispatch for GitHub issues via GitHub App — closes linked issues and posts completion comments without a separate connector (#1201)
## [0.126.2] - 2026-07-09

### Fixed

- Fix all 5 seed bugs at 390px viewport (#1105)
- Truncate long team names in TeamSwitcher header (#1094)
## [0.124.1] - 2026-07-05

### Fixed

- Migration 0061 made idempotent to unblock prod deploys (#1062)
## [0.124.0] - 2026-07-05

### Changed

- Cross-page visual consistency pass across web app (#1063)

### Added

- Missions 'Awaiting review' group + 24h auto-archive for done missions (#1065)
- Schedules section on Health page with duplicate-cron detection (#1061)
## [0.122.0] - 2026-06-27

### Fixed

- Home screen hides archived missions and caps activity feed at 50; NULLS-FIRST ordering (#1048)
- Idle missions now visible on home screen; activity feed ordering restored (#1048)
- Visual QA: Playwright 1.61 compat, workflow_dispatch crash, judge via buildd, prod-clone Neon (#1049)

### CI

- Visual QA ephemeral Neon branch clones sanitized prod data (#1049)
## [0.119.1] - 2026-06-25

### Fixed

- Skip release when artifact_required is satisfied by artifact alone (#989)

### CI

- Exit gracefully when DATABASE_URL is not set in knowledge ingest (#987)
## [0.115.0] - 2026-06-22

### CI

- Pass release App private key to reusable release workflow (#923)
## [0.108.0] - 2026-06-20

### Changed

- Bump @anthropic-ai/claude-agent-sdk to ^0.3.179 (#861)

### Fixed

- Fix Codex runner backend (#859)
## [0.105.0] - 2026-06-15

### Added

- Pluggable AgentBackend abstraction with Claude and Codex support (#826)

### Fixed

- Send heartbeat on task claim to close stale-on-claim worker-kill edge (#830)
- Full-bleed app icon across all surfaces, removing white side bars (#833)
## [0.104.0] - 2026-06-14

### Removed

- Recipe concept from frontend, onboarding checklist, mission config, and integration tests (#804)

### Changed

- Bump @anthropic-ai/claude-agent-sdk to ^0.3.177 (#820)

### Added

- Back api-key auth and account-workspace cache with Redis L2 (#821)
## [0.99.0] - 2026-06-03

### Added

- Capture agent error traces from tool output (#780)
## [0.98.0] - 2026-05-25

### Fixed

- Prevent multi-workspace OAuth misrouting (#779)
- Require explicit workspaceId for ambiguous OAuth actions (#778)
- Stop infinite retry loop on misrouted tasks (#777)
- Post-store CTA pointing users to /app/health (#775)
- Collapse Vercel "Add a token" form once a token exists (#774)
## [0.97.1] - 2026-05-24

### Fixed

- Await waiting_input sync; collapsible task descriptions in runner (#765)
## [0.97.0] - 2026-05-24

### Added

- `/respond` landing page + render needs-input banner on failed workers (#763)
## [0.96.0] - 2026-05-24

### Fixed

- Push URL → buildd.dev + restore broken GitHub repo sync (#761)
- Make connector icons render as a square (#755)
## [0.95.1] - 2026-05-24

### Fixed

- Advertise canonical buildd.dev as issuer on Vercel prod for OAuth (#753)
## [0.95.0] - 2026-05-24

### Fixed

- Resolve Claude Code native binary explicitly via SDK package dir (#750)
## [0.87.0] - 2026-04-25

### Added

- Emit per-minute liveness heartbeat to runner stdout (#709)
- Add missionId filter to list_artifacts MCP action (#696)

### Changed

- Bump @anthropic-ai/claude-agent-sdk to ^0.2.119 (#708)

### Fixed

- Fix update_schedule 500 caused by raw workspaceId in PATCH body (#700)
- Ensure bun is on PATH in launcher script for non-interactive shells (#701)
## [0.86.0] - 2026-04-17

### Added

- Share a single branch + PR across mission tasks (#698)
- Per-mission maxConcurrentTasks to cap seat consumption (#695)
- Surface seat utilization and deferral reasons in missions UI (#694)
- Seat-aware priority scheduling for cron scheduler (#693)
- Make active hours opt-in and rename to Quiet Hours (#692)
- Smart model routing + release-free model upgrades (#684)
- AI feedback buttons with memory integration (#681)

### Fixed

- Dedupe concurrent /missions/:id/run into existing in-flight planner (#687)
- Per-runner cooldown in claim route prevents burn-loop dispatch (#686)
- Heartbeat missions now complete instead of looping forever (#673)

### CI

- Distinguish Claude quota exhaustion from real E2E failures (#688)
## [0.69.1] - 2026-04-08

### Fixed

- Mark ALL working workers as error on startup, not just zero-activity ones (#623)
## [0.59.0] - 2026-03-25

### Added

- Team badges on mission cards + remember last team (#528)

### Fixed

- Scope secrets by workspace team to prevent cross-team leakage (#529)
- Claim pending tasks on runner startup (#527)
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
[0.36.2]: https://github.com/buildd-ai/buildd/compare/v0.36.1...v0.36.2[0.36.0]: https://github.com/buildd-ai/buildd/compare/v0.35.0...v0.36.0[0.34.1]: https://github.com/buildd-ai/buildd/compare/v0.34.0...v0.34.1[0.33.0]: https://github.com/buildd-ai/buildd/compare/v0.32.1...v0.33.0[0.32.0]: https://github.com/buildd-ai/buildd/compare/v0.31.0...v0.32.0[0.30.0]: https://github.com/buildd-ai/buildd/compare/v0.29.0...v0.30.0[0.28.0]: https://github.com/buildd-ai/buildd/compare/v0.27.0...v0.28.0[0.26.0]: https://github.com/buildd-ai/buildd/compare/v0.25.0...v0.26.0[0.24.0]: https://github.com/buildd-ai/buildd/compare/v0.23.0...v0.24.0[0.22.1]: https://github.com/buildd-ai/buildd/compare/v0.22.0...v0.22.1[0.21.1]: https://github.com/buildd-ai/buildd/compare/v0.21.0...v0.21.1[0.20.0]: https://github.com/buildd-ai/buildd/compare/v0.19.0...v0.20.0[0.18.2]: https://github.com/buildd-ai/buildd/compare/v0.18.1...v0.18.2[0.18.0]: https://github.com/buildd-ai/buildd/compare/v0.17.0...v0.18.0[0.16.0]: https://github.com/buildd-ai/buildd/compare/v0.15.0...v0.16.0[0.14.0]: https://github.com/buildd-ai/buildd/compare/v0.13.0...v0.14.0[0.12.0]: https://github.com/buildd-ai/buildd/compare/v0.11.0...v0.12.0[0.10.0]: https://github.com/buildd-ai/buildd/compare/v0.9.0...v0.10.0[0.8.0]: https://github.com/buildd-ai/buildd/compare/v0.7.0...v0.8.0[0.6.0]: https://github.com/buildd-ai/buildd/compare/v0.5.0...v0.6.0[0.4.0]: https://github.com/buildd-ai/buildd/compare/v0.3.2...v0.4.0[0.3.1]: https://github.com/buildd-ai/buildd/compare/v0.3.0...v0.3.1[0.2.0]: https://github.com/buildd-ai/buildd/compare/v0.1.1...v0.2.0

[Unreleased]: https://github.com/buildd-ai/buildd/compare/v0.180.0...HEAD
[0.180.0]: https://github.com/buildd-ai/buildd/compare/v0.179.0...v0.180.0
[0.179.0]: https://github.com/buildd-ai/buildd/compare/v0.178.0...v0.179.0
[0.178.0]: https://github.com/buildd-ai/buildd/compare/v0.177.0...v0.178.0
[0.177.0]: https://github.com/buildd-ai/buildd/compare/v0.176.0...v0.177.0
[0.176.0]: https://github.com/buildd-ai/buildd/compare/v0.175.0...v0.176.0
[0.175.0]: https://github.com/buildd-ai/buildd/compare/v0.174.0...v0.175.0
[0.174.0]: https://github.com/buildd-ai/buildd/compare/v0.173.0...v0.174.0
[0.173.0]: https://github.com/buildd-ai/buildd/compare/v0.172.1...v0.173.0
[0.172.1]: https://github.com/buildd-ai/buildd/compare/v0.172.0...v0.172.1
[0.172.0]: https://github.com/buildd-ai/buildd/compare/v0.171.0...v0.172.0
[0.171.0]: https://github.com/buildd-ai/buildd/compare/v0.170.1...v0.171.0
[0.170.1]: https://github.com/buildd-ai/buildd/compare/v0.170.0...v0.170.1
[0.170.0]: https://github.com/buildd-ai/buildd/compare/v0.169.0...v0.170.0
[0.169.0]: https://github.com/buildd-ai/buildd/compare/v0.168.0...v0.169.0
[0.168.0]: https://github.com/buildd-ai/buildd/compare/v0.167.1...v0.168.0
[0.167.1]: https://github.com/buildd-ai/buildd/compare/v0.167.0...v0.167.1
[0.167.0]: https://github.com/buildd-ai/buildd/compare/v0.166.0...v0.167.0
[0.166.0]: https://github.com/buildd-ai/buildd/compare/v0.165.0...v0.166.0
[0.165.0]: https://github.com/buildd-ai/buildd/compare/v0.164.0...v0.165.0
[0.164.0]: https://github.com/buildd-ai/buildd/compare/v0.163.0...v0.164.0
[0.163.0]: https://github.com/buildd-ai/buildd/compare/v0.162.2...v0.163.0
[0.162.2]: https://github.com/buildd-ai/buildd/compare/v0.162.1...v0.162.2
[0.162.1]: https://github.com/buildd-ai/buildd/compare/v0.162.0...v0.162.1
[0.162.0]: https://github.com/buildd-ai/buildd/compare/v0.161.0...v0.162.0
[0.161.0]: https://github.com/buildd-ai/buildd/compare/v0.160.0...v0.161.0
[0.160.0]: https://github.com/buildd-ai/buildd/compare/v0.159.0...v0.160.0
[0.159.0]: https://github.com/buildd-ai/buildd/compare/v0.158.0...v0.159.0
[0.158.0]: https://github.com/buildd-ai/buildd/compare/v0.157.0...v0.158.0
[0.157.0]: https://github.com/buildd-ai/buildd/compare/v0.156.0...v0.157.0
[0.156.0]: https://github.com/buildd-ai/buildd/compare/v0.155.0...v0.156.0
[0.155.0]: https://github.com/buildd-ai/buildd/compare/v0.154.0...v0.155.0
[0.154.0]: https://github.com/buildd-ai/buildd/compare/v0.153.0...v0.154.0
[0.153.0]: https://github.com/buildd-ai/buildd/compare/v0.152.0...v0.153.0
[0.152.0]: https://github.com/buildd-ai/buildd/compare/v0.151.2...v0.152.0
[0.151.2]: https://github.com/buildd-ai/buildd/compare/v0.151.1...v0.151.2
[0.151.1]: https://github.com/buildd-ai/buildd/compare/v0.151.0...v0.151.1
[0.151.0]: https://github.com/buildd-ai/buildd/compare/v0.150.0...v0.151.0
[0.150.0]: https://github.com/buildd-ai/buildd/compare/v0.149.0...v0.150.0
[0.149.0]: https://github.com/buildd-ai/buildd/compare/v0.148.0...v0.149.0
[0.148.0]: https://github.com/buildd-ai/buildd/compare/v0.147.0...v0.148.0
[0.147.0]: https://github.com/buildd-ai/buildd/compare/v0.146.0...v0.147.0
[0.146.0]: https://github.com/buildd-ai/buildd/compare/v0.145.1...v0.146.0
[0.145.1]: https://github.com/buildd-ai/buildd/compare/v0.145.0...v0.145.1
[0.145.0]: https://github.com/buildd-ai/buildd/compare/v0.144.0...v0.145.0
[0.144.0]: https://github.com/buildd-ai/buildd/compare/v0.143.2...v0.144.0
[0.143.2]: https://github.com/buildd-ai/buildd/compare/v0.143.1...v0.143.2
[0.143.1]: https://github.com/buildd-ai/buildd/compare/v0.143.0...v0.143.1
[0.143.0]: https://github.com/buildd-ai/buildd/compare/v0.142.0...v0.143.0
[0.142.0]: https://github.com/buildd-ai/buildd/compare/v0.141.1...v0.142.0
[0.141.1]: https://github.com/buildd-ai/buildd/compare/v0.141.0...v0.141.1
[0.141.0]: https://github.com/buildd-ai/buildd/compare/v0.140.0...v0.141.0
[0.140.0]: https://github.com/buildd-ai/buildd/compare/v0.139.0...v0.140.0
[0.139.0]: https://github.com/buildd-ai/buildd/compare/v0.138.2...v0.139.0
[0.138.2]: https://github.com/buildd-ai/buildd/compare/v0.138.1...v0.138.2
[0.138.1]: https://github.com/buildd-ai/buildd/compare/v0.138.0...v0.138.1
[0.138.0]: https://github.com/buildd-ai/buildd/compare/v0.137.0...v0.138.0
[0.137.0]: https://github.com/buildd-ai/buildd/compare/v0.136.0...v0.137.0
[0.136.0]: https://github.com/buildd-ai/buildd/compare/v0.135.0...v0.136.0
[0.135.0]: https://github.com/buildd-ai/buildd/compare/v0.134.3...v0.135.0
[0.134.3]: https://github.com/buildd-ai/buildd/compare/v0.134.2...v0.134.3
[0.134.2]: https://github.com/buildd-ai/buildd/compare/v0.134.1...v0.134.2
[0.134.1]: https://github.com/buildd-ai/buildd/compare/v0.134.0...v0.134.1
[0.134.0]: https://github.com/buildd-ai/buildd/compare/v0.133.0...v0.134.0
[0.133.0]: https://github.com/buildd-ai/buildd/compare/v0.132.0...v0.133.0
[0.132.0]: https://github.com/buildd-ai/buildd/compare/v0.131.0...v0.132.0
[0.131.0]: https://github.com/buildd-ai/buildd/compare/v0.130.0...v0.131.0
[0.130.0]: https://github.com/buildd-ai/buildd/compare/v0.129.1...v0.130.0
[0.129.1]: https://github.com/buildd-ai/buildd/compare/v0.129.0...v0.129.1
[0.129.0]: https://github.com/buildd-ai/buildd/compare/v0.128.0...v0.129.0
[0.128.0]: https://github.com/buildd-ai/buildd/compare/v0.127.0...v0.128.0
[0.127.0]: https://github.com/buildd-ai/buildd/compare/v0.126.2...v0.127.0
[0.126.2]: https://github.com/buildd-ai/buildd/compare/v0.126.1...v0.126.2
[0.126.1]: https://github.com/buildd-ai/buildd/compare/v0.126.0...v0.126.1
[0.126.0]: https://github.com/buildd-ai/buildd/compare/v0.125.0...v0.126.0
[0.125.0]: https://github.com/buildd-ai/buildd/compare/v0.124.1...v0.125.0
[0.124.1]: https://github.com/buildd-ai/buildd/compare/v0.124.0...v0.124.1
[0.124.0]: https://github.com/buildd-ai/buildd/compare/v0.123.0...v0.124.0
[0.123.0]: https://github.com/buildd-ai/buildd/compare/v0.122.0...v0.123.0
[0.122.0]: https://github.com/buildd-ai/buildd/compare/v0.121.0...v0.122.0
[0.121.0]: https://github.com/buildd-ai/buildd/compare/v0.120.1...v0.121.0
[0.120.1]: https://github.com/buildd-ai/buildd/compare/v0.120.0...v0.120.1
[0.120.0]: https://github.com/buildd-ai/buildd/compare/v0.119.2...v0.120.0
[0.119.2]: https://github.com/buildd-ai/buildd/compare/v0.119.1...v0.119.2
[0.119.1]: https://github.com/buildd-ai/buildd/compare/v0.119.0...v0.119.1
[0.119.0]: https://github.com/buildd-ai/buildd/compare/v0.118.0...v0.119.0
[0.118.0]: https://github.com/buildd-ai/buildd/compare/v0.117.0...v0.118.0
[0.117.0]: https://github.com/buildd-ai/buildd/compare/v0.116.2...v0.117.0
[0.116.2]: https://github.com/buildd-ai/buildd/compare/v0.116.1...v0.116.2
[0.116.1]: https://github.com/buildd-ai/buildd/compare/v0.116.0...v0.116.1
[0.116.0]: https://github.com/buildd-ai/buildd/compare/v0.115.0...v0.116.0
[0.115.0]: https://github.com/buildd-ai/buildd/compare/v0.114.0...v0.115.0
[0.114.0]: https://github.com/buildd-ai/buildd/compare/v0.113.0...v0.114.0
[0.113.0]: https://github.com/buildd-ai/buildd/compare/v0.112.0...v0.113.0
[0.112.0]: https://github.com/buildd-ai/buildd/compare/v0.111.0...v0.112.0
[0.111.0]: https://github.com/buildd-ai/buildd/compare/v0.110.0...v0.111.0
[0.110.0]: https://github.com/buildd-ai/buildd/compare/v0.109.0...v0.110.0
[0.109.0]: https://github.com/buildd-ai/buildd/compare/v0.108.0...v0.109.0
[0.108.0]: https://github.com/buildd-ai/buildd/compare/v0.107.1...v0.108.0
[0.107.1]: https://github.com/buildd-ai/buildd/compare/v0.107.0...v0.107.1
[0.107.0]: https://github.com/buildd-ai/buildd/compare/v0.106.0...v0.107.0
[0.106.0]: https://github.com/buildd-ai/buildd/compare/v0.105.0...v0.106.0
[0.105.0]: https://github.com/buildd-ai/buildd/compare/v0.104.1...v0.105.0
[0.104.1]: https://github.com/buildd-ai/buildd/compare/v0.104.0...v0.104.1
[0.104.0]: https://github.com/buildd-ai/buildd/compare/v0.103.0...v0.104.0
[0.103.0]: https://github.com/buildd-ai/buildd/compare/v0.102.0...v0.103.0
[0.102.0]: https://github.com/buildd-ai/buildd/compare/v0.101.1...v0.102.0
[0.101.1]: https://github.com/buildd-ai/buildd/compare/v0.101.0...v0.101.1
[0.101.0]: https://github.com/buildd-ai/buildd/compare/v0.100.2...v0.101.0
[0.100.2]: https://github.com/buildd-ai/buildd/compare/v0.100.1...v0.100.2
[0.100.1]: https://github.com/buildd-ai/buildd/compare/v0.100.0...v0.100.1
[0.100.0]: https://github.com/buildd-ai/buildd/compare/v0.99.0...v0.100.0
[0.99.0]: https://github.com/buildd-ai/buildd/compare/v0.98.0...v0.99.0
[0.98.0]: https://github.com/buildd-ai/buildd/compare/v0.97.1...v0.98.0
[0.97.1]: https://github.com/buildd-ai/buildd/compare/v0.97.0...v0.97.1
[0.97.0]: https://github.com/buildd-ai/buildd/compare/v0.96.0...v0.97.0
[0.96.0]: https://github.com/buildd-ai/buildd/compare/v0.95.1...v0.96.0
[0.95.1]: https://github.com/buildd-ai/buildd/compare/v0.95.0...v0.95.1
[0.95.0]: https://github.com/buildd-ai/buildd/compare/v0.94.0...v0.95.0
[0.94.0]: https://github.com/buildd-ai/buildd/compare/v0.93.0...v0.94.0
[0.93.0]: https://github.com/buildd-ai/buildd/compare/v0.92.0...v0.93.0
[0.92.0]: https://github.com/buildd-ai/buildd/compare/v0.91.0...v0.92.0
[0.91.0]: https://github.com/buildd-ai/buildd/compare/v0.90.0...v0.91.0
[0.90.0]: https://github.com/buildd-ai/buildd/compare/v0.89.0...v0.90.0
[0.89.0]: https://github.com/buildd-ai/buildd/compare/v0.88.0...v0.89.0
[0.88.0]: https://github.com/buildd-ai/buildd/compare/v0.87.0...v0.88.0
[0.87.0]: https://github.com/buildd-ai/buildd/compare/v0.86.0...v0.87.0
[0.86.0]: https://github.com/buildd-ai/buildd/compare/v0.85.0...v0.86.0
[0.85.0]: https://github.com/buildd-ai/buildd/compare/v0.84.0...v0.85.0
[0.84.0]: https://github.com/buildd-ai/buildd/compare/v0.83.1...v0.84.0
[0.83.1]: https://github.com/buildd-ai/buildd/compare/v0.83.0...v0.83.1
[0.83.0]: https://github.com/buildd-ai/buildd/compare/v0.82.0...v0.83.0
[0.82.0]: https://github.com/buildd-ai/buildd/compare/v0.81.4...v0.82.0
[0.81.4]: https://github.com/buildd-ai/buildd/compare/v0.81.3...v0.81.4
[0.81.3]: https://github.com/buildd-ai/buildd/compare/v0.81.2...v0.81.3
[0.81.2]: https://github.com/buildd-ai/buildd/compare/v0.81.1...v0.81.2
[0.81.1]: https://github.com/buildd-ai/buildd/compare/v0.81.0...v0.81.1
[0.81.0]: https://github.com/buildd-ai/buildd/compare/v0.80.0...v0.81.0
[0.80.0]: https://github.com/buildd-ai/buildd/compare/v0.79.0...v0.80.0
[0.79.0]: https://github.com/buildd-ai/buildd/compare/v0.78.0...v0.79.0
[0.78.0]: https://github.com/buildd-ai/buildd/compare/v0.77.0...v0.78.0
[0.77.0]: https://github.com/buildd-ai/buildd/compare/v0.76.1...v0.77.0
[0.76.1]: https://github.com/buildd-ai/buildd/compare/v0.76.0...v0.76.1
[0.76.0]: https://github.com/buildd-ai/buildd/compare/v0.75.0...v0.76.0
[0.75.0]: https://github.com/buildd-ai/buildd/compare/v0.74.0...v0.75.0
[0.74.0]: https://github.com/buildd-ai/buildd/compare/v0.73.3...v0.74.0
[0.73.3]: https://github.com/buildd-ai/buildd/compare/v0.73.2...v0.73.3
[0.73.2]: https://github.com/buildd-ai/buildd/compare/v0.73.1...v0.73.2
[0.73.1]: https://github.com/buildd-ai/buildd/compare/v0.73.0...v0.73.1
[0.73.0]: https://github.com/buildd-ai/buildd/compare/v0.72.0...v0.73.0
[0.72.0]: https://github.com/buildd-ai/buildd/compare/v0.71.0...v0.72.0
[0.71.0]: https://github.com/buildd-ai/buildd/compare/v0.70.2...v0.71.0
[0.70.2]: https://github.com/buildd-ai/buildd/compare/v0.70.1...v0.70.2
[0.70.1]: https://github.com/buildd-ai/buildd/compare/v0.70.0...v0.70.1
[0.70.0]: https://github.com/buildd-ai/buildd/compare/v0.69.2...v0.70.0
[0.69.2]: https://github.com/buildd-ai/buildd/compare/v0.69.1...v0.69.2
[0.69.1]: https://github.com/buildd-ai/buildd/compare/v0.69.0...v0.69.1
[0.69.0]: https://github.com/buildd-ai/buildd/compare/v0.68.0...v0.69.0
[0.68.0]: https://github.com/buildd-ai/buildd/compare/v0.67.0...v0.68.0
[0.67.0]: https://github.com/buildd-ai/buildd/compare/v0.66.0...v0.67.0
[0.66.0]: https://github.com/buildd-ai/buildd/compare/v0.65.3...v0.66.0
[0.65.3]: https://github.com/buildd-ai/buildd/compare/v0.65.2...v0.65.3
[0.65.2]: https://github.com/buildd-ai/buildd/compare/v0.65.1...v0.65.2
[0.65.1]: https://github.com/buildd-ai/buildd/compare/v0.65.0...v0.65.1
[0.65.0]: https://github.com/buildd-ai/buildd/compare/v0.64.2...v0.65.0
[0.64.2]: https://github.com/buildd-ai/buildd/compare/v0.64.1...v0.64.2
[0.64.1]: https://github.com/buildd-ai/buildd/compare/v0.64.0...v0.64.1
[0.64.0]: https://github.com/buildd-ai/buildd/compare/v0.63.0...v0.64.0
[0.63.0]: https://github.com/buildd-ai/buildd/compare/v0.62.0...v0.63.0
[0.62.0]: https://github.com/buildd-ai/buildd/compare/v0.61.1...v0.62.0
[0.61.1]: https://github.com/buildd-ai/buildd/compare/v0.61.0...v0.61.1
[0.61.0]: https://github.com/buildd-ai/buildd/compare/v0.60.0...v0.61.0
[0.60.0]: https://github.com/buildd-ai/buildd/compare/v0.59.1...v0.60.0
[0.59.1]: https://github.com/buildd-ai/buildd/compare/v0.59.0...v0.59.1
[0.59.0]: https://github.com/buildd-ai/buildd/compare/v0.58.0...v0.59.0
[0.58.0]: https://github.com/buildd-ai/buildd/compare/v0.57.0...v0.58.0
[0.57.0]: https://github.com/buildd-ai/buildd/compare/v0.56.0...v0.57.0
[0.56.0]: https://github.com/buildd-ai/buildd/compare/v0.55.0...v0.56.0
[0.55.0]: https://github.com/buildd-ai/buildd/compare/v0.54.0...v0.55.0
[0.54.0]: https://github.com/buildd-ai/buildd/compare/v0.53.0...v0.54.0
[0.53.0]: https://github.com/buildd-ai/buildd/compare/v0.52.1...v0.53.0
[0.52.1]: https://github.com/buildd-ai/buildd/compare/v0.52.0...v0.52.1
[0.52.0]: https://github.com/buildd-ai/buildd/compare/v0.51.0...v0.52.0
[0.51.0]: https://github.com/buildd-ai/buildd/compare/v0.50.0...v0.51.0
[0.50.0]: https://github.com/buildd-ai/buildd/compare/v0.49.0...v0.50.0
[0.49.0]: https://github.com/buildd-ai/buildd/compare/v0.48.0...v0.49.0
[0.48.0]: https://github.com/buildd-ai/buildd/compare/v0.47.0...v0.48.0
[0.47.0]: https://github.com/buildd-ai/buildd/compare/v0.46.0...v0.47.0
[0.46.0]: https://github.com/buildd-ai/buildd/compare/v0.45.1...v0.46.0
[0.45.1]: https://github.com/buildd-ai/buildd/compare/v0.45.0...v0.45.1
[0.45.0]: https://github.com/buildd-ai/buildd/compare/v0.44.2...v0.45.0
[0.44.2]: https://github.com/buildd-ai/buildd/compare/v0.44.1...v0.44.2
[0.44.1]: https://github.com/buildd-ai/buildd/compare/v0.44.0...v0.44.1
[0.44.0]: https://github.com/buildd-ai/buildd/compare/v0.43.0...v0.44.0
[0.43.0]: https://github.com/buildd-ai/buildd/compare/v0.42.0...v0.43.0
[0.42.0]: https://github.com/buildd-ai/buildd/compare/v0.41.3...v0.42.0
[0.41.3]: https://github.com/buildd-ai/buildd/compare/v0.41.2...v0.41.3
[0.41.2]: https://github.com/buildd-ai/buildd/compare/v0.41.1...v0.41.2
[0.41.1]: https://github.com/buildd-ai/buildd/compare/v0.41.0...v0.41.1
[0.41.0]: https://github.com/buildd-ai/buildd/compare/v0.40.0...v0.41.0
[0.40.0]: https://github.com/buildd-ai/buildd/compare/v0.39.0...v0.40.0
[0.39.0]: https://github.com/buildd-ai/buildd/compare/v0.38.0...v0.39.0
[0.38.0]: https://github.com/buildd-ai/buildd/compare/v0.37.0...v0.38.0
[0.37.0]: https://github.com/buildd-ai/buildd/compare/v0.36.2...v0.37.0
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
[0.19.0]: https://github.com/buildd-ai/buildd/compare/v0.18.1...v0.19.0
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
