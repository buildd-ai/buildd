/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@buildd/shared', '@buildd/core'],
  // @ast-grep/napi is a native napi binary loaded via dynamic import() in
  // packages/core/knowledge-store/symbol-extractor.ts. Turbopack statically
  // traces the dynamic import and cannot place the .node asset in an ESM
  // chunk — keep it external so it stays a runtime require. When the binary
  // is absent at runtime, symbol-extractor's try/catch degrades gracefully
  // to the line-window chunker.
  serverExternalPackages: ['@ast-grep/napi'],
  async redirects() {
    return [
      {
        source: '/',
        destination: '/app/home',
        permanent: false,
      },
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
      // The standalone /memory marketing page is gone. Unlike /app/dashboard it
      // was a live route, not one shadowed by a redirect, so real inbound links
      // may exist — it kept an id="pricing" anchor for links predating the move
      // to a built-in feature. Send that traffic to the docs page it used to
      // link out to. Deliberately a 307, not a 308: browsers cache a permanent
      // redirect indefinitely, and deleting a page that was serving traffic is
      // the kind of call worth being able to take back.
      {
        source: '/memory',
        destination: 'https://docs.buildd.dev/docs/features/memory',
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
