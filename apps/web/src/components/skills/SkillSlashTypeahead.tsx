'use client';

import { useState, useRef, useEffect, useCallback } from 'react';

interface Skill {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  onPaste?: (e: React.ClipboardEvent) => void;
  skills: Skill[];
  selectedSlugs: string[];
  onSelectSkill: (slug: string) => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  className?: string;
  id?: string;
  name?: string;
}

export function SkillSlashTypeahead({
  value,
  onChange,
  onPaste,
  skills,
  selectedSlugs,
  onSelectSkill,
  placeholder,
  rows = 4,
  disabled,
  className,
  id,
  name,
}: Props) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Filter skills based on slash query
  const filteredSkills = slashQuery
    ? skills.filter(
        s =>
          !selectedSlugs.includes(s.slug) &&
          (s.name.toLowerCase().includes(slashQuery.toLowerCase()) ||
            s.slug.toLowerCase().includes(slashQuery.toLowerCase()))
      )
    : skills.filter(s => !selectedSlugs.includes(s.slug));

  const detectSlashTrigger = useCallback(
    (text: string, cursorPos: number) => {
      // Look backwards from cursor for a `/` trigger
      const beforeCursor = text.slice(0, cursorPos);
      const lastSlashIdx = beforeCursor.lastIndexOf('/');

      if (lastSlashIdx === -1) return null;

      // Must be at start of line or after whitespace
      const charBefore = lastSlashIdx > 0 ? beforeCursor[lastSlashIdx - 1] : '\n';
      if (charBefore !== '\n' && charBefore !== ' ' && charBefore !== '\t' && lastSlashIdx !== 0) {
        return null;
      }

      const query = beforeCursor.slice(lastSlashIdx + 1);
      // No spaces in the query — closing the typeahead
      if (query.includes(' ') || query.includes('\n')) return null;

      return { slashStart: lastSlashIdx, query };
    },
    []
  );

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    onChange(newValue);

    const cursorPos = e.target.selectionStart;
    const result = detectSlashTrigger(newValue, cursorPos);

    if (result) {
      setSlashQuery(result.query);
      setShowDropdown(true);
      setSelectedIndex(0);
    } else {
      setShowDropdown(false);
      setSlashQuery('');
    }
  };

  const selectSkill = (skill: Skill) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const cursorPos = textarea.selectionStart;
    const result = detectSlashTrigger(value, cursorPos);
    if (!result) return;

    // Replace `/query` with skill name mention
    const before = value.slice(0, result.slashStart);
    const after = value.slice(cursorPos);
    const newValue = before + `/${skill.slug} ` + after;

    onChange(newValue);
    onSelectSkill(skill.slug);
    setShowDropdown(false);
    setSlashQuery('');

    // Refocus
    requestAnimationFrame(() => {
      const newCursorPos = result.slashStart + skill.slug.length + 2;
      textarea.focus();
      textarea.setSelectionRange(newCursorPos, newCursorPos);
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!showDropdown || filteredSkills.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => (i + 1) % filteredSkills.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => (i - 1 + filteredSkills.length) % filteredSkills.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      selectSkill(filteredSkills[selectedIndex]);
    } else if (e.key === 'Escape') {
      setShowDropdown(false);
    }
  };

  // Close dropdown on outside click
  useEffect(() => {
    if (!showDropdown) return;
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        textareaRef.current &&
        !textareaRef.current.contains(e.target as Node)
      ) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showDropdown]);

  return (
    <div className="relative">
      <textarea
        ref={textareaRef}
        id={id}
        name={name}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onPaste={onPaste}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        className={className || 'w-full px-4 py-2 border border-border-default rounded-md bg-surface-1 focus:ring-2 focus:ring-primary-ring focus:border-primary'}
      />

      {showDropdown && filteredSkills.length > 0 && (
        <div
          ref={dropdownRef}
          className="absolute left-0 right-0 mt-1 border border-border-default rounded-md bg-surface-1 max-h-40 overflow-y-auto shadow-lg z-20"
        >
          {filteredSkills.slice(0, 8).map((skill, i) => (
            <button
              key={skill.id}
              type="button"
              onClick={() => selectSkill(skill)}
              className={`w-full px-3 py-2 text-left text-sm flex items-center justify-between ${
                i === selectedIndex ? 'bg-primary/10 text-primary' : 'hover:bg-surface-3'
              }`}
            >
              <span className="flex items-center gap-2">
                <code className="text-xs text-text-muted">/{skill.slug}</code>
                <span className="truncate">{skill.name}</span>
              </span>
              {skill.description && (
                <span className="text-xs text-text-muted ml-2 truncate max-w-[200px]">
                  {skill.description}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
