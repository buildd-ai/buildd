/**
 * Worker Detail Tabs — adds Logs, Cost, and Commits tabs to the worker detail modal.
 * Loaded after app.js; patches renderWorkerDetail to inject tab bar.
 *
 * The Timeline tab is the existing chat view (managed by app.js).
 * Other tabs render into the same chatTimeline container when active.
 */

// Track active tab per worker
let activeTab = 'timeline';
let currentTabWorkerId = null;

// Tab definitions
const TABS = [
  { id: 'timeline', label: 'Timeline' },
  { id: 'logs', label: 'Logs' },
  { id: 'cost', label: 'Cost' },
  { id: 'commits', label: 'Commits' },
];

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

/**
 * Render the tab bar HTML. Inserted between description and timeline.
 */
function renderTabBar() {
  return `
    <div class="flex gap-1 mb-3 border-b border-border-default -mx-1" id="workerDetailTabs">
      ${TABS.map(t => `
        <button class="text-xs font-medium px-3 py-1.5 border-b-2 transition-colors duration-150 ${
          t.id === activeTab
            ? 'border-brand text-brand'
            : 'border-transparent text-text-secondary hover:text-text-primary'
        }" data-tab="${t.id}" onclick="window._workerDetailTabs.switchTab('${t.id}')">${t.label}</button>
      `).join('')}
    </div>
  `;
}

/**
 * Switch to a tab. For timeline, restores original chat view.
 * For other tabs, renders into chatTimeline.
 */
function switchTab(tabId) {
  activeTab = tabId;

  // Update tab styling
  document.querySelectorAll('#workerDetailTabs button').forEach(btn => {
    const isActive = btn.dataset.tab === tabId;
    btn.classList.toggle('border-brand', isActive);
    btn.classList.toggle('text-brand', isActive);
    btn.classList.toggle('border-transparent', !isActive);
    btn.classList.toggle('text-text-secondary', !isActive);
  });

  // Get current worker
  const worker = window.workers?.find(w => w.id === (window.currentWorkerId || currentTabWorkerId));
  if (!worker) return;

  const timelineEl = document.getElementById('chatTimeline');
  const scrollBtn = document.getElementById('scrollToBottomBtn');

  if (tabId === 'timeline') {
    // Re-render the standard timeline via app.js (skip re-injecting tabs to avoid recursion)
    if (typeof window.renderWorkerDetail === 'function') {
      window._workerDetailTabs._skipTabInject = true;
      window.renderWorkerDetail(worker);
      window._workerDetailTabs._skipTabInject = false;
      // Re-inject tab bar after timeline render
      injectTabBar();
    }
    if (scrollBtn) scrollBtn.classList.remove('hidden');
    return;
  }

  // Hide scroll-to-bottom for non-timeline tabs
  if (scrollBtn) scrollBtn.classList.add('hidden');
  // Hide message input for non-timeline tabs
  const inputBar = document.querySelector('#workerModal .border-t.bg-surface');
  if (inputBar && (worker.status === 'done' || worker.status === 'error')) {
    // Keep hidden for completed workers on non-timeline tabs
  }

  if (tabId === 'logs') {
    renderLogsTab(timelineEl, worker);
  } else if (tabId === 'cost') {
    renderCostTab(timelineEl, worker);
  } else if (tabId === 'commits') {
    renderCommitsTab(timelineEl, worker);
  }
}

/**
 * Logs tab — fetches session logs from API
 */
async function renderLogsTab(container, worker) {
  container.innerHTML = '<div class="text-center py-8 text-text-secondary text-sm">Loading logs...</div>';

  try {
    const res = await fetch(`./api/workers/${worker.id}/logs`);
    if (!res.ok) {
      container.innerHTML = '<div class="text-center py-8 text-text-secondary text-sm">No logs available</div>';
      return;
    }
    const data = await res.json();
    const logs = data.logs || [];

    if (logs.length === 0) {
      container.innerHTML = '<div class="text-center py-8 text-text-secondary text-sm">No log entries yet</div>';
      return;
    }

    // Filter controls + log table
    container.innerHTML = `
      <div class="mb-3 flex items-center gap-2">
        <select id="logLevelFilter" class="input bg-surface border border-border-default rounded-md py-1.5 px-2 text-xs text-text-primary" onchange="window._workerDetailTabs.filterLogs()">
          <option value="">All levels</option>
          <option value="info">Info</option>
          <option value="warn">Warning</option>
          <option value="error">Error</option>
        </select>
        <span class="text-xs text-text-tertiary ml-auto">${logs.length} entries</span>
      </div>
      <div class="overflow-x-auto" id="logsTableContainer">
        ${renderLogsTable(logs)}
      </div>
    `;

    // Store logs for filtering
    window._workerDetailTabs._currentLogs = logs;
  } catch (err) {
    console.error('Failed to fetch logs:', err);
    container.innerHTML = '<div class="text-center py-8 text-text-secondary text-sm">Failed to load logs</div>';
  }
}

function renderLogsTable(logs) {
  return `
    <table class="w-full text-xs">
      <thead>
        <tr class="text-left text-text-tertiary font-mono uppercase tracking-wide">
          <th class="py-1.5 pr-3 font-medium">Time</th>
          <th class="py-1.5 pr-3 font-medium">Level</th>
          <th class="py-1.5 pr-3 font-medium">Event</th>
          <th class="py-1.5 font-medium">Detail</th>
        </tr>
      </thead>
      <tbody>
        ${logs.map(log => {
          const time = new Date(log.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          const levelColors = {
            info: 'text-text-secondary',
            warn: 'text-status-warning',
            error: 'text-status-error',
          };
          const levelColor = levelColors[log.level] || 'text-text-secondary';
          return `
            <tr class="border-t border-border-default/50 hover:bg-surface-hover/50">
              <td class="py-1.5 pr-3 font-mono text-text-tertiary whitespace-nowrap">${time}</td>
              <td class="py-1.5 pr-3 font-mono ${levelColor} font-medium">${escapeHtml(log.level)}</td>
              <td class="py-1.5 pr-3 text-text-primary">${escapeHtml(log.event)}</td>
              <td class="py-1.5 text-text-secondary truncate max-w-[200px]" title="${escapeHtml(log.detail || '')}">${escapeHtml(log.detail || '')}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

function filterLogs() {
  const level = document.getElementById('logLevelFilter')?.value;
  const logs = window._workerDetailTabs._currentLogs || [];
  const filtered = level ? logs.filter(l => l.level === level) : logs;
  const tableContainer = document.getElementById('logsTableContainer');
  if (tableContainer) {
    tableContainer.innerHTML = renderLogsTable(filtered);
  }
}

/**
 * Cost tab — shows token usage and cost breakdown from resultMeta
 */
function renderCostTab(container, worker) {
  const meta = worker.resultMeta;

  // Calculate totals from modelUsage if available
  let totalInput = 0, totalOutput = 0, totalCost = 0, totalCache = 0;
  if (meta?.modelUsage) {
    for (const usage of Object.values(meta.modelUsage)) {
      totalInput += usage.inputTokens || 0;
      totalOutput += usage.outputTokens || 0;
      totalCost += usage.costUSD || 0;
      totalCache += usage.cacheReadInputTokens || 0;
    }
  }

  const hasCostData = meta?.modelUsage && Object.keys(meta.modelUsage).length > 0;
  const isActive = worker.status === 'working' || worker.status === 'waiting' || worker.status === 'stale';

  if (!hasCostData && isActive) {
    container.innerHTML = '<div class="text-center py-8 text-text-secondary text-sm">Cost data available after session completes</div>';
    return;
  }

  if (!hasCostData) {
    container.innerHTML = '<div class="text-center py-8 text-text-secondary text-sm">No cost data available</div>';
    return;
  }

  let html = `
    <div class="space-y-4">
      <div class="grid grid-cols-2 gap-3">
        <div class="bg-surface rounded-lg p-3 border border-border-default">
          <div class="text-[10px] font-mono text-text-tertiary uppercase tracking-wide mb-1">Duration</div>
          <div class="text-lg font-semibold text-text-primary">${formatDuration(meta.durationMs)}</div>
        </div>
        <div class="bg-surface rounded-lg p-3 border border-border-default">
          <div class="text-[10px] font-mono text-text-tertiary uppercase tracking-wide mb-1">Total Cost</div>
          <div class="text-lg font-semibold text-text-primary">${formatCost(totalCost)}</div>
        </div>
        <div class="bg-surface rounded-lg p-3 border border-border-default">
          <div class="text-[10px] font-mono text-text-tertiary uppercase tracking-wide mb-1">Input Tokens</div>
          <div class="text-lg font-semibold text-text-primary">${totalInput.toLocaleString()}</div>
        </div>
        <div class="bg-surface rounded-lg p-3 border border-border-default">
          <div class="text-[10px] font-mono text-text-tertiary uppercase tracking-wide mb-1">Output Tokens</div>
          <div class="text-lg font-semibold text-text-primary">${totalOutput.toLocaleString()}</div>
        </div>
      </div>
  `;

  // Per-model breakdown
  html += `
    <div>
      <div class="text-[10px] font-mono text-text-tertiary uppercase tracking-[2px] mb-2">Per Model</div>
      <div class="space-y-2">
  `;
  for (const [model, usage] of Object.entries(meta.modelUsage)) {
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
          ${usage.cacheReadInputTokens ? ` &bull; Cache read: ${usage.cacheReadInputTokens.toLocaleString()}` : ''}
          ${usage.cacheCreationInputTokens ? ` &bull; Cache write: ${usage.cacheCreationInputTokens.toLocaleString()}` : ''}
        </div>
      </div>
    `;
  }
  html += '</div></div>';

  // Session info
  html += `
    <div>
      <div class="text-[10px] font-mono text-text-tertiary uppercase tracking-[2px] mb-2">Session Info</div>
      <div class="text-xs text-text-secondary space-y-1">
        ${meta.numTurns ? `<div>Turns: ${meta.numTurns}</div>` : ''}
        ${meta.stopReason ? `<div>Stop reason: ${escapeHtml(meta.stopReason)}</div>` : ''}
        ${meta.durationMs ? `<div>Total duration: ${formatDuration(meta.durationMs)}</div>` : ''}
        ${meta.durationApiMs ? `<div>API time: ${formatDuration(meta.durationApiMs)}</div>` : ''}
        ${totalCache > 0 ? `<div>Cache tokens read: ${totalCache.toLocaleString()}</div>` : ''}
        ${meta.permissionDenials?.length ? `<div class="text-status-warning">Permission denials: ${meta.permissionDenials.length}</div>` : ''}
      </div>
    </div>
  `;

  html += '</div>';
  container.innerHTML = html;
}

/**
 * Commits tab — shows commits and PR link from worker data
 */
function renderCommitsTab(container, worker) {
  const commits = worker.commits || [];

  if (commits.length === 0) {
    const isActive = worker.status === 'working' || worker.status === 'waiting' || worker.status === 'stale';
    container.innerHTML = `<div class="text-center py-8 text-text-secondary text-sm">${
      isActive ? 'No commits yet — the agent may push commits as it works' : 'No commits in this session'
    }</div>`;
    return;
  }

  // Check for PR URL (may be in resultMeta or worker directly)
  const prUrl = worker.prUrl || null;

  container.innerHTML = `
    <div class="space-y-2">
      ${prUrl ? `
        <a href="${escapeHtml(prUrl)}" target="_blank" rel="noopener" class="flex items-center gap-2 text-sm text-brand hover:underline mb-3">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
            <circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/>
            <path d="M13 6h3a2 2 0 012 2v7"/><line x1="6" y1="9" x2="6" y2="21"/>
          </svg>
          View Pull Request
        </a>
      ` : ''}
      <div class="text-[10px] font-mono text-text-tertiary uppercase tracking-[2px] mb-2">${commits.length} commit${commits.length !== 1 ? 's' : ''}</div>
      ${commits.map(c => `
        <div class="flex items-start gap-3 p-3 bg-surface rounded-lg border border-border-default">
          <code class="text-[11px] font-mono text-brand bg-brand/10 px-1.5 py-0.5 rounded shrink-0">${escapeHtml((c.sha || '').slice(0, 7))}</code>
          <span class="text-sm text-text-primary">${escapeHtml(c.message)}</span>
        </div>
      `).join('')}
    </div>
  `;
}

/**
 * Inject tab bar into the worker detail modal.
 * Called after renderWorkerDetail renders the modal content.
 */
function injectTabBar() {
  if (window._workerDetailTabs._skipTabInject) return;

  // Insert tab bar after description, before timeline
  const chatTimeline = document.getElementById('chatTimeline');
  if (!chatTimeline) return;

  // Check if tabs already exist
  let existingTabs = document.getElementById('workerDetailTabs');
  if (existingTabs) {
    // Update active state
    existingTabs.querySelectorAll('button').forEach(btn => {
      const isActive = btn.dataset.tab === activeTab;
      btn.classList.toggle('border-brand', isActive);
      btn.classList.toggle('text-brand', isActive);
      btn.classList.toggle('border-transparent', !isActive);
      btn.classList.toggle('text-text-secondary', !isActive);
    });
    return;
  }

  // Create and insert tab bar
  const tabBarEl = document.createElement('div');
  tabBarEl.innerHTML = renderTabBar();
  const tabBar = tabBarEl.firstElementChild;

  // Insert before chatTimeline
  chatTimeline.parentElement.insertBefore(tabBar, chatTimeline);
}

/**
 * Reset tabs when opening a new worker
 */
function resetForWorker(workerId) {
  if (currentTabWorkerId !== workerId) {
    activeTab = 'timeline';
    currentTabWorkerId = workerId;
  }
}

// Patch renderWorkerDetail to inject tabs after render
if (typeof renderWorkerDetail === 'function' && !renderWorkerDetail._tabsPatched) {
  const _origRender = renderWorkerDetail;
  renderWorkerDetail = function(worker, opts) {
    if (window._workerDetailTabs._skipTabInject) {
      return _origRender(worker, opts);
    }
    // Always let the original render run (keeps data fresh)
    const result = _origRender(worker, opts);
    // Inject tab bar
    injectTabBar();
    // If on a non-timeline tab, re-render that tab's content over the timeline
    if (activeTab !== 'timeline') {
      const timelineEl = document.getElementById('chatTimeline');
      const scrollBtn = document.getElementById('scrollToBottomBtn');
      if (scrollBtn) scrollBtn.classList.add('hidden');
      if (timelineEl) {
        if (activeTab === 'logs') renderLogsTab(timelineEl, worker);
        else if (activeTab === 'cost') renderCostTab(timelineEl, worker);
        else if (activeTab === 'commits') renderCommitsTab(timelineEl, worker);
      }
    }
    return result;
  };
  renderWorkerDetail._tabsPatched = true;
}

// Patch openWorkerModal to reset tabs
if (typeof openWorkerModal === 'function' && !openWorkerModal._tabsPatched) {
  const _origOpen = openWorkerModal;
  openWorkerModal = function(workerId) {
    resetForWorker(workerId);
    return _origOpen(workerId);
  };
  openWorkerModal._tabsPatched = true;
}

// Export
window._workerDetailTabs = {
  switchTab,
  filterLogs,
  injectTabBar,
  resetForWorker,
  _skipTabInject: false,
  _currentLogs: [],
};
