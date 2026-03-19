'use client';

import { useState, useRef, useEffect, useTransition } from 'react';
import { useRouter } from 'next/navigation';

export default function EditableTitle({
  missionId,
  initialTitle,
}: {
  missionId: string;
  initialTitle: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(initialTitle);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  async function save() {
    const trimmed = title.trim();
    if (!trimmed || trimmed === initialTitle) {
      setTitle(initialTitle);
      setEditing(false);
      return;
    }
    await fetch(`/api/missions/${missionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: trimmed }),
    });
    setEditing(false);
    startTransition(() => router.refresh());
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={title}
        onChange={e => setTitle(e.target.value)}
        onBlur={save}
        onKeyDown={e => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') {
            setTitle(initialTitle);
            setEditing(false);
          }
        }}
        className="text-2xl font-bold text-text-primary bg-transparent border-b-2 border-primary outline-none w-full truncate"
      />
    );
  }

  return (
    <h1
      onClick={() => setEditing(true)}
      className="text-2xl font-bold text-text-primary truncate cursor-pointer hover:text-primary/80 transition-colors"
      title="Click to edit"
    >
      {initialTitle}
    </h1>
  );
}
