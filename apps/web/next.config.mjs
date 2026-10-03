/** @type {import('next').NextConfig} */
const nextConfig = {
  // @aws-sdk/client-s3 is on Next's default server-external list. Left
  // external, Turbopack loads it in `bun --bun next dev` through a hashed alias
  // (`@aws-sdk/client-s3-<hash>`) that Bun's resolver can't find, so every page
  // or route importing lib/storage (the task detail page among them) throws
  // "Failed to load external module". Listing it here bundles it instead.
  // Guarded by src/lib/next-config.test.ts.
  transpilePackages: ['@buildd/shared', '@buildd/core', '@builddai/ai-kit', '@aws-sdk/client-s3'],
  // @ast-grep/napi is a native napi binary loaded via dynamic import() in
  // packages/core/knowledge-store/symbol-extractor.ts. Turbopack statically
  // traces the dynamic import and cannot place the .node asset in an ESM
  // chunk — keep it external so it stays a runtime require. When the binary
  // is absent at runtime, symbol-extractor's try/catch degrades gracefully
  // to the line-window chunker.
  serverExternalPackages: ['@ast-grep/napi'],
  // The MCP route reads .claude/skills/buildd-mcp-consumer/SKILL.md and
  // .claude/skills/workspace-onboarding/SKILL.md (repo
  // root, outside apps/web) via readFileSync at request time — a path
  // output-file-tracing's static analysis won't discover on its own since
  // it never appears in an import/require. Force it into the serverless
  // bundle explicitly instead of relying on tracing to infer it.
  outputFileTracingIncludes: {
    '/api/mcp': [
      '../../.claude/skills/buildd-mcp-consumer/**',
      '../../.claude/skills/workspace-onboarding/**',
    ],
  },
  async redirects() {
    return [
      // `/` is handled in src/proxy.ts, not here: next.config redirects run
      // before the proxy, and the apex root now depends on the session cookie
      // (logged-out -> www marketing site, logged-in -> /app/home).
      {
        source: '/app',
        destination: '/app/home',
        permanent: false,
      },
      {
        source: '/app/dashboard',
        destination: '/app/home',
        permanent: false,
      },
      // Settings moved under one route tree with a sub-nav (lib/settings-nav.ts).
      // The browser keeps a #fragment across a redirect and Next passes the
      // query through, so /app/you#provider-keys and the OAuth callback's
      // /app/connections?connected=… both still land where they meant to.
      {
        source: '/app/you',
        destination: '/app/settings/account',
        permanent: false,
      },
      {
        source: '/app/connections',
        destination: '/app/settings/connectors',
        permanent: false,
      },
      // /memory is handled in src/proxy.ts: on the apex it goes to the
      // marketing site's /memory page; elsewhere it keeps the old 307 to the
      // docs page. It can't live here — config redirects run before the proxy.
    ];
  },
};

export default nextConfig;
