/**
 * History View — search and browse past worker sessions from SQLite history.
 * Loaded as ES module, attaches to window for access from app.js.
 */

// State
let historyState = {
  sessions: [],
  total: 0,
  page: 1,
  limit: 20,
  totalPages: 0,
  query: '',
  workspace: '',
  status: '',
  sort: 'completed_at',
  dir: 'desc',
  stats: null,
  loading: false,
};

// Fetch history from API
async function fetchHistory() {
  historyState.loading = true;
  renderHistoryView();

  const params = new URLSearchParams();
  if (historyState.query) params.set('q', historyState.query);
  if (historyState.workspace) params.set('workspace', historyState.workspace);
  if (historyState.status) params.set('status', historyState.status);
  params.set('sort', historyState.sort);
  params.set('dir', historyState.dir);
  params.set('page', historyState.page);
  params.set('limit', historyState.limit);

  try {
    const res = await fetch(`./api/history?${params}`);
    const data = await res.json();
    historyState.sessions = data.sessions || [];
    historyState.total = data.total || 0;
    historyState.totalPages = data.totalPages || 0;
    historyState.page = data.page || 1;
  } catch (err) {
    console.error('Failed to fetch history:', err);
    historyState.sessions = [];
  }

  historyState.loading = false;
  renderHistoryView();
}

async function fetchStats() {
  try {
    const res = await fetch('./api/history/stats');
    historyState.stats = await res.json();
  } catch {
    historyState.stats = null;
  }
}

function formatDuration(ms) {
  if (!ms) return '-';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function formatCost(usd) {
  if (!usd || usd === 0) return '-';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatDate(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now - d;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } else if (diffDays === 1) {
    return 'Yesterday';
  } else if (diffDays < 7) {
    return `${diffDays}d ago`;
  } else {
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Render the history view into the main content area
function renderHistoryView() {
  const container = document.getElementById('historyView');
  if (!container) return;

  const stats = historyState.stats;
  const statsHtml = stats ? `
    <div class="flex items-center gap-4 p-3 bg-surface border border-border-default rounded-[10px] mb-4 text-sm">
      <div class="flex flex-col items-center flex-1">
        <span class="text-lg font-semibold text-text-primary">${stats.totalSessions}</span>
        <span class="text-[10px] font-mono text-text-tertiary uppercase tracking-[1.5px]">Sessions</span>
      </div>
      <div class="w-px h-7 bg-border-default"></div>
      <div class="flex flex-col items-center flex-1">
        <span class="text-lg font-semibold text-text-primary">${formatCost(stats.totalCost)}</span>
        <span class="text-[10px] font-mono text-text-tertiary uppercase tracking-[1.5px]">Total Cost</span>
      </div>
      <div class="w-px h-7 bg-border-default"></div>
      <div class="flex flex-col items-center flex-1">
        <span class="text-lg font-semibold text-text-primary">${formatDuration(stats.avgDurationMs)}</span>
        <span class="text-[10px] font-mono text-text-tertiary uppercase tracking-[1.5px]">Avg Duration</span>
      </div>
    </div>
  ` : '';

  // Search and filters
  const filtersHtml = `
    <div class="flex flex-col sm:flex-row gap-2 mb-4">
      <div class="flex-1">
        <input type="text" id="historySearch" class="input w-full bg-surface border border-border-default rounded-md py-2 px-3 text-sm text-text-primary outline-none transition-colors duration-200 focus:border-focus-ring"
          placeholder="Search tasks..." value="${escapeHtml(historyState.query)}"
          oninput="window._historyModule.debounceSearch(this.value)">
      </div>
      <select id="historyStatus" class="input bg-surface border border-border-default rounded-md py-2 px-3 text-sm text-text-primary" onchange="window._historyModule.filterStatus(this.value)">
        <option value="">All statuses</option>
        <option value="done" ${historyState.status === 'done' ? 'selected' : ''}>Completed</option>
        <option value="error" ${historyState.status === 'error' ? 'selected' : ''}>Failed</option>
      </select>
      <select id="historySort" class="input bg-surface border border-border-default rounded-md py-2 px-3 text-sm text-text-primary" onchange="window._historyModule.changeSort(this.value)">
        <option value="completed_at" ${historyState.sort === 'completed_at' ? 'selected' : ''}>Newest</option>
        <option value="duration_ms" ${historyState.sort === 'duration_ms' ? 'selected' : ''}>Longest</option>
        <option value="total_cost_usd" ${historyState.sort === 'total_cost_usd' ? 'selected' : ''}>Most expensive</option>
      </select>
    </div>
  `;

  // Results
  let resultsHtml = '';
  if (historyState.loading) {
    resultsHtml = '<div class="text-center py-8 text-text-secondary text-sm">Loading...</div>';
  } else if (historyState.sessions.length === 0) {
    resultsHtml = historyState.query || historyState.status
      ? '<div class="text-center py-8 text-text-secondary text-sm">No matching sessions found</div>'
      : '<div class="text-center py-8 text-text-secondary text-sm">No history yet. Complete a task to see it here.</div>';
  } else {
    resultsHtml = `
      <div class="flex flex-col gap-2">
        ${historyState.sessions.map(s => {
          const isError = s.status === 'error';
          const statusIcon = isError
            ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-4 h-4 text-status-error shrink-0"><path d="M18 6L6 18M6 6l12 12"/></svg>`
            : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-4 h-4 text-status-success shrink-0"><polyline points="20 6 9 17 4 12"/></svg>`;

          return `
            <div class="bg-surface rounded-xl p-4 cursor-pointer transition-all duration-200 hover:bg-surface-hover active:scale-[0.99]"
              onclick="window._historyModule.openSession('${s.id}')">
              <div class="flex items-start gap-3 mb-1">
                <div class="mt-[2px]">${statusIcon}</div>
                <div class="flex-1 min-w-0">
                  <div class="text-[15px] font-medium leading-relaxed truncate">${escapeHtml(s.task_title)}</div>
                  <div class="text-[13px] text-text-secondary mt-0.5">${escapeHtml(s.workspace_name)}${s.branch ? ' &bull; ' + escapeHtml(s.branch) : ''}</div>
                </div>
                <div class="text-xs text-text-secondary whitespace-nowrap">${formatDate(s.completed_at)}</div>
              </div>
              <div class="flex items-center gap-4 pl-7 mt-2 text-xs text-text-tertiary">
                ${s.duration_ms ? `<span>${formatDuration(s.duration_ms)}</span>` : ''}
                ${s.total_cost_usd > 0 ? `<span>${formatCost(s.total_cost_usd)}</span>` : ''}
                ${s.num_turns ? `<span>${s.num_turns} turns</span>` : ''}
                ${s.commit_count > 0 ? `<span>${s.commit_count} commit${s.commit_count !== 1 ? 's' : ''}</span>` : ''}
                ${s.model ? `<span class="font-mono">${escapeHtml(s.model.replace('claude-', '').split('-20')[0])}</span>` : ''}
              </div>
              ${isError && s.error ? `<div class="text-xs text-status-error mt-1.5 pl-7 truncate">${escapeHtml(s.error)}</div>` : ''}
            </div>
          `;
        }).join('')}
      </div>
    `;

    // Pagination
    if (historyState.totalPages > 1) {
      resultsHtml += `
        <div class="flex items-center justify-between mt-4 text-sm text-text-secondary">
          <span>${historyState.total} session${historyState.total !== 1 ? 's' : ''}</span>
          <div class="flex gap-2">
            <button class="px-3 py-1 rounded bg-surface-hover text-text-primary text-sm ${historyState.page <= 1 ? 'opacity-50 cursor-default' : 'cursor-pointer hover:bg-surface-hover'}"
              ${historyState.page <= 1 ? 'disabled' : ''}
              onclick="window._historyModule.goPage(${historyState.page - 1})">Prev</button>
            <span class="px-2 py-1">Page ${historyState.page} of ${historyState.totalPages}</span>
            <button class="px-3 py-1 rounded bg-surface-hover text-text-primary text-sm ${historyState.page >= historyState.totalPages ? 'opacity-50 cursor-default' : 'cursor-pointer hover:bg-surface-hover'}"
              ${historyState.page >= historyState.totalPages ? 'disabled' : ''}
              onclick="window._historyModule.goPage(${historyState.page + 1})">Next</button>
          </div>
        </div>
      `;
    }
  }

  container.innerHTML = statsHtml + filtersHtml + resultsHtml;
}

// Open archived session detail
async function openSession(workerId) {
  try {
    const res = await fetch(`./api/history/${workerId}`);
    if (!res.ok) {
      window.showToast?.('Session not found', 'error');
      return;
    }
    const data = await res.json();

    // Render in the worker modal (read-only mode for archived sessions)
    renderArchivedSession(data);
  } catch (err) {
    console.error('Failed to load session:', err);
    window.showToast?.('Failed to load session', 'error');
  }
}

function renderArchivedSession(session) {
  const modal = document.getElementById('workerModal');
  if (!modal) return;

  document.getElementById('modalTitle').textContent = session.task_title || 'Archived Session';

  const metaEl = document.getElementById('modalMeta');
  metaEl.innerHTML = `
    <span class="text-xs bg-surface-hover py-1.5 px-2.5 rounded text-text-secondary">${escapeHtml(session.workspace_name)}</span>
    ${session.branch ? `<span class="text-xs bg-surface-hover py-1.5 px-2.5 rounded text-text-secondary">${escapeHtml(session.branch)}</span>` : ''}
    <span class="text-xs bg-surface-hover py-1.5 px-2.5 rounded text-text-secondary meta-tag status-${session.status}">${session.status}</span>
    <span class="text-xs bg-surface-hover py-1.5 px-2.5 rounded text-text-secondary">archived</span>
  `;

  // Description
  const descEl = document.getElementById('modalDescription');
  if (session.task_description) {
    descEl.innerHTML = `
      <div class="task-description-card bg-surface rounded-lg py-3 px-3.5 mb-2 border-l-[3px] border-l-brand">
        <div class="text-[11px] font-semibold text-text-secondary uppercase tracking-wide mb-1.5">Task</div>
        <div class="markdown-content text-[13px] leading-normal">${window.marked?.parse(session.task_description) || escapeHtml(session.task_description)}</div>
      </div>
    `;
  } else {
    descEl.innerHTML = '';
  }

  // Timeline: tabs for different views
  const timelineEl = document.getElementById('chatTimeline');
  let tabsHtml = `
    <div class="flex gap-1 mb-3 border-b border-border-default pb-2" id="archivedTabs">
      <button class="text-xs font-medium px-3 py-1.5 rounded-t border-b-2 border-brand text-brand" data-tab="timeline" onclick="window._historyModule.switchTab('timeline')">Timeline</button>
      <button class="text-xs font-medium px-3 py-1.5 rounded-t border-b-2 border-transparent text-text-secondary hover:text-text-primary" data-tab="cost" onclick="window._historyModule.switchTab('cost')">Cost</button>
      <button class="text-xs font-medium px-3 py-1.5 rounded-t border-b-2 border-transparent text-text-secondary hover:text-text-primary" data-tab="commits" onclick="window._historyModule.switchTab('commits')">Commits</button>
    </div>
    <div id="archivedTabContent"></div>
  `;

  timelineEl.innerHTML = tabsHtml;

  // Store session data for tab switching
  window._archivedSession = session;
  switchTab('timeline');

  // Hide footer and input for archived sessions
  document.getElementById('modalFooter')?.classList.add('hidden');
  const inputEl = modal.querySelector('.border-t.bg-surface');
  if (inputEl) inputEl.classList.add('hidden');

  modal.classList.remove('hidden');
}

function switchTab(tab) {
  const session = window._archivedSession;
  if (!session) return;

  // Update tab styling
  document.querySelectorAll('#archivedTabs button').forEach(btn => {
    const isActive = btn.dataset.tab === tab;
    btn.classList.toggle('border-brand', isActive);
    btn.classList.toggle('text-brand', isActive);
    btn.classList.toggle('border-transparent', !isActive);
    btn.classList.toggle('text-text-secondary', !isActive);
  });

  const content = document.getElementById('archivedTabContent');
  if (!content) return;

  if (tab === 'timeline') {
    renderTimelineTab(content, session);
  } else if (tab === 'cost') {
    renderCostTab(content, session);
  } else if (tab === 'commits') {
    renderCommitsTab(content, session);
  }
}

function renderTimelineTab(container, session) {
  const archived = session.archived;
  if (!archived || !archived.messages || archived.messages.length === 0) {
    // Fallback to last assistant message
    if (session.last_assistant_message) {
      container.innerHTML = `
        <div class="chat-msg chat-agent max-w-[90%] self-start">
          <div class="chat-msg-content bg-surface rounded-tl-sm rounded-tr-lg rounded-br-lg rounded-bl-lg py-2.5 px-3.5 text-sm leading-relaxed">
            <div class="markdown-content text-sm">${window.marked?.parse(session.last_assistant_message) || escapeHtml(session.last_assistant_message)}</div>
          </div>
        </div>
      `;
    } else {
      container.innerHTML = '<div class="text-center py-8 text-text-secondary text-sm">No archived timeline data available</div>';
    }
    return;
  }

  // Render messages from archive
  const messages = archived.messages;
  container.innerHTML = messages.map(msg => {
    if (msg.type === 'text') {
      return `
        <div class="chat-msg chat-agent max-w-[90%] self-start mb-1.5">
          <div class="chat-msg-content bg-surface rounded-tl-sm rounded-tr-lg rounded-br-lg rounded-bl-lg py-2.5 px-3.5 text-sm leading-relaxed">
            <div class="markdown-content text-sm">${window.marked?.parse(msg.content) || escapeHtml(msg.content)}</div>
          </div>
        </div>`;
    }
    if (msg.type === 'user') {
      return `
        <div class="chat-msg max-w-[90%] self-end mb-1.5">
          <div class="text-[11px] text-text-secondary mb-1 text-right">You</div>
          <div class="bg-brand/15 border border-brand/25 rounded-tl-lg rounded-tr-sm rounded-br-lg rounded-bl-lg py-2.5 px-3.5 text-sm leading-normal text-text-primary">${escapeHtml(msg.content)}</div>
        </div>`;
    }
    if (msg.type === 'tool_use') {
      return `
        <div class="flex items-center gap-1.5 py-1 px-2.5 mb-0.5 bg-surface border-l-2 border-l-border-default rounded-r text-xs text-text-secondary overflow-hidden self-start max-w-[90%]">
          <span class="font-medium text-text-secondary text-xs shrink-0">${escapeHtml(msg.name)}</span>
        </div>`;
    }
    return '';
  }).join('');
}

function renderCostTab(container, session) {
  const archived = session.archived;
  const resultMeta = archived?.resultMeta;

  let html = `
    <div class="space-y-4">
      <div class="grid grid-cols-2 gap-3">
        <div class="bg-surface rounded-lg p-3 border border-border-default">
          <div class="text-[10px] font-mono text-text-tertiary uppercase tracking-wide mb-1">Duration</div>
          <div class="text-lg font-semibold text-text-primary">${formatDuration(session.duration_ms)}</div>
        </div>
        <div class="bg-surface rounded-lg p-3 border border-border-default">
          <div class="text-[10px] font-mono text-text-tertiary uppercase tracking-wide mb-1">Total Cost</div>
          <div class="text-lg font-semibold text-text-primary">${formatCost(session.total_cost_usd)}</div>
        </div>
        <div class="bg-surface rounded-lg p-3 border border-border-default">
          <div class="text-[10px] font-mono text-text-tertiary uppercase tracking-wide mb-1">Input Tokens</div>
          <div class="text-lg font-semibold text-text-primary">${(session.total_input_tokens || 0).toLocaleString()}</div>
        </div>
        <div class="bg-surface rounded-lg p-3 border border-border-default">
          <div class="text-[10px] font-mono text-text-tertiary uppercase tracking-wide mb-1">Output Tokens</div>
          <div class="text-lg font-semibold text-text-primary">${(session.total_output_tokens || 0).toLocaleString()}</div>
        </div>
      </div>
  `;

  // Per-model breakdown
  if (resultMeta?.modelUsage) {
    html += `
      <div>
        <div class="text-[10px] font-mono text-text-tertiary uppercase tracking-[2px] mb-2">Per Model</div>
        <div class="space-y-2">
    `;
    for (const [model, usage] of Object.entries(resultMeta.modelUsage)) {
      const shortModel = model.replace('claude-', '').split('-20')[0];
      html += `
        <div class="bg-surface rounded-lg p-3 border border-border-default">
          <div class="flex items-center justify-between mb-1">
            <span class="text-sm font-medium font-mono text-text-primary">${escapeHtml(shortModel)}</span>
            <span class="text-xs text-text-secondary">${formatCost(usage.costUSD)}</span>
          </div>
          <div class="text-xs text-text-tertiary">
            In: ${(usage.inputTokens || 0).toLocaleString()}
            &bull; Out: ${(usage.outputTokens || 0).toLocaleString()}
            ${usage.cacheReadInputTokens ? ` &bull; Cache: ${usage.cacheReadInputTokens.toLocaleString()}` : ''}
          </div>
        </div>
      `;
    }
    html += '</div></div>';
  }

  // Session metadata
  html += `
    <div>
      <div class="text-[10px] font-mono text-text-tertiary uppercase tracking-[2px] mb-2">Session Info</div>
      <div class="text-xs text-text-secondary space-y-1">
        ${session.num_turns ? `<div>Turns: ${session.num_turns}</div>` : ''}
        ${session.stop_reason ? `<div>Stop reason: ${escapeHtml(session.stop_reason)}</div>` : ''}
        ${session.model ? `<div>Model: ${escapeHtml(session.model)}</div>` : ''}
        ${session.started_at ? `<div>Started: ${new Date(session.started_at).toLocaleString()}</div>` : ''}
        ${session.completed_at ? `<div>Completed: ${new Date(session.completed_at).toLocaleString()}</div>` : ''}
      </div>
    </div>
  `;

  html += '</div>';
  container.innerHTML = html;
}

function renderCommitsTab(container, session) {
  let commits = [];
  try {
    commits = session.commits_json ? JSON.parse(session.commits_json) : [];
  } catch { commits = []; }

  if (commits.length === 0) {
    container.innerHTML = '<div class="text-center py-8 text-text-secondary text-sm">No commits in this session</div>';
    return;
  }

  container.innerHTML = `
    <div class="space-y-2">
      ${session.pr_url ? `
        <a href="${escapeHtml(session.pr_url)}" target="_blank" class="flex items-center gap-2 text-sm text-brand hover:underline mb-3">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
            <circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/>
            <path d="M13 6h3a2 2 0 012 2v7"/><line x1="6" y1="9" x2="6" y2="21"/>
          </svg>
          View Pull Request
        </a>
      ` : ''}
      ${commits.map(c => `
        <div class="flex items-start gap-3 p-3 bg-surface rounded-lg border border-border-default">
          <code class="text-[11px] font-mono text-brand bg-brand/10 px-1.5 py-0.5 rounded shrink-0">${escapeHtml((c.sha || '').slice(0, 7))}</code>
          <span class="text-sm text-text-primary">${escapeHtml(c.message)}</span>
        </div>
      `).join('')}
    </div>
  `;
}

// Debounce helper
let searchTimeout = null;
function debounceSearch(value) {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    historyState.query = value;
    historyState.page = 1;
    fetchHistory();
  }, 300);
}

function filterStatus(value) {
  historyState.status = value;
  historyState.page = 1;
  fetchHistory();
}

function changeSort(value) {
  historyState.sort = value;
  historyState.dir = value === 'completed_at' ? 'desc' : 'desc';
  historyState.page = 1;
  fetchHistory();
}

function goPage(page) {
  historyState.page = page;
  fetchHistory();
}

// Show history view (replaces main content)
function showHistory() {
  const main = document.querySelector('#app main');
  if (!main) return;

  // Hide normal content sections
  const normalContent = main.querySelectorAll('#mobileStats, #statsBar, #emptyHero, #contentSections');
  normalContent.forEach(el => el.style.display = 'none');

  // Create or show history container
  let historyView = document.getElementById('historyView');
  if (!historyView) {
    historyView = document.createElement('div');
    historyView.id = 'historyView';
    main.appendChild(historyView);
  }
  historyView.style.display = '';

  // Show back button
  let backNav = document.getElementById('historyBackNav');
  if (!backNav) {
    backNav = document.createElement('div');
    backNav.id = 'historyBackNav';
    backNav.className = 'flex items-center gap-2 mb-4';
    backNav.innerHTML = `
      <button class="flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors cursor-pointer bg-transparent border-none" onclick="window._historyModule.hideHistory()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
        Dashboard
      </button>
      <span class="text-text-tertiary">/</span>
      <span class="text-sm font-medium text-text-primary">History</span>
    `;
    historyView.prepend(backNav);
  }

  fetchStats().then(() => fetchHistory());
}

// Hide history view, restore normal content
function hideHistory() {
  const main = document.querySelector('#app main');
  if (!main) return;

  const normalContent = main.querySelectorAll('#mobileStats, #statsBar, #emptyHero, #contentSections');
  normalContent.forEach(el => el.style.display = '');

  const historyView = document.getElementById('historyView');
  if (historyView) historyView.style.display = 'none';

  // Re-render workers to refresh visibility
  if (typeof window.renderWorkers === 'function') window.renderWorkers();
}

// Cleanup when closing archived session modal — restore hidden elements
function cleanupArchivedModal() {
  window._archivedSession = null;
  document.getElementById('modalFooter')?.classList.remove('hidden');
  const modal = document.getElementById('workerModal');
  if (modal) {
    const inputBar = modal.querySelector('.border-t.bg-surface');
    if (inputBar) inputBar.classList.remove('hidden');
  }
}

// Patch closeWorkerModal to cleanup archived state (app.js loaded before this script)
if (typeof closeWorkerModal === 'function' && !closeWorkerModal._historyPatched) {
  const _prev = closeWorkerModal;
  closeWorkerModal = function() {
    cleanupArchivedModal();
    return _prev();
  };
  closeWorkerModal._historyPatched = true;
}

// Export module interface
window._historyModule = {
  showHistory,
  hideHistory,
  fetchHistory,
  debounceSearch,
  filterStatus,
  changeSort,
  goPage,
  openSession,
  switchTab,
  cleanupArchivedModal,
};
