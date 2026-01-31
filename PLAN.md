# buildd Local UI + Worker Architecture Plan

## Overview

A hybrid architecture where:
- **Server (Vercel)** = Task queue, worker directory, thin command relay
- **Local-ui** = Worker execution, full terminal streaming, interactive sessions
- **Single OAuth** = Shared Google OAuth across buildd and Coder

### Networking / Tunneling

Since local-ui runs behind Tailscale VPN and Vercel can't reach it directly:

1. **Direct Access (Tailscale users)**:
   - Mobile joins Tailscale VPN
   - Access Coder at `100.x.x.x:3000`
   - Click local-ui app → `https://local-ui--workspace.coder.dev`

2. **Command Relay (via Pusher)**:
   - Mobile → Vercel `/api/workers/:id/cmd` → Pusher event
   - Local-ui subscribes to Pusher channel → receives command
   - No inbound connections needed (outbound WebSocket)

3. **Coder Subdomain Proxy**:
   - Coder exposes apps via subdomain: `local-ui--workspace--user.coder.dev`
   - Works for users with Coder access (Tailscale)

```
┌─────────────────────────────────────────────────────────────────┐
│  Any Browser (iOS Safari, laptop, etc.)                         │
│                                                                 │
│     ┌─────────────────┐              ┌─────────────────────┐   │
│     │ Server View     │    link to   │ Local-ui            │   │
│     │ (overview)      │ ──────────►  │ (full experience)   │   │
│     └─────────────────┘              └─────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Task List

### Phase 0: Coder Template (DONE)

- [x] **0.1 Add local-ui as Coder App**
  - File: `infrastructure/templates/claude-code/main.tf`
  - App exposed on port 8766 with subdomain support
  - Healthcheck on `/api/workers`

- [x] **0.2 Add buildd Parameters**
  - `buildd_api_key` - API key for buildd server
  - `pusher_key` - Pusher public key for realtime
  - `pusher_cluster` - Pusher cluster

- [x] **0.3 Startup Script**
  - Clone buildd repo
  - Install Bun
  - Start local-ui with env vars

---

### Phase 1: Shared OAuth (Google)

- [ ] **1.1 Update Google OAuth Console**
  - Add Coder callback URL to authorized redirects
  - URL: `https://{coder-domain}/api/v2/users/oidc/callback`
  - Reference: [Google Cloud Console](https://console.cloud.google.com/apis/credentials)

- [ ] **1.2 Configure Coder OIDC**
  - Update Coder deployment with OIDC env vars
  - File: `infrastructure/oci-terraform/docker-compose.yml` (or wherever Coder runs)
  ```bash
  CODER_OIDC_ISSUER_URL=https://accounts.google.com
  CODER_OIDC_CLIENT_ID=${GOOGLE_CLIENT_ID}
  CODER_OIDC_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}
  CODER_OIDC_EMAIL_DOMAIN=gmail.com
  CODER_OIDC_SIGN_IN_TEXT="Sign in with Google"
  ```

- [ ] **1.3 Test SSO Flow**
  - Login to buildd.vercel.app
  - Click link to Coder workspace
  - Verify auto-login (no second auth prompt)

---

### Phase 2: Server Enhancements

- [x] **2.1 Worker Registry Schema**
  - Added `localUiUrl`, `currentAction`, `milestones` fields to workers table
  - File: `packages/core/db/schema.ts`
  ```typescript
  localUiUrl: text('local_ui_url'),  // e.g., https://local-ui--workspace.coder.dev
  currentAction: text('current_action'),
  milestones: jsonb('milestones').default([]).$type<Array<{ label: string; timestamp: number }>>(),
  ```

- [x] **2.2 Worker Registration Endpoint**
  - Local-ui registers its URL when starting
  - File: `apps/web/src/app/api/workers/[id]/route.ts`
  - Accept `localUiUrl`, `currentAction`, `milestones` in PATCH body

- [x] **2.3 Thin Command Relay Endpoint**
  - File: `apps/web/src/app/api/workers/[id]/cmd/route.ts`
  - Uses Pusher for realtime command delivery (works with Vercel serverless)
  ```typescript
  // POST /api/workers/:id/cmd
  // { action: "pause" | "resume" | "abort" | "message", text?: string }
  // Server triggers Pusher event, local-ui receives via subscription
  ```

- [x] **2.4 Server Dashboard Updates**
  - Show worker's localUiUrl as "Open Terminal" link
  - Display milestone progress bars
  - Show current action status
  - File: `apps/web/src/app/(protected)/dashboard/page.tsx`

---

### Phase 3: Local-ui Enhancements

- [x] **3.1 URL Routing for Direct Worker Access**
  - Support `/worker/:id` URLs
  - File: `apps/local-ui/src/index.ts`
  ```typescript
  if (path.startsWith('/worker/')) {
    return serveStatic('index.html');  // SPA handles routing
  }
  ```

- [x] **3.2 Client-side Routing**
  - Parse URL on load, open worker modal if ID present
  - Update URL when navigating (pushState)
  - File: `apps/local-ui/ui/app.js`

- [x] **3.3 Command Handler Endpoint**
  - Handle commands via Pusher subscription AND direct HTTP
  - File: `apps/local-ui/src/index.ts` - `/cmd` and `/api/workers/:id/cmd`
  - File: `apps/local-ui/src/workers.ts` - Pusher subscription

- [x] **3.4 Register with Server on Startup**
  - Report localUiUrl to server when worker starts
  - Sync milestones and currentAction every 10s
  - Config via `LOCAL_UI_URL` env var
  - File: `apps/local-ui/src/workers.ts`

- [x] **3.5 Message Injection UI**
  - Text input in worker modal to send messages
  - Already implemented: `POST /api/workers/:id/send`
  - File: `apps/local-ui/ui/index.html`, `app.js`

---

### Phase 4: Worker Runtime - CURRENT APPROACH (SDK Sessions)

**Decision: tmux is NOT the right abstraction.**

The original plan proposed tmux for terminal streaming, but since we use the Anthropic TS Agent SDK (`@anthropic-ai/claude-agent-sdk`), workers run as in-process SDK sessions, not CLI subprocesses.

**Current implementation (`apps/local-ui/src/workers.ts`):**
```typescript
const session = unstable_v2_createSession({ model: config.model });
await session.send(prompt);
for await (const msg of session.stream()) {
  handleMessage(worker, msg);  // SSE to UI
}
```

**What we have:**
- [x] In-process SDK sessions with streaming
- [x] SSE broadcast to UI clients
- [x] Message injection via `session.send()`
- [x] Tool use tracking (milestones, currentAction)
- [x] Pusher for remote command relay
- [x] Abort/done controls

**Future improvements (if needed):**
- [ ] Session state persistence (save/restore across restarts)
- [ ] Terminal-like output rendering in UI (cosmetic, not actual PTY)
- [ ] Worker process isolation (spawn SDK in child process if memory becomes issue)

---

### Phase 5: Image Upload Support - DONE ✅

- [x] **5.1 Server-side Image Storage**
  - Images stored as base64 in `tasks.context.attachments`
  - File: `apps/web/src/app/api/tasks/route.ts`
  - Format: `{ filename, mimeType, data: "data:image/...;base64,..." }`

- [x] **5.2 Pass Images to Claude SDK**
  - Extract base64 from data URL, send as image content
  - File: `apps/local-ui/src/workers.ts`
  - Adds milestone for each image attachment

- [x] **5.3 UI Image Attachments**
  - File: `apps/local-ui/ui/app.js` (handleFileSelect, renderAttachments)
  - Preview, remove, multi-select support

---

### Phase 6: Status & Milestones - DONE ✅

- [x] **6.1 Status Indicators**
  - `.new` (blue pulse) - hasNewActivity
  - `.working` (gray spin) - active
  - `.done` (green) - completed
  - `.error` (red) - failed
  - `.stale` (dark) - no activity 2min+
  - CSS: `apps/local-ui/ui/styles.css` lines 188-203

- [x] **6.2 Milestone Tracking**
  - Track: file edits, writes, commits, session events
  - Display as boxes: `[■][■][■][□][□] count`
  - File: `apps/local-ui/src/workers.ts` (addMilestone, handleMessage)
  - UI: `apps/local-ui/ui/app.js` (renderMilestoneBoxes)

- [x] **6.3 Git Commit Detection**
  - Detects `git commit -m "..."` in Bash tool usage
  - Extracts message, stores in `worker.commits`
  - File: `apps/local-ui/src/workers.ts` lines 301-310

---

## File Structure

```
apps/
├── web/                          # Server (Vercel)
│   └── src/app/api/
│       ├── tasks/route.ts        # + image upload
│       ├── workers/
│       │   ├── claim/route.ts    # existing
│       │   └── [id]/
│       │       ├── route.ts      # + localUiUrl
│       │       └── cmd/route.ts  # NEW: thin command relay
│       └── workspaces/route.ts   # existing
│
├── local-ui/                     # Local worker manager
│   ├── src/
│   │   ├── index.ts              # HTTP server + routing
│   │   ├── workers.ts            # SDK sessions (in-process)
│   │   ├── buildd.ts             # API client
│   │   ├── workspace.ts          # Path resolution
│   │   └── types.ts              # TypeScript types
│   └── ui/
│       ├── index.html            # SPA
│       ├── styles.css
│       └── app.js
│
└── agent/                        # Headless worker (existing)
    └── src/
        └── ...                   # Could merge with local-ui
```

---

## URL Structure

### Server (buildd-three.vercel.app)

```
/dashboard                    # Main dashboard
/api/tasks                    # Task CRUD
/api/workers/claim            # Claim tasks
/api/workers/:id              # Worker status
/api/workers/:id/cmd          # Command relay (NEW)
```

### Local-ui (localhost:8766 or coder.dev/.../8766)

```
/                             # Dashboard
/worker/:id                   # Direct worker view (SPA route)
/api/events                   # SSE stream
/api/tasks                    # List tasks from buildd
/api/workers                  # Local workers
/api/workers/:id/send         # Send message to session
/api/workers/:id/cmd          # Command handler (abort, message)
/api/claim                    # Claim and start task
/api/abort                    # Abort worker
/api/done                     # Mark worker done
/cmd                          # Global command handler
```

---

## Data Flow

### Quick Command (mobile → server → local-ui)

```
Mobile                    Server                    Local-ui
  │                         │                          │
  │ POST /workers/abc/cmd   │                          │
  │ { action: "pause" }     │                          │
  │────────────────────────►│                          │
  │                         │ POST /cmd                │
  │                         │ { action: "pause" }      │
  │                         │─────────────────────────►│
  │                         │                          │ pause worker
  │                         │        { ok: true }      │
  │                         │◄─────────────────────────│
  │      { ok: true }       │                          │
  │◄────────────────────────│                          │
```

### Direct Access (mobile → local-ui)

```
Mobile                                    Local-ui
  │                                          │
  │ GET /worker/abc123                       │
  │─────────────────────────────────────────►│
  │                                          │
  │         Full HTML + SSE stream           │
  │◄─────────────────────────────────────────│
  │                                          │
  │ (WebSocket for terminal if needed)       │
  │◄────────────────────────────────────────►│
```

---

## Environment Variables

### Server (.env.local)

```bash
# Existing
DATABASE_URL=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...

# For image upload
STORAGE_ENDPOINT=...
STORAGE_BUCKET=...
STORAGE_ACCESS_KEY=...
STORAGE_SECRET_KEY=...
```

### Local-ui

```bash
BUILDD_SERVER=https://buildd-three.vercel.app
BUILDD_API_KEY=buildd_user_xxx
PROJECTS_ROOT=/home/coder/project
LOCAL_UI_URL=https://coder.dev/@user/workspace/port/8766  # or auto-detect
PORT=8766
```

### Coder

```bash
CODER_OIDC_ISSUER_URL=https://accounts.google.com
CODER_OIDC_CLIENT_ID=${GOOGLE_CLIENT_ID}
CODER_OIDC_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}
CODER_OIDC_EMAIL_DOMAIN=gmail.com
```

---

## References

- [buildd server](./apps/web)
- [local-ui](./apps/local-ui)
- [agent](./apps/agent)
- [infrastructure](../infrastructure)
- [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview)
- [SDK v2 Preview](https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview)
- [Coder OIDC Docs](https://coder.com/docs/admin/auth#openid-connect-with-google)
- [xterm.js](https://xtermjs.org/)

---

# GitHub App Integration

## Overview

Add GitHub App integration so org admins can connect their GitHub org to buildd, enabling:
- Auto-discovery of repositories
- Issue sync (import issues as tasks)
- PR creation by workers
- Webhook-driven task creation

## Phase 1: Core GitHub App Setup

### 1.1 Database Schema Changes

Add to `packages/core/db/schema.ts`:

```typescript
// Track GitHub App installations (orgs/users who installed the app)
export const githubInstallations = pgTable('github_installations', {
  id: uuid('id').primaryKey().defaultRandom(),
  installationId: bigint('installation_id', { mode: 'number' }).notNull().unique(),
  accountType: text('account_type').notNull(),  // 'Organization' or 'User'
  accountLogin: text('account_login').notNull(),
  accountId: bigint('account_id', { mode: 'number' }).notNull(),
  accessToken: text('access_token'),  // Encrypted
  tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
  permissions: jsonb('permissions').default({}).$type<Record<string, string>>(),
  repositorySelection: text('repository_selection'),  // 'all' or 'selected'
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// Track which repos are accessible via which installation
export const githubRepos = pgTable('github_repos', {
  id: uuid('id').primaryKey().defaultRandom(),
  installationId: uuid('installation_id').references(() => githubInstallations.id, { onDelete: 'cascade' }).notNull(),
  repoId: bigint('repo_id', { mode: 'number' }).notNull(),
  fullName: text('full_name').notNull(),  // e.g., "org/repo"
  private: boolean('private').default(false),
  defaultBranch: text('default_branch').default('main'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// Link workspaces to GitHub repos (add columns to existing workspaces table)
// ALTER TABLE workspaces ADD COLUMN github_repo_id UUID REFERENCES github_repos(id);
// ALTER TABLE workspaces ADD COLUMN github_installation_id UUID REFERENCES github_installations(id);
```

### 1.2 Environment Variables

```bash
# GitHub App credentials (create at github.com/settings/apps)
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----..."
GITHUB_APP_CLIENT_ID=Iv1.abc123
GITHUB_APP_CLIENT_SECRET=secret123
GITHUB_APP_WEBHOOK_SECRET=whsec_xxx

# Public URL for callbacks
NEXT_PUBLIC_APP_URL=https://buildd-three.vercel.app
```

### 1.3 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/github/install` | GET | Redirect to GitHub App install page |
| `/api/github/callback` | GET | Handle post-install OAuth callback |
| `/api/github/webhook` | POST | Receive GitHub webhook events |
| `/api/github/installations` | GET | List user's installations |
| `/api/github/installations/[id]/repos` | GET | List repos for an installation |
| `/api/github/installations/[id]/sync` | POST | Refresh repos from GitHub |

### 1.4 Core Files to Create

```
apps/web/src/
├── lib/
│   └── github.ts              # GitHub App client, token management
├── app/api/github/
│   ├── install/route.ts       # Redirect to install
│   ├── callback/route.ts      # OAuth callback
│   ├── webhook/route.ts       # Webhook handler
│   └── installations/
│       ├── route.ts           # List installations
│       └── [id]/
│           ├── repos/route.ts # List repos
│           └── sync/route.ts  # Sync repos
```

## Phase 2: UI Integration

### 2.1 Dashboard Changes
- Add "Connect GitHub" card if no installations
- Show connected orgs with repo counts

### 2.2 Workspace Creation Flow
- If GitHub connected: show repo picker dropdown
- Auto-populate workspace name from repo
- Link workspace to github_repo

### 2.3 Settings Page
- List GitHub installations
- Manage connected orgs
- Re-sync repos button

## Phase 3: Webhook-Driven Features

### 3.1 Issue Sync
- `issues.opened` → Create task
- `issues.closed` → Update task status
- `issues.labeled` → Update task priority/tags

### 3.2 PR Integration
- Workers can create PRs via GitHub API
- `pull_request.merged` → Mark task complete
- Link PRs to workers in UI

### 3.3 Repository Events
- `installation.created` → Add installation
- `installation.deleted` → Remove installation
- `installation_repositories.added` → Sync new repos

## Implementation Status

### Phase 1: Core GitHub App Setup - DONE ✅
- [x] **1.1 Database Schema** - `githubInstallations`, `githubRepos` tables
- [x] **1.2 GitHub lib** - JWT generation, token management, API client (`lib/github.ts`)
- [x] **1.3 Install flow** - `/api/github/install` redirect
- [x] **1.4 OAuth callback** - `/api/github/callback` handles post-install
- [x] **1.5 Webhook endpoint** - `/api/github/webhook` (installation, repos, issues)
- [x] **1.6 Installations API** - `/api/github/installations` list
- [x] **1.7 Repos API** - `/api/github/installations/[id]/repos`

### Phase 2: UI Integration - DONE ✅
- [x] **2.1 Dashboard GitHub card** - Connect/connected state
- [x] **2.2 Workspace creation** - Repo picker dropdown from GitHub
- [x] **2.3 Issue sync** - Issues with `buildd`/`ai` label → tasks

### Phase 3: Remaining Features - DONE ✅
- [x] **3.1 Sync repos endpoint** - `POST /api/github/installations/[id]/repos` triggers sync
- [x] **3.2 Settings page** - `/settings` with GitHub management (sync, disconnect)
- [x] **3.3 PR creation API** - `POST /api/github/pr` for workers to create PRs
- [x] **3.4 Link PRs to workers** - `prUrl`, `prNumber` fields in workers table, shown in dashboard
- [x] **3.5 MCP PR tool** - `buildd_create_pr` tool in MCP server

## GitHub App Setup Instructions

1. Go to https://github.com/settings/apps/new
2. Fill in:
   - **Name**: `buildd-dev` (or your preferred name)
   - **Homepage URL**: `https://buildd-three.vercel.app`
   - **Callback URL**: `https://buildd-three.vercel.app/api/github/callback`
   - **Setup URL**: `https://buildd-three.vercel.app/api/github/callback` (for post-install redirect)
   - **Webhook URL**: `https://buildd-three.vercel.app/api/github/webhook`
   - **Webhook secret**: Generate a random string
3. Permissions:
   - **Repository**: Contents (Read & Write), Issues (Read & Write), Pull requests (Read & Write), Metadata (Read)
   - **Organization**: Members (Read)
4. Subscribe to events:
   - Issues, Pull request, Push, Installation, Installation repositories
5. Generate private key and download
6. Note the App ID and Client credentials
7. Add to Vercel environment variables
