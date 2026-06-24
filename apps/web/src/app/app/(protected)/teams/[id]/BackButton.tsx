'use client';

import { useRouter } from 'next/navigation';

interface BackButtonProps {
  fallbackHref: string;
  label: string;
}

export default function BackButton({ fallbackHref, label }: BackButtonProps) {
  const router = useRouter();

  return (
    <button
      onClick={() => {
        if (window.history.length > 1) {
          router.back();
        } else {
          router.push(fallbackHref);
        }
      }}
      className="text-sm text-text-secondary hover:text-text-primary mb-2 block"
    >
      &larr; {label}
    </button>
  );
}
