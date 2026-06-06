import Link from 'next/link';

export default function NotFound() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: '1rem', color: 'var(--text-muted)' }}>
      <h1 style={{ color: 'var(--accent)', fontSize: '3rem' }}>404</h1>
      <p>Page not found</p>
      <Link href="/" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>
        Go home
      </Link>
    </div>
  );
}
