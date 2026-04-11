# Plan: Buildd iOS App MVP

**Status**: Draft — mockups complete, ready for implementation
**Created**: 2026-03-22

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
- 3-tab pill bar: **Feed** | **Missions** | **Create**
- Create opens as modal overlay
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
    ├── Theme.swift              # Colors, fonts, spacing from design tokens
    └── Components/
        ├── AccentBarCard.swift   # Reusable card with left color bar
        ├── SectionLabel.swift    # "NEEDS ATTENTION  2" style headers
        └── PillTabBar.swift     # Bottom navigation
```

---

## Design Tokens (from mockups)

```swift
// Colors
static let bgPrimary = Color(hex: "#130f0b")
static let bgCard = Color(hex: "#1e1914")
static let bgCardMuted = Color(hex: "#1a1611")
static let bgTabBar = Color(hex: "#1a1611")
static let textPrimary = Color(hex: "#f5ebe0")
static let textSecondary = Color(hex: "#8a827a")
static let textMuted = Color(hex: "#5e5850")
static let accent = Color(hex: "#d4956b")
static let success = Color(hex: "#5ec495")
static let info = Color(hex: "#7aacca")
static let warning = Color(hex: "#e8845a")

// Typography
static let fontUI = "Inter"
static let fontMono = "IBM Plex Mono"
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
| iOS mockups | `buildd-mobile.pen` — nodes w7I0O, 6MKTT, k8Qwv, sa91X, byzyJ |
| API routes | `apps/web/src/app/api/` |
| Shared types | `packages/shared/src/types.ts` |
| Pusher config | `apps/web/src/lib/pusher.ts` |
| Worker instruct endpoint | `apps/web/src/app/api/workers/[id]/instruct/route.ts` |
| Mission types | `packages/shared/src/types.ts` — MissionStatus, TaskStatus |
| Design tokens | `.claude/skills/ui_designer/` |
