'use client';

import { signOut } from 'next-auth/react';

export default function SignOutButton() {
  return (
    <button
      onClick={() => signOut({ callbackUrl: '/' })}
      className="btn h-11 md:h-8 shrink-0"
    >
      Sign out
    </button>
  );
}
