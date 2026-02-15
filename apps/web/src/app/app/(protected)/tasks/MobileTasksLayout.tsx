'use client';

import { useState, useEffect, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';

interface Props {
  sidebar: React.ReactNode;
  children: React.ReactNode;
}

export default function MobileTasksLayout({ sidebar, children }: Props) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pathname = usePathname();

  // Close sidebar on navigation (mobile)
  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  // Close sidebar on escape key
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') setSidebarOpen(false);
  }, []);

  useEffect(() => {
    if (sidebarOpen) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [sidebarOpen, handleKeyDown]);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Mobile header bar */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-10 flex items-center gap-2 px-3 py-2.5 bg-surface-2 border-b border-border-default">
        <button
          onClick={() => setSidebarOpen(true)}
          className="p-2 -ml-1 text-text-secondary hover:bg-surface-3 rounded-lg"
          aria-label="Open sidebar"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <span className="text-sm font-semibold truncate flex-1">Tasks</span>
        <Link
          href="/app/tasks/new"
          className="shrink-0 text-xs px-3 py-2 bg-primary text-white rounded-lg hover:bg-primary-hover font-medium"
        >
          + New
        </Link>
      </div>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="md:hidden fixed inset-0 z-30 bg-black/40"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar - hidden on mobile by default, overlay when open */}
      <div
        className={`
          fixed inset-y-0 left-0 z-40 w-64 transform transition-transform duration-200 ease-in-out
          md:relative md:translate-x-0 md:transition-none
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
      >
        {sidebar}
      </div>

      {/* Main content - add top padding on mobile for the header bar */}
      <main className="flex-1 overflow-auto pt-12 md:pt-0">
        {children}
      </main>
    </div>
  );
}
