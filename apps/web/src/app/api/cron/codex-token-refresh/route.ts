// Retired path of GET /api/cron/connector-token-refresh.
//
// The external scheduler (cron-job.org) is synced from cron-manifest.json by
// hand, so after a deploy the live job keeps calling this path until someone
// runs `bun run cron:sync --prune`. Deleting it first would stop connector
// tokens refreshing in that gap, and short-lived gateway tokens die within it.
// If both jobs fire, the refresh lock in mcp-connector-refresh.ts lets one win.
//
// Delete this file once the live job points at the new path.

export { GET } from '../connector-token-refresh/route';

export const maxDuration = 60;
