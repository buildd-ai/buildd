# Cross-surface delivery prototype

A browser-viewable design prototype for the Delivery UX mission (portfolio
Missions, actionable Activity, quiet Home). Open `index.html` directly in a
browser: no build step, no app imports, no network except Google Fonts (falls
back to system mono/serif). All data is fabricated fixture data.

**This is not production UI.** It is the approved-design reference that the
build tasks implement and that visual QA compares against.

## How to use it

| URL | Shows |
|---|---|
| `index.html#home` | Home, zero Needs you: one calm line, then 3 missions moving toward delivery |
| `index.html?needs=1#home` | Home with one real decision (2px ink card, two choices) |
| `index.html#activity` | Activity Now: grouped by mission, then Standalone. Tap task 34 to expand audit + repair rounds |
| `index.html#activity/history` | Activity History: one episode per delivery, filters, steps never reorder |
| `index.html#missions` | Missions portfolio: 11 open, counters with definitions, search, sort, filters, pinning |
| `index.html#mission/billing` | Mission detail: the existing Landed strip, kept, with a Build/Audit/Land drill-down added to the drawer |
| `index.html#transitions` | Storyboard: audit failed, auto repair, renewed audit, land; stale-head verdict; auditor unavailable; counter semantics |

Query flags: `theme=light|dark`, `needs=0|1`, `chrome=0` hides the prototype
toolbar, `open=t34,dr,defs` pre-expands disclosures, `sel=33` selects a strip cell.
On mission detail, use the arrow keys or the stepper to move along the strip.

Viewports checked: 360, 390 and 1280 px, night and day. None overflows horizontally.

## Why a hand-built prototype and not Claude Design

Tested from the real background runner (Claude Code CLI via the Agent SDK, non-interactive):

1. `DesignSync` is present as a deferred tool, but `DesignSync(list_projects)` was
   refused by the runner's PreToolUse policy hook: "claude.ai artifact access is
   not enabled for this task or role".
2. The `design` skill loads but in this session only manages agent access
   (`/design consent`, `/design revoke`). It cannot create or import a design.
3. The `design-sync` skill loads, but every step goes through `DesignSync` and a
   claude.ai login. It is also an hours-long, approval-gated upload of a
   component library, not a prototyping tool.
4. `claude auth status` reports `loggedIn: false, authMethod: none`. The runner
   authenticates with an API key. Claude Design needs a claude.ai Pro, Max, Team
   or Enterprise login.

So from this runner there is no auth, no project access, no shareable link and
no export. Unblocking it would need a claude.ai login on the runner and a role
policy that allows claude.ai artifact access. That is an owner decision, not a
design one.

## Decisions

| Decision | Why |
|---|---|
| One stage track, `Build › Audit › Land`, as words with ✓ and an underline, not squares | The spec bans arbitrary square segments. Words survive 360 px and colour blindness. Repair shows as `Audit ↻N` because a repair returns to audit on a new revision; it is not a fourth stage. |
| Delivery phase is a projection of the workflow-kernel state, never a percent | WORKING/AWAITING_PUSH = Build; AWAITING_REVIEW/APPROVED = Audit; CHANGES_REQUESTED/FIXING/REPAIRING = Audit with repair; BLOCKED_ON_TRUNK = Audit, waiting on trunk; LANDING = Land; MERGED = Landed; ESCALATED is the only state that reaches Needs you. |
| Every state chip has a glyph and a word as well as a colour | ■ landed, ▲ landing, ◐ in audit, ↻ repairing, ▶ building, ◇ waiting, ‖ held, ⊘ audit can't run, ✕ not landed, ! needs input. |
| Home all-clear is one line in the voice face | Spec: zero Needs you collapses to a calm line. "Buildd will ask if a decision comes up" is hidden below 768 px so the line never wraps. |
| Home shows 3 outcomes, chosen by "closest to a delivery milestone", not by agent activity | A mission in audit with no agent is still moving. A waiting or held mission is not shown. |
| Needs you shows what is not listed and why | "2 missions waiting on capacity or another mission. Those move on their own." makes it explicit that blocked does not mean needs you. |
| Portfolio counters: `11 open · 1 executing · 1/4 agent slots`, with a "What these count" disclosure | Replaces "11 running · 1 agent on it", which reads as a stall. Audits, CI and merges never count as agents. |
| Portfolio rows are 3 lines on mobile: title + pin; status + landed n/m + bar; next + age. An exception line appears only when there is one | Several missions per phone viewport, not one 35-step card. The landed bar is one continuous run with hatched in-audit share. It is not per-task squares. |
| Default sort is "Needs attention" (not landed, then audit can't run, then repair, audit, landing, build, waiting, held, planning), tiebreak id | Stable and useful. Other sorts: recently advanced, closest to landing, name. |
| Pinning is in | Spec: optional. With 11 to 45 open missions, the one you follow stays on top without a filter. |
| Activity Now counts deliveries in motion separately from agents working | "8 deliveries in motion · 1 agent working". This is the honest answer to "why is only one agent busy?". |
| Audit evidence is revision-scoped: one card per head, current head framed in 2px ink, older head dimmed, repair in between | Superseded results and stale-head verdicts are struck through with the reason, never deleted and never counted. |
| History is episodes per delivery, newest transition first, steps in their own order | Keeps the two-tap recency contract: Activity, then History, then any recent task is one more tap. |
| Mission detail keeps the existing Landed strip, tick row, tethered drawer, ordinal `NN · LEVEL x OF y`, reason line and stepper | Only additions: a Build/Audit/Land row in the drawer and an "Audit and repair" disclosure. Past 24 cells the tick row shows dots, with the selected and related cells as bars and a caption ("34 selected · unblocks 35"), because two-digit numbers overlap at 360 px. |
| Auditor unavailable is a warning, not Needs you, until the kernel escalates (`review_unavailable`) | Reason and retry cadence are visible. Only escalation brings it to Home, and then with two concrete choices. |

## Spec corrections (raised against `cross-surface-delivery-spec`)

1. **There is no level/task swimlane on mission detail.** The reference
   implementation is the one-row Landed strip in dependency order
   (`missions/[id]/MissionTaskStrip.tsx`, `MissionBoardParts.tsx`), with the
   level shown as text in the drawer ordinal. `docs/specs/mission-legibility.md`
   rule R4-22 forbids phase swimlanes. "Preserve the swimlane" should read
   "preserve the Landed strip, its selection, tick marks, drawer and stepper".
   `MissionLanes.tsx` (runner-slot lanes on a time axis) is a separate view.
2. **"Avoid arbitrary square segments / detached strips" conflicts with the
   strip.** It should be scoped to new surfaces (portfolio rows, Home, Activity).
   The mission-detail strip is the deliberate exception: one cell is one task in
   dependency order, so it is not arbitrary.
3. **The workflow kernel is a draft spec, not code.** `docs/specs/workflow-state-kernel.md`
   §4 defines the states, but no package reads them yet. The Build/Audit/Land
   projection above has to be computed from today's worker and PR fields until
   the kernel ships, and swapped to the kernel when it does.
4. **Activity today is `/app/tasks`** (calendar-day bands with All / Active /
   Completed / Failed filters). It has no Now/History split yet, so Now/History
   is new IA, not a refinement.
5. **Home today leads with a StatStrip** (live/capacity, runners, needs you,
   merged today, PRs in CI, self-healed). A quiet Home means demoting or
   removing that strip on the inbox.

## Related work this does not redo

- `run-progress-steering-audit` and its PRs: evidence-based run progress
  (`deriveRunEvidence`), turn-boundary steering, stable `(createdAt, id)`
  ordering. The revision cards here consume that evidence; they do not replace it.
- `lib/mission-task-strip.ts` (strip states, order, marks, reason, ordinal): the
  mission-detail view is drawn from it unchanged.
- The workflow-state kernel and the visual-auditor model: the prototype only
  projects their states and makes no claim about how they are computed.
