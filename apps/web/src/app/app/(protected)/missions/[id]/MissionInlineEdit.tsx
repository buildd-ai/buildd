'use client';

import { useState, useRef, useCallback, useEffect } from 'react';

interface MissionInlineEditProps {
  missionId: string;
  initialTitle: string;
  initialDescription: string | null;
  healthPill: React.ReactNode;
}

export default function MissionInlineEdit({
  missionId,
  initialTitle,
  initialDescription,
  healthPill,
}: MissionInlineEditProps) {
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription || '');
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  const [savingTitle, setSavingTitle] = useState(false);
  const [savingDescription, setSavingDescription] = useState(false);

  const titleInputRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const titleBeforeEdit = useRef(title);
  const descriptionBeforeEdit = useRef(description);

  useEffect(() => {
    if (editingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [editingTitle]);

  useEffect(() => {
    if (editingDescription && descriptionRef.current) {
      descriptionRef.current.focus();
      // Auto-resize on open
      const el = descriptionRef.current;
      el.style.height = 'auto';
      el.style.height = el.scrollHeight + 'px';
    }
  }, [editingDescription]);

  const saveField = useCallback(
    async (field: 'title' | 'description', value: string) => {
      const setter = field === 'title' ? setSavingTitle : setSavingDescription;
      setter(true);
      try {
        const res = await fetch(`/api/objectives/${missionId}`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [field]: value }),
        });
        if (!res.ok) {
          // Revert on failure
          if (field === 'title') setTitle(titleBeforeEdit.current);
          else setDescription(descriptionBeforeEdit.current);
        }
      } catch {
        if (field === 'title') setTitle(titleBeforeEdit.current);
        else setDescription(descriptionBeforeEdit.current);
      } finally {
        setter(false);
      }
    },
    [missionId],
  );

  const handleTitleBlur = useCallback(() => {
    setEditingTitle(false);
    const trimmed = title.trim();
    if (!trimmed) {
      setTitle(titleBeforeEdit.current);
      return;
    }
    if (trimmed !== titleBeforeEdit.current) {
      setTitle(trimmed);
      saveField('title', trimmed);
    }
  }, [title, saveField]);

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        (e.target as HTMLInputElement).blur();
      }
      if (e.key === 'Escape') {
        setTitle(titleBeforeEdit.current);
        setEditingTitle(false);
      }
    },
    [],
  );

  const handleDescriptionBlur = useCallback(() => {
    setEditingDescription(false);
    const trimmed = description.trim();
    if (trimmed !== descriptionBeforeEdit.current) {
      setDescription(trimmed);
      saveField('description', trimmed);
    }
  }, [description, saveField]);

  const handleDescriptionKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDescription(descriptionBeforeEdit.current);
        setEditingDescription(false);
      }
    },
    [],
  );

  const handleDescriptionInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setDescription(e.target.value);
      // Auto-resize
      e.target.style.height = 'auto';
      e.target.style.height = e.target.scrollHeight + 'px';
    },
    [],
  );

  return (
    <>
      {/* Title row */}
      <div className="flex flex-wrap items-center gap-3 mb-2">
        {editingTitle ? (
          <input
            ref={titleInputRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={handleTitleBlur}
            onKeyDown={handleTitleKeyDown}
            className="text-xl font-semibold text-text-primary font-sans bg-transparent outline-none border-b border-text-muted/30 focus:border-accent-text w-full max-w-[calc(100%-80px)] transition-colors"
          />
        ) : (
          <h1
            onClick={() => {
              titleBeforeEdit.current = title;
              setEditingTitle(true);
            }}
            className={`text-xl font-semibold text-text-primary font-sans cursor-text hover:border-b hover:border-text-muted/20 transition-colors ${savingTitle ? 'opacity-60' : ''}`}
          >
            {title}
          </h1>
        )}
        {healthPill}
      </div>

      {/* Description */}
      {editingDescription ? (
        <textarea
          ref={descriptionRef}
          value={description}
          onChange={handleDescriptionInput}
          onBlur={handleDescriptionBlur}
          onKeyDown={handleDescriptionKeyDown}
          rows={1}
          className="text-[13px] text-text-desc leading-relaxed bg-transparent outline-none border-b border-text-muted/30 focus:border-accent-text w-full resize-none mb-4 transition-colors"
        />
      ) : (
        <p
          onClick={() => {
            descriptionBeforeEdit.current = description;
            setEditingDescription(true);
          }}
          className={`text-[13px] leading-relaxed mb-4 cursor-text hover:border-b hover:border-text-muted/20 transition-colors ${
            description
              ? 'text-text-desc'
              : 'text-text-muted italic'
          } ${savingDescription ? 'opacity-60' : ''}`}
        >
          {description || 'Add a description...'}
        </p>
      )}
    </>
  );
}
