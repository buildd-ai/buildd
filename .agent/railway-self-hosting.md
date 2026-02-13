# Self-Hosting Buildd on Railway

> **Status**: Draft - not fully tested yet

## Architecture Overview

```
┌─────────────────────────────────────┐
│  Railway (always-on server)         │
│  - Next.js app (apps/web)           │
│  - Connects to Neon DB              │
│  - Pusher for realtime (optional)   │
└──────────────┬──────────────────────┘
               │ HTTPS API
    ┌──────────┼──────────┐
    ▼          ▼          ▼
┌────────┐ ┌────────┐ ┌────────┐
│ Coder  │ │ Coder  │ │ Local  │
│ Worker │ │ Worker │ │ Worker │
└────────┘ └────────┘ └────────┘
```

Workers run externally (Coder workspaces, local machines) and connect to the Railway-hosted server for task coordination.

## Environment Variables

### Required

```bash
# Database (Neon serverless Postgres)
DATABASE_URL=postgres://user:pass@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require

# NextAuth
AUTH_SECRET=<random-32-char-string>  # openssl rand -base64 32
AUTH_URL=https://your-app.up.railway.app
NEXTAUTH_URL=https://your-app.up.railway.app

# Google OAuth (for user login)
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxx
```

### Optional (Realtime)

```bash
# Pusher - enables realtime updates in dashboard
# Can be omitted for polling-based updates
PUSHER_APP_ID=123456
PUSHER_KEY=abc123
PUSHER_SECRET=xyz789
PUSHER_CLUSTER=us2
```

### Optional (GitHub Integration)

```bash
# GitHub App - for OAuth login via GitHub + repo access
# Alternative to Google OAuth
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n..."
GITHUB_CLIENT_ID=Iv1.xxx
GITHUB_CLIENT_SECRET=xxx
```

## Railway Configuration

### Build Settings

```bash
# Build command
bun install && bun run build

# Start command
cd apps/web && npm run start

# Watch paths (for monorepo)
apps/web/**
packages/**
```

### railway.toml (optional)

```toml
[build]
builder = "nixpacks"

[deploy]
startCommand = "cd apps/web && npm run start"
healthcheckPath = "/api/health"
healthcheckTimeout = 30

[[services]]
name = "web"
port = 3000
```

## Database Setup

1. Create Neon project at https://neon.tech
2. Copy connection string to `DATABASE_URL`
3. Run migrations:
   ```bash
   cd packages/core && bun db:migrate
   ```

## Google OAuth Setup

1. Go to https://console.cloud.google.com/apis/credentials
2. Create OAuth 2.0 Client ID (Web application)
3. Add authorized redirect URI: `https://your-app.up.railway.app/api/auth/callback/google`
4. Copy Client ID and Secret to env vars

## Worker Configuration

Workers (in Coder or locally) need:

```bash
# API key created in buildd dashboard
BUILDD_API_KEY=bld_xxx

# Point to your Railway instance
BUILDD_SERVER=https://your-app.up.railway.app
```

## Differences from Vercel Deployment

| Aspect | Vercel | Railway |
|--------|--------|---------|
| Cold starts | Yes (serverless) | No (always-on) |
| Long-running requests | 10s limit | No limit |
| Pricing | Per-request | Per-hour |
| Custom domain | Automatic | Manual setup |

## Coder Template Changes

When using self-hosted Railway instance with Coder workers:

1. **Remove from template:**
   - `neon_api_key` - server-side only
   - `pusher_key/cluster` - server-side only
   - `google_client_*` - server-side only
   - `coder_app.buildd_web` - no local server
   - Port 3001 exposure

2. **Update in template:**
   - `buildd_server` parameter → your Railway URL
   - `local-ui` startup → connect to external server

3. **Keep in template:**
   - `buildd_api_key` - worker auth
   - `github_token` - git operations
   - `claude_*` - Claude auth
   - `coder_app.buildd_worker` - local worker UI

## Testing Checklist

- [ ] Database migrations run successfully
- [ ] Google OAuth callback works
- [ ] API key creation works
- [ ] Worker can claim tasks
- [ ] Worker can report progress
- [ ] Realtime updates work (if Pusher configured)
- [ ] PR creation works (if GitHub configured)

## Known Issues

1. **NextAuth trustHost** - Ensure `AUTH_URL` and `NEXTAUTH_URL` match your Railway domain exactly
2. **Monorepo build** - Railway may need `nixpacks.toml` for correct build context
3. **Database connection pooling** - Neon has connection limits; may need pooler URL for high traffic

## Future Improvements

- [ ] Add `railway.toml` to repo
- [ ] Create one-click Railway deploy button
- [ ] Document Fly.io alternative
- [ ] Add health check endpoint
- [ ] Support SQLite for simpler single-user setup
