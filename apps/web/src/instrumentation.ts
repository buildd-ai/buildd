import { registerOTel } from '@vercel/otel';

export function register() {
  registerOTel({ serviceName: 'buildd-web' });

  // Memory is now stored in buildd's own database (memories table).
  // No external service or env var required — reads/writes work out of the box.
  // If DATABASE_URL is missing, the db connection itself will fail loudly at startup.
}
