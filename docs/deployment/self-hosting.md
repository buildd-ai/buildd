# Self-Hosting Buildd

Complete guide for self-hosting Buildd on your own infrastructure.

## Overview

Buildd consists of:
- **Web server** (Next.js) - Dashboard, API, and authentication
- **Database** (PostgreSQL) - Neon or any Postgres instance
- **Cron trigger** (External) - Calls `/api/cron/schedules` every minute
- **Workers** (External) - Run on laptops, VMs, or CI runners

## Prerequisites

- Node.js 18+ or Bun
- PostgreSQL database (Neon, local, or Docker)
- Domain name (optional, but recommended)
- SSL certificate (Let's Encrypt recommended)

## Quick Start with Docker Compose

### 1. Clone and Configure

```bash
git clone https://github.com/yourusername/buildd.git
cd buildd
cp .env.example .env.local
```

### 2. Edit `.env.local`

```bash
# Database
DATABASE_URL=postgresql://postgres:postgres@db:5432/buildd

# Auth (generate with: openssl rand -base64 32)
AUTH_SECRET=your-secret-here
AUTH_URL=https://your-domain.com

# Google OAuth
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret

# Cron (generate with: openssl rand -base64 32)
CRON_SECRET=your-cron-secret

# Pusher (optional - for realtime updates)
PUSHER_APP_ID=
PUSHER_KEY=
PUSHER_SECRET=
PUSHER_CLUSTER=us2
NEXT_PUBLIC_PUSHER_KEY=
NEXT_PUBLIC_PUSHER_CLUSTER=us2
```

### 3. Create `docker-compose.yml`

```yaml
version: '3.8'

services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: buildd
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"

  web:
    build: .
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=postgresql://postgres:postgres@db:5432/buildd
      - AUTH_SECRET=${AUTH_SECRET}
      - AUTH_URL=${AUTH_URL}
      - GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}
      - GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}
      - CRON_SECRET=${CRON_SECRET}
      - PUSHER_APP_ID=${PUSHER_APP_ID}
      - PUSHER_KEY=${PUSHER_KEY}
      - PUSHER_SECRET=${PUSHER_SECRET}
      - PUSHER_CLUSTER=${PUSHER_CLUSTER}
      - NEXT_PUBLIC_PUSHER_KEY=${NEXT_PUBLIC_PUSHER_KEY}
      - NEXT_PUBLIC_PUSHER_CLUSTER=${NEXT_PUBLIC_PUSHER_CLUSTER}
    depends_on:
      - db
    restart: unless-stopped

  cron-trigger:
    image: curlimages/curl:latest
    command: sh -c 'while true; do curl -s -H "Authorization: Bearer $$CRON_SECRET" http://web:3000/api/cron/schedules && sleep 60; done'
    environment:
      - CRON_SECRET=${CRON_SECRET}
    depends_on:
      - web
    restart: unless-stopped

volumes:
  postgres_data:
```

### 4. Create `Dockerfile`

```dockerfile
FROM oven/bun:1 AS base

WORKDIR /app

# Install dependencies
COPY package.json bun.lockb ./
COPY apps/web/package.json ./apps/web/
COPY packages/core/package.json ./packages/core/
COPY packages/shared/package.json ./packages/shared/
RUN bun install --frozen-lockfile

# Copy source
COPY . .

# Build
RUN bun run build

# Run migrations and start
CMD cd packages/core && bun run db:migrate && cd ../.. && bun run start
```

### 5. Run Migrations

```bash
# First time only - create database schema
docker-compose up -d db
docker-compose run --rm web sh -c "cd packages/core && bun run db:migrate"
```

### 6. Start Services

```bash
docker-compose up -d
```

Access at `http://localhost:3000`

## System Crontab Setup

If not using Docker Compose, set up a system cron job to trigger schedules:

### 1. Edit crontab

```bash
crontab -e
```

### 2. Add entry (runs every minute)

```bash
* * * * * curl -s -H "Authorization: Bearer YOUR_CRON_SECRET" http://localhost:3000/api/cron/schedules >> /var/log/buildd-cron.log 2>&1
```

Replace:
- `YOUR_CRON_SECRET` with your actual secret
- `http://localhost:3000` with your server URL

### 3. Verify logs

```bash
tail -f /var/log/buildd-cron.log
```

Expected output every minute:
```json
{"processed":3,"created":2,"skipped":1,"errors":0}
```

## Reverse Proxy Setup

### Nginx

```nginx
server {
    listen 80;
    server_name buildd.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Add SSL with Certbot:
```bash
sudo certbot --nginx -d buildd.yourdomain.com
```

### Caddy (simpler, auto-SSL)

```caddy
buildd.yourdomain.com {
    reverse_proxy localhost:3000
}
```

## Database Setup

### Option 1: Neon (Recommended)

1. Sign up at [neon.tech](https://neon.tech)
2. Create database
3. Copy connection string to `DATABASE_URL`
4. Migrations run automatically on deploy

### Option 2: Local PostgreSQL

```bash
# Install PostgreSQL
sudo apt install postgresql postgresql-contrib

# Create database
sudo -u postgres createdb buildd

# Create user
sudo -u postgres psql
postgres=# CREATE USER buildd WITH PASSWORD 'your-password';
postgres=# GRANT ALL PRIVILEGES ON DATABASE buildd TO buildd;

# Update .env.local
DATABASE_URL=postgresql://buildd:your-password@localhost:5432/buildd
```

Run migrations:
```bash
cd packages/core
bun run db:migrate
```

### Option 3: Docker PostgreSQL

```bash
docker run -d \
  --name buildd-postgres \
  -e POSTGRES_DB=buildd \
  -e POSTGRES_USER=buildd \
  -e POSTGRES_PASSWORD=your-password \
  -v buildd-data:/var/lib/postgresql/data \
  -p 5432:5432 \
  postgres:16-alpine

# Update .env.local
DATABASE_URL=postgresql://buildd:your-password@localhost:5432/buildd
```

## Google OAuth Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create OAuth 2.0 Client ID
3. Add authorized redirect URIs:
   - `http://localhost:3000/api/auth/callback/google` (dev)
   - `https://your-domain.com/api/auth/callback/google` (prod)
4. Copy Client ID and Secret to `.env.local`

## Alternative Cron Trigger Services

If you don't want to manage cron yourself:

### Option 1: cron-job.org (Free)

1. Sign up at [cron-job.org](https://cron-job.org)
2. Create new job:
   - **URL**: `https://your-domain.com/api/cron/schedules`
   - **Interval**: Every minute (`* * * * *`)
   - **HTTP Method**: GET
   - **Headers**: `Authorization: Bearer YOUR_CRON_SECRET`

### Option 2: EasyCron (Free tier available)

1. Sign up at [easycron.com](https://easycron.com)
2. Create cron job with URL and auth header
3. Set to run every minute

### Option 3: GitHub Actions (Free for public repos)

Add `.github/workflows/trigger-schedules.yml`:

```yaml
name: Trigger Schedules
on:
  schedule:
    - cron: '* * * * *'  # Every minute
  workflow_dispatch:      # Manual trigger

jobs:
  trigger:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger schedule endpoint
        run: |
          curl -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}" \
            https://your-domain.com/api/cron/schedules
```

Add `CRON_SECRET` to repository secrets.

**Note:** GitHub Actions cron has ~3-10 minute delay. Not suitable for time-sensitive schedules.

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `AUTH_SECRET` | Yes | NextAuth secret (32+ random chars) |
| `AUTH_URL` | Yes | Your site URL (e.g., https://buildd.example.com) |
| `GOOGLE_CLIENT_ID` | Yes | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Yes | Google OAuth secret |
| `CRON_SECRET` | Yes* | Secret for `/api/cron/schedules` endpoint |
| `ALLOWED_EMAILS` | No | Comma-separated email whitelist |
| `PUSHER_APP_ID` | No | Pusher app ID (enables realtime updates) |
| `PUSHER_KEY` | No | Pusher key |
| `PUSHER_SECRET` | No | Pusher secret |
| `PUSHER_CLUSTER` | No | Pusher cluster (e.g., us2) |
| `NEXT_PUBLIC_PUSHER_KEY` | No | Same as PUSHER_KEY |
| `NEXT_PUBLIC_PUSHER_CLUSTER` | No | Same as PUSHER_CLUSTER |

\* Required only if using task schedules feature

## Monitoring

### Health Check Endpoint

```bash
curl https://your-domain.com/api/health
```

### Cron Trigger Logs

Monitor the cron endpoint response:

```bash
# Every minute, check status
curl -H "Authorization: Bearer YOUR_CRON_SECRET" \
  https://your-domain.com/api/cron/schedules

# Response:
{
  "processed": 5,    # Schedules checked
  "created": 3,      # Tasks created
  "skipped": 2,      # Skipped (concurrency limit or timing)
  "errors": 0        # Failures
}
```

### Database Connection

```bash
# Check if migrations are up to date
cd packages/core
bun run db:check
```

## Troubleshooting

### Migrations won't run

```bash
# Check database connection
psql $DATABASE_URL -c "SELECT 1"

# Run migrations manually
cd packages/core
bun run db:migrate

# If stuck, reset migrations (WARNING: destroys data)
bun run db:push
```

### Schedules not triggering

1. Check `CRON_SECRET` is set correctly
2. Verify cron job is running: `curl -H "Authorization: Bearer SECRET" URL`
3. Check schedule `nextRunAt` is in the past: query `task_schedules` table
4. Ensure schedule is `enabled=true`

### OAuth not working

1. Verify redirect URI matches exactly (including http/https)
2. Check `AUTH_URL` matches your domain
3. Verify `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`

### Workers not claiming tasks

1. Check worker API key is valid: `GET /api/accounts`
2. Verify workspace exists: `GET /api/workspaces`
3. Check tasks are `status=pending`: `GET /api/tasks`

## Upgrading

```bash
# Pull latest code
git pull origin main

# Install dependencies
bun install

# Run new migrations
cd packages/core
bun run db:migrate
cd ../..

# Rebuild
bun run build

# Restart services
docker-compose restart web
# OR
pm2 restart buildd
```

## Backup

### Database Backup

```bash
# Backup
pg_dump $DATABASE_URL > buildd-backup-$(date +%Y%m%d).sql

# Restore
psql $DATABASE_URL < buildd-backup-20260208.sql
```

### Automated Backups

Add to crontab:
```bash
0 2 * * * pg_dump $DATABASE_URL | gzip > /backups/buildd-$(date +\%Y\%m\%d).sql.gz
```

## Security Checklist

- [ ] Use strong `AUTH_SECRET` and `CRON_SECRET` (32+ chars)
- [ ] Enable SSL/TLS with valid certificate
- [ ] Restrict `ALLOWED_EMAILS` if not public
- [ ] Use firewall to restrict database access
- [ ] Keep dependencies updated: `bun update`
- [ ] Monitor logs for unauthorized access attempts
- [ ] Rotate secrets periodically
- [ ] Use environment variables, never commit secrets

## Support

- [GitHub Issues](https://github.com/yourusername/buildd/issues)
- [Docs Home](../README.md)
- [Feature Docs](../features/schedules.md)
