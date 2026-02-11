import Link from 'next/link';

export default function NotFound() {
  return (
    <div style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <h2>Page Not Found</h2>
      <p style={{ color: '#666', marginTop: '0.5rem' }}>
        The page you&apos;re looking for doesn&apos;t exist.
      </p>
      <Link
        href="/app/dashboard"
        style={{
          display: 'inline-block',
          marginTop: '1rem',
          padding: '0.5rem 1rem',
          background: '#000',
          color: '#fff',
          borderRadius: '0.5rem',
          textDecoration: 'none',
        }}
      >
        Go to Dashboard
      </Link>
    </div>
  );
}
