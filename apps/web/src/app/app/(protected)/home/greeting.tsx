'use client';

import { useState, useEffect } from 'react';

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export function Greeting({ firstName }: { firstName: string }) {
  const [greeting, setGreeting] = useState('');

  useEffect(() => {
    setGreeting(getGreeting());
  }, []);

  if (!greeting) {
    // Render invisible placeholder to prevent layout shift
    return (
      <h1 className="text-[32px] md:text-[30px] font-light italic text-text-primary leading-tight">
        &nbsp;
      </h1>
    );
  }

  return (
    <h1 className="text-[32px] md:text-[30px] font-light italic text-text-primary leading-tight">
      {greeting}, {firstName}
    </h1>
  );
}
