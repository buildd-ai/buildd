# Plan: Buildd iOS App MVP

**Status**: Draft — mockups complete, ready for implementation
**Created**: 2026-03-22

> **Visual design — source of truth: [`docs/design/mobile-feed-spec.md`](design/mobile-feed-spec.md).**
> The app uses the **brutalist / editorial** direction (IBM Plex Mono, warm paper + ink, single teal accent, hard offset shadows, corner-bracket panels) on the canonical artboard `Brutalist — Missions Feed` (`CZXce`) in `buildd-mobile.pen`. The earlier dark+copper mockups (nodes `w7I0O`/`6MKTT`/`k8Qwv`/`sa91X`/`byzyJ`) document **screen structure and flows** only — for tokens, type, and component measurements defer to the spec.

---

## Goal

Native iOS app for buildd — personal mobile interface to missions, agent interactions, and task monitoring. Initially for personal use, potentially public later.

## Why native iOS (not mobile web)

- Push notifications for agent input requests — critical for async agent workflows
- Direct calendar integration via EventKit (cleaner than MCP session resumption, which is unreliable)
- Background refresh for mission status
- iOS share sheet for quick mission creation from other apps
- Feels like a real product, not a webapp wrapper

---

## Screens (mockups complete in `buildd-mobile.pen`)

### 1. Feed (`w7I0O`)
The home screen. Shows what needs attention now.

- **"NEEDS YOUR INPUT"** section — agent questions requiring human decision, shown as priority cards with inline action buttons
- **"RECENT"** section — completed tasks, scheduled missions, latest activity
- Bell icon for notification center
- Pull-to-refresh

### 2. Missions (`6MKTT`)
Grouped mission list matching web app's layout.

- **Filter tabs**: All / Active / Scheduled / Completed
- **Grouped sections**: NEEDS ATTENTION (orange), SCHEDULED (blue), COMPLETED (muted)
- Each card: left accent bar (color-coded by health), title, subtitle, timestamp
- Tap → Mission Detail

### 3. Mission Detail (`k8Qwv`)
Drill into a specific mission.

- Back navigation to Missions list
- **Progress card**: progress bar + percentage, task count, time estimate
- **Tasks list**: checkmark for completed, orange dot for needs-input, showing task title + status
- **Artifacts section**: generated outputs (charts, documents) with type + timestamp
- Tab bar stays visible (Missions tab active)

### 4. Agent Needs Input (`sa91X`)
Full-screen response experience for agent questions.

- Back navigation to parent mission
- Task title + "Waiting for your input" status
- **Agent question card**: role badge, timestamp, full question text
- **Context card**: structured data the agent surfaced to help decide
- **Response options**: agent-generated choices with descriptions, "Recommended" badge, "Custom response" option
- **"Send Response" CTA** — full-width button at bottom

### 5. Quick Create (`byzyJ`)
Create a new mission from phone.

- Modal presentation (Cancel / New Mission header)
- Fields: Objective (text), Description (multiline), Workspace (picker), Schedule (Run once / Recurring toggle)
- **"Create Mission" CTA** at bottom

### Navigation
- 4-tab bordered tab bar (not a glass pill): **Feed** | **Missions** | **Create** | **Activity** — see the Tab bar component in the spec (1.5px ink top border, teal top-indicator on the active tab)
- Create opens as a modal overlay
- Agent Input is a push from Feed or Mission Detail

---

## API Integration

The app talks to the existing buildd API. All endpoints already exist:

| Screen | Endpoints |
|--------|-----------|
| Feed | `GET /api/tasks?status=waiting_input`, `GET /api/tasks?limit=20&sort=updatedAt` |
| Missions | `GET /api/missions` (returns grouped by status) |
| Mission Detail | `GET /api/missions/[id]` (includes tasks + artifacts) |
| Agent Input | `GET /api/workers/[id]` (worker state with question), `POST /api/workers/[id]/instruct` (send response) |
| Quick Create | `POST /api/missions` |
| Auth | Bearer token via `Authorization` header (API key `bld_xxx`) |

### Auth approach
- Store API key in iOS Keychain
- Login screen: paste API key or scan QR from web dashboard
- All requests use `Authorization: Bearer bld_xxx`

### Realtime
- Pusher channels for live updates (same as web app)
- Channel: `workspace-{id}` for task/mission status changes
- Push notifications via APNs — need server-side integration to send APNs when worker enters `waiting_input`

---

## Tech Stack

- **SwiftUI** — modern declarative UI, matches the mockup's component-based design
- **Swift 6** with strict concurrency
- **Target**: iOS 17+ (no need for older device support for personal use)
- **Networking**: URLSession + async/await (no need for Alamofire for this scope)
- **Persistence**: SwiftData for offline cache of missions/tasks
- **Push**: APNs via Firebase Cloud Messaging or direct APNs
- **Realtime**: PusherSwift SDK for live updates

---

## Architecture

```
BuilddApp/
├── App/
│   ├── BuilddApp.swift          # Entry point, tab navigation
│   └── AppState.swift           # Global auth + workspace state
├── Models/
│   ├── Mission.swift            # Codable models matching API
│   ├── Task.swift
│   ├── Worker.swift
│   └── Artifact.swift
├── Services/
│   ├── APIClient.swift          # Typed HTTP client, auth, error handling
│   ├── PusherService.swift      # Realtime subscription manager
│   └── KeychainService.swift    # API key storage
├── Views/
│   ├── Feed/
│   │   ├── FeedView.swift
│   │   ├── InputCard.swift      # "Needs your input" card
│   │   └── ActivityCard.swift   # Recent activity row
│   ├── Missions/
│   │   ├── MissionsView.swift   # Grouped list
│   │   ├── MissionDetailView.swift
│   │   ├── MissionCard.swift    # List row with accent bar
│   │   └── TaskRow.swift        # Checklist item
│   ├── AgentInput/
│   │   ├── AgentInputView.swift # Full response screen
│   │   ├── ContextCard.swift
│   │   └── OptionCard.swift     # Response option
│   ├── Create/
│   │   └── CreateMissionView.swift
│   └── Auth/
│       └── LoginView.swift
└── Design/
    ├── Theme.swift              # Tokens from mobile-feed-spec.md §1 (ink/paper/teal, Plex Mono)
    └── Components/
        ├── HardShadow.swift      # Solid offset shadow modifier (sibling rect — NOT .shadow)
        ├── TaskCard.swift        # Bordered card, optional teal accent + progress
        ├── StatusChip.swift      # solid / outline / teal / muted / tint variants
        ├── CornerBracketPanel.swift # Fixed-height panel with 4 corner brackets
        ├── SectionHeader.swift   # "01  RUNNING NOW            3 active"
        └── BorderedTabBar.swift  # Bottom nav, ink top border + teal active indicator
```

---

## Design Tokens

**Authoritative table: [`docs/design/mobile-feed-spec.md` §1](design/mobile-feed-spec.md#1-design-tokens).** The brutalist/editorial direction below replaces the earlier dark+copper values.

```swift
// Colors — ink / paper / teal only
static let ink       = Color(hex: "#101216")  // text, borders, masthead bg, hard shadow
static let inkSoft   = Color(hex: "#3a414c")
static let inkFaint  = Color(hex: "#6b7280")
static let paper     = Color(hex: "#f4f3ee")  // app background
static let card      = Color(hex: "#ffffff")
static let hair      = Color(hex: "#d9d8d0")  // hairlines, progress track
static let teal      = Color(hex: "#0e8f84")  // the single accent
static let tealDeep  = Color(hex: "#0a655d")  // teal text on light
static let tealTint  = Color(hex: "#e8f4f2")
// on-ink greys: eyebrow #9bb8b3, sub #c7ccc9, meta #9aa2a0, meta-b #d3d7d4, rule #2c333c

// Typography — IBM Plex Mono everywhere (no Inter for app-owned UI)
static let fontMono = "IBM Plex Mono"

// Geometry — square corners (radius 0), 1.5px ink borders, hard offset shadow (blur 0)
```

---

## MVP Scope — what's IN vs OUT

### IN (v0.1)
- [ ] Login with API key
- [ ] Feed with needs-input cards + recent activity
- [ ] Missions list (grouped by health)
- [ ] Mission detail with tasks + artifacts
- [ ] Respond to agent questions (select option or type custom)
- [ ] Create mission (name + description + workspace + schedule)
- [ ] Pusher realtime for live status updates
- [ ] Pull-to-refresh everywhere

### OUT (later)
- Push notifications (needs server-side APNs integration)
- Calendar integration via EventKit (future — replaces dispatch MCP approach)
- Artifact viewer (PDFs, images, markdown render)
- Task creation from app (only missions for now)
- Role/team management
- Settings / workspace management
- Offline mode / SwiftData caching
- Widget / Live Activity for running agents
- Share sheet extension

---

## Server-side changes needed

Minimal — the API is mostly ready:

1. **APNs integration** (for push notifications, deferred to post-MVP)
   - Store device token: `POST /api/devices` with `{ token, platform: 'ios' }`
   - Trigger push when worker enters `waiting_input` state

2. **No other API changes needed** — all screens map to existing endpoints

---

## Open questions

1. **Repo structure**: New repo (`buildd-ios`) or folder in monorepo (`apps/ios/`)?
   - Recommendation: Separate repo — Xcode projects don't fit Turborepo well
2. **TestFlight**: Set up for personal use immediately, or wait?
3. **Calendar integration**: Read iOS calendar directly via EventKit, or wait for dispatch features to land in buildd proper?
4. **QR code login**: Worth building a QR display on web dashboard for easy mobile auth?

---

## Key references

| What | Where |
|------|-------|
| Visual design spec (source of truth) | `docs/design/mobile-feed-spec.md` |
| Canonical artboard | `buildd-mobile.pen` — `Brutalist — Missions Feed` (node `CZXce`) |
| iOS flow mockups (structure only) | `buildd-mobile.pen` — nodes w7I0O, 6MKTT, k8Qwv, sa91X, byzyJ |
| API routes | `apps/web/src/app/api/` |
| Shared types | `packages/shared/src/types.ts` |
| Pusher config | `apps/web/src/lib/pusher.ts` |
| Worker instruct endpoint | `apps/web/src/app/api/workers/[id]/instruct/route.ts` |
| Mission types | `packages/shared/src/types.ts` — MissionStatus, TaskStatus |
| Design tokens | `docs/design/mobile-feed-spec.md` §1 (brand reference: `.claude/skills/ui_designer/`) |
