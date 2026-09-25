import Link from 'next/link';

/**
 * Root 404. Rendered by the root layout only (no app shell), so it carries the
 * brand itself: the global mono face, surface tokens, the .card offset shadow and
 * a .btn — not the browser-default system font it used to fall back to.
 */
export default function NotFound() {
  return (
    <main className="min-h-dvh flex items-center justify-center px-4 py-16 bg-surface-1">
      <div className="card w-full max-w-md p-6 md:p-8" data-testid="not-found">
        <p className="section-label mb-3">404</p>
        <h1 className="text-lg font-semibold text-text-primary mb-2">Page not found</h1>
        <p className="text-sm text-text-secondary mb-6 [overflow-wrap:anywhere]">
          The page you&apos;re looking for doesn&apos;t exist, or the link is incomplete.
        </p>
        <Link href="/app/home" className="btn btn-primary max-md:min-h-11">
          Go home
        </Link>
      </div>
    </main>
  );
}
