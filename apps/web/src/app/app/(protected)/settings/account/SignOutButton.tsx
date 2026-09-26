'use client';

import { signOut } from 'next-auth/react';

export default function SignOutButton() {
  return (
    <button
      onClick={() => signOut({ callbackUrl: '/' })}
      className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
    >
      Sign out
    </button>
  );
}
