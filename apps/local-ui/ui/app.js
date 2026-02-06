// State
let workers = [];
let tasks = [];
let workspaces = [];
let config = {};
let currentWorkerId = null;
let attachments = [];
let isConfigured = false;
let currentAccountId = null;

// Elements
const setupEl = document.getElementById('setup');
const appEl = document.getElementById('app');
const workersEl = document.getElementById('workers');
const completedEl = document.getElementById('completed');
const completedSectionEl = document.getElementById('completedSection');
const tasksEl = document.getElementById('tasks');
const workerModal = document.getElementById('workerModal');
const taskModal = document.getElementById('taskModal');
const settingsModal = document.getElementById('settingsModal');

// State for collapsed completed section
let completedCollapsed = true;

// Setup UI elements
const manualKeyBtn = document.getElementById('manualKeyBtn');
const manualKeyForm = document.getElementById('manualKeyForm');
const apiKeyInput = document.getElementById('apiKeyInput');
const cancelKeyBtn = document.getElementById('cancelKeyBtn');
const saveKeyBtn = document.getElementById('saveKeyBtn');
const setupError = document.getElementById('setupError');

let isServerless = false;

let hasClaudeCredentials = false;

// Check configuration on startup
async function checkConfig() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) {
      console.error('Config fetch failed:', res.status);
      showSetup();
      return;
    }
    const data = await res.json();
    console.log('Config check:', data);
    isConfigured = data.configured;
    isServerless = data.serverless;
    hasClaudeCredentials = data.hasClaudeCredentials;
    currentAccountId = data.accountId || null;
    // Store config values from API response
    config.bypassPermissions = data.bypassPermissions || false;
    config.acceptRemoteTasks = data.acceptRemoteTasks !== false; // default true
    config.openBrowser = data.openBrowser !== false; // default true
    config.model = data.model || config.model;
    config.maxConcurrent = data.maxConcurrent || 3;
    updateOutboxBadge(data.outboxCount || 0);

    if (isConfigured || isServerless) {
      showApp();
      // Show warning if no Claude credentials found
      if (!hasClaudeCredentials) {
        showClaudeAuthWarning();
      }
    } else {
      showSetup();
    }
  } catch (err) {
    console.error('Failed to check config:', err);
    showSetup();
  }
}

function showClaudeAuthWarning() {
  // Create warning banner if not exists
  let banner = document.getElementById('claudeAuthBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'claudeAuthBanner';
    banner.className = 'bg-red-500/10 border border-red-500/30 rounded-lg py-3 px-4 mb-4';
    banner.innerHTML = `
      <div class="flex items-center gap-3 text-red-500 text-sm">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20" class="shrink-0">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span>Claude credentials not found. Run <code class="bg-black/30 py-0.5 px-1.5 rounded font-mono text-[13px]">claude login</code> in terminal, then restart buildd.</span>
      </div>
    `;
    document.querySelector('main')?.prepend(banner);
  }
  banner.classList.remove('hidden');
}

function showSetup() {
  setupEl.classList.remove('hidden');
  appEl.classList.add('hidden');
}

function showApp() {
  setupEl.classList.add('hidden');
  appEl.classList.remove('hidden');
  connectSSE();
  loadTasks();
}

// Setup event handlers
if (manualKeyBtn) {
  manualKeyBtn.addEventListener('click', () => {
    manualKeyForm.classList.remove('hidden');
    manualKeyBtn.classList.add('hidden');
    document.getElementById('serverlessBtn')?.classList.add('hidden');
    apiKeyInput.focus();
  });
}

// Serverless mode button
const serverlessBtn = document.getElementById('serverlessBtn');
if (serverlessBtn) {
  serverlessBtn.addEventListener('click', async () => {
    serverlessBtn.disabled = true;
    serverlessBtn.textContent = 'Setting up...';

    try {
      const res = await fetch('/api/config/serverless', { method: 'POST' });
      if (res.ok) {
        window.location.reload();
      } else {
        showToast('Failed to enable serverless mode', 'error');
      }
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    } finally {
      serverlessBtn.disabled = false;
      serverlessBtn.textContent = 'Use Local Only (no server)';
    }
  });
}

if (cancelKeyBtn) {
  cancelKeyBtn.addEventListener('click', () => {
    manualKeyForm.classList.add('hidden');
    manualKeyBtn.classList.remove('hidden');
    apiKeyInput.value = '';
    setupError.classList.add('hidden');
  });
}

if (saveKeyBtn) {
  saveKeyBtn.addEventListener('click', async () => {
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
      showSetupError('Please enter an API key');
      return;
    }

    saveKeyBtn.disabled = true;
    saveKeyBtn.textContent = 'Verifying...';

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey }),
      });

      const data = await res.json();

      if (!res.ok) {
        showSetupError(data.error || 'Failed to save API key');
        return;
      }

      // Success - reload page
      window.location.reload();
    } catch (err) {
      showSetupError('Connection error');
    } finally {
      saveKeyBtn.disabled = false;
      saveKeyBtn.textContent = 'Save';
    }
  });
}

function showSetupError(msg) {
  setupError.textContent = msg;
  setupError.classList.remove('hidden');
}

// SSE connection
let eventSource = null;

function connectSSE() {
  if (eventSource) {
    eventSource.close();
  }

  eventSource = new EventSource('/api/events');

  eventSource.onmessage = (e) => {
    const event = JSON.parse(e.data);
    handleEvent(event);
  };

  eventSource.onerror = () => {
    console.error('SSE connection error, reconnecting...');
    setTimeout(connectSSE, 3000);
  };
}

function handleEvent(event) {
  switch (event.type) {
    case 'init':
      workers = event.workers || [];
      // Merge SSE config into existing config (don't overwrite fields from /api/config)
      config = { ...config, ...(event.config || {}) };
      // Check if configured from SSE init
      if (event.configured === false) {
        showSetup();
        return;
      }
      renderWorkers();
      loadTasks(); // Refresh tasks on SSE (re)connect
      updateSettings();
      break;

    case 'worker_update':
      const idx = workers.findIndex(w => w.id === event.worker.id);
      if (idx >= 0) {
        workers[idx] = event.worker;
      } else {
        workers.push(event.worker);
      }
      renderWorkers();
      if (currentWorkerId === event.worker.id) {
        renderWorkerDetail(event.worker);
      }
      // When a worker reaches terminal state, refresh tasks to remove it from "Assigned Elsewhere"
      if (['done', 'error'].includes(event.worker.status)) {
        loadTasks();
      }
      break;

    case 'workers':
      workers = event.workers;
      renderWorkers();
      break;

    case 'tasks':
      tasks = event.tasks;
      renderTasks();
      break;

    case 'output':
      if (currentWorkerId === event.workerId) {
        appendOutput(event.line);
      }
      break;
  }
}

// Time formatting helpers
function formatRelativeTime(timestamp) {
  if (!timestamp) return '';
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (seconds < 60) return `${seconds}s ago`;
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// Render functions
function renderWorkers() {
  const active = workers.filter(w => ['working', 'stale'].includes(w.status));
  const waiting = workers.filter(w => w.status === 'waiting');
  const completed = workers.filter(w => ['done', 'error'].includes(w.status));
  const pending = tasks.filter(t => t.status === 'pending');

  // Update stats bar
  updateStats(active.length + waiting.length, pending.length, completed.length);

  // Check if we should show empty hero
  const hasActivity = active.length > 0 || waiting.length > 0 || pending.length > 0;
  const emptyHero = document.getElementById('emptyHero');
  const contentSections = document.getElementById('contentSections');
  const statsBar = document.getElementById('statsBar');

  if (!hasActivity && completed.length === 0) {
    emptyHero.classList.remove('hidden');
    contentSections.classList.add('hidden');
    if (statsBar) statsBar.classList.add('hidden');
    return;
  } else {
    emptyHero.classList.add('hidden');
    contentSections.classList.remove('hidden');
    if (statsBar) statsBar.classList.remove('hidden');
  }

  // Render waiting workers (needs attention - top priority)
  const waitingSection = document.getElementById('waitingSection');
  const waitingEl = document.getElementById('waiting');
  if (waiting.length > 0) {
    waitingSection.classList.remove('hidden');
    waitingEl.innerHTML = waiting.map(w => renderWaitingCard(w)).join('');
    waitingEl.querySelectorAll('.waiting-banner').forEach(card => {
      card.onclick = () => openWorkerModal(card.dataset.id);
    });
  } else {
    waitingSection.classList.add('hidden');
    waitingEl.innerHTML = '';
  }

  // Render active workers
  const activeSection = document.getElementById('activeSection');
  if (active.length > 0) {
    activeSection.classList.remove('hidden');
    workersEl.innerHTML = active.map(w => renderWorkerCard(w)).join('');
    workersEl.querySelectorAll('.worker-card').forEach(card => {
      card.onclick = () => openWorkerModal(card.dataset.id);
    });
  } else {
    activeSection.classList.add('hidden');
    workersEl.innerHTML = '';
  }

  // Render completed section
  renderCompletedSection(completed);
}

function updateStats(activeCount, pendingCount, completedCount) {
  const statActive = document.getElementById('statActive');
  const statPending = document.getElementById('statPending');
  const statCompleted = document.getElementById('statCompleted');
  if (statActive) statActive.textContent = activeCount;
  if (statPending) statPending.textContent = pendingCount;
  if (statCompleted) statCompleted.textContent = completedCount;
}

function renderWorkerCard(w) {
  return `
    <div class="worker-card bg-zinc-900 rounded-xl p-4 cursor-pointer transition-all duration-200 relative active:scale-[0.98] active:bg-zinc-800 hover:bg-zinc-800" data-id="${w.id}">
      <div class="flex items-start gap-3 mb-2">
        <div class="status-dot w-2.5 h-2.5 rounded-full mt-[5px] shrink-0 ${getStatusClass(w)}"></div>
        <div class="flex-1 text-[15px] font-medium leading-relaxed">${escapeHtml(w.taskTitle)}</div>
        <div class="text-xs text-zinc-400 bg-zinc-800 py-1 px-2 rounded">${w.status}</div>
      </div>
      <div class="text-[13px] text-zinc-400 mb-2.5">${escapeHtml(w.workspaceName)} &bull; ${w.branch}</div>
      <div class="flex gap-1 mb-2">
        ${renderMilestoneBoxes(w.milestones)}
        <span class="text-xs text-zinc-400 ml-2">${w.milestones.length}</span>
      </div>
      <div class="text-[13px] text-zinc-400 whitespace-nowrap overflow-hidden text-ellipsis">${escapeHtml(w.currentAction)}</div>
    </div>
  `;
}

function renderWaitingCard(w) {
  const question = w.waitingFor?.prompt || 'Awaiting input';
  const truncatedQuestion = question.length > 120 ? question.slice(0, 120) + '...' : question;
  return `
    <div class="waiting-banner bg-gradient-to-br from-orange-500/[0.12] to-orange-500/[0.04] border border-orange-500/30 rounded-xl py-3.5 px-4 cursor-pointer transition-all duration-200 mb-1 active:scale-[0.98] hover:border-orange-500" data-id="${w.id}">
      <div class="flex items-center gap-2.5 mb-1.5">
        <div class="status-dot w-2.5 h-2.5 rounded-full shrink-0 waiting"></div>
        <div class="flex-1 text-[15px] font-medium text-zinc-50">${escapeHtml(w.taskTitle)}</div>
        <div class="text-[11px] font-semibold uppercase tracking-wide text-orange-500 bg-orange-500/15 py-0.5 px-2 rounded">${'needs input'}</div>
      </div>
      <div class="text-[13px] text-zinc-400 pl-5 leading-relaxed">${escapeHtml(truncatedQuestion)}</div>
    </div>
  `;
}

function renderCompletedSection(completed) {
  if (completed.length === 0) {
    completedSectionEl.classList.add('hidden');
    completedEl.innerHTML = '';
    return;
  }

  completedSectionEl.classList.remove('hidden');
  // Sort by completedAt descending (most recent first), fallback to lastActivity
  const sorted = [...completed].sort((a, b) => {
    const aTime = a.completedAt || a.lastActivity || 0;
    const bTime = b.completedAt || b.lastActivity || 0;
    return bTime - aTime;
  });
  const recent = sorted.slice(0, 10); // Show last 10

  completedEl.innerHTML = `
    <div class="section-header-collapsible flex items-center justify-between py-2 cursor-pointer select-none hover:opacity-80 ${completedCollapsed ? 'collapsed' : ''}" onclick="toggleCompleted()">
      <span class="text-[13px] font-semibold text-zinc-400 uppercase tracking-wide">Completed (${completed.length})</span>
      <svg class="chevron text-zinc-400 transition-transform duration-200" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
    </div>
    <div class="flex flex-col gap-2 mt-2 ${completedCollapsed ? 'hidden' : ''}">
      ${recent.map(w => renderCompletedCard(w)).join('')}
    </div>
  `;

  // Add click handlers
  completedEl.querySelectorAll('.worker-card').forEach(card => {
    card.onclick = () => openWorkerModal(card.dataset.id);
  });
}

function renderCompletedCard(w) {
  const timeAgo = formatRelativeTime(w.completedAt || w.lastActivity);
  return `
    <div class="worker-card bg-zinc-900 rounded-xl p-3 cursor-pointer transition-all duration-200 relative opacity-70 hover:opacity-100" data-id="${w.id}">
      <div class="flex items-start gap-3 mb-1">
        <div class="status-dot w-2.5 h-2.5 rounded-full mt-[5px] shrink-0 ${w.status}"></div>
        <div class="flex-1 text-[15px] font-medium leading-relaxed">${escapeHtml(w.taskTitle)}</div>
        <div class="text-xs text-zinc-400 bg-zinc-800 py-1 px-2 rounded">${w.status}</div>
      </div>
      <div class="text-[13px] text-zinc-400">${escapeHtml(w.workspaceName)} &bull; ${w.milestones.length} milestones${timeAgo ? ` &bull; ${timeAgo}` : ''}</div>
    </div>
  `;
}

function toggleCompleted() {
  completedCollapsed = !completedCollapsed;
  const completed = workers.filter(w => ['done', 'error'].includes(w.status));
  renderCompletedSection(completed);
}

function toggleDescription(btn) {
  const card = btn.closest('.task-description-card');
  const isCollapsed = card.classList.contains('collapsed');
  card.classList.toggle('collapsed', !isCollapsed);
  card.classList.toggle('expanded', isCollapsed);
  btn.querySelector('.expand-text').textContent = isCollapsed ? 'Show less' : 'Show more';
}

function toggleAgentMessage(btn) {
  const msg = btn.closest('.chat-agent');
  const isCollapsed = msg.classList.contains('collapsed');
  msg.classList.toggle('collapsed', !isCollapsed);
  msg.classList.toggle('expanded', isCollapsed);
  btn.querySelector('.expand-text').textContent = isCollapsed ? 'Show less' : 'Show more';
}

function getStatusClass(worker) {
  if (worker.hasNewActivity) return 'new';
  return worker.status;
}

function renderMilestoneBoxes(milestones) {
  const max = 10;
  const completed = Math.min(milestones.length, max);
  let html = '';
  for (let i = 0; i < max; i++) {
    html += `<div class="w-6 h-2 rounded-sm ${i < completed ? 'bg-fuchsia-500' : 'bg-zinc-800'}"></div>`;
  }
  return html;
}

function renderTasks() {
  const pending = tasks.filter(t => t.status === 'pending');
  // Only show tasks assigned to OTHER accounts (not our own)
  // If currentAccountId is unknown, don't show any as "assigned elsewhere" (avoid false positives)
  const assigned = currentAccountId
    ? tasks.filter(t => t.status === 'assigned' && t.claimedBy !== currentAccountId)
    : [];

  // Update stats when tasks change
  const active = workers.filter(w => ['working', 'stale', 'waiting'].includes(w.status));
  const completed = workers.filter(w => ['done', 'error'].includes(w.status));
  updateStats(active.length, pending.length, completed.length);

  // Show/hide empty hero
  const hasActivity = active.length > 0 || pending.length > 0;
  const emptyHero = document.getElementById('emptyHero');
  const contentSections = document.getElementById('contentSections');
  const statsBar = document.getElementById('statsBar');
  if (!hasActivity && completed.length === 0) {
    emptyHero.classList.remove('hidden');
    contentSections.classList.add('hidden');
    if (statsBar) statsBar.classList.add('hidden');
  } else {
    emptyHero.classList.add('hidden');
    contentSections.classList.remove('hidden');
    if (statsBar) statsBar.classList.remove('hidden');
  }

  // Show/hide pending section
  const pendingSection = document.getElementById('pendingSection');
  if (pending.length === 0 && assigned.length === 0) {
    pendingSection.classList.add('hidden');
  } else {
    pendingSection.classList.remove('hidden');
  }

  let html = '';

  // Pending tasks
  if (pending.length === 0 && assigned.length === 0) {
    html += '';
  } else if (pending.length === 0) {
    // Only assigned, no pending - skip empty message
  } else {
    html += pending.map(t => `
      <div class="bg-zinc-900 rounded-xl py-3.5 px-4 cursor-pointer transition-all duration-200 relative border border-transparent hover:bg-zinc-800 hover:border-zinc-700 active:scale-[0.98]" data-id="${t.id}">
        <div class="flex items-start gap-2.5">
          <div class="status-dot w-2.5 h-2.5 rounded-full mt-[5px] shrink-0 pending"></div>
          <div class="flex-1 min-w-0">
            <div class="text-[15px] font-medium leading-relaxed text-zinc-50 mb-1">${escapeHtml(t.title)}</div>
            <div class="text-xs text-zinc-400 flex items-center gap-1">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-3 h-3 opacity-60">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              </svg>
              ${escapeHtml(t.workspace?.name || 'Unknown')}
            </div>
          </div>
          <button class="task-card-start shrink-0 py-1.5 px-3.5 text-[13px] font-medium bg-gradient-primary text-white border-none rounded-md cursor-pointer transition-all duration-150 whitespace-nowrap hover:opacity-90 active:scale-95" data-id="${t.id}">Start</button>
        </div>
      </div>
    `).join('');
  }

  // Assigned tasks section
  if (assigned.length > 0) {
    html += `
      <div class="mt-6 pt-4 border-t border-zinc-700">
        <div class="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-3">Assigned Elsewhere (${assigned.length})</div>
        ${assigned.map(t => {
          const isStale = t.expiresAt && new Date(t.expiresAt) < new Date();
          const staleLabel = isStale ? '<span class="py-1 px-2 text-[11px] font-medium rounded uppercase bg-amber-400/15 text-orange-500">Stale</span>' : '';
          return `
            <div class="bg-zinc-900 rounded-xl p-4 cursor-default opacity-80 hover:opacity-100" data-id="${t.id}" data-stale="${isStale}">
              <div class="flex items-start gap-3 mb-2">
                <div class="status-dot w-2.5 h-2.5 rounded-full mt-[5px] shrink-0 assigned"></div>
                <div class="flex-1 text-[15px] font-medium leading-relaxed">${escapeHtml(t.title)}</div>
                ${staleLabel}
              </div>
              <div class="text-[13px] text-zinc-400">${escapeHtml(t.workspace?.name || 'Unknown')}</div>
              <div class="mt-3 flex gap-2">
                <button class="btn py-1.5 px-3 text-[13px] bg-zinc-800 text-zinc-50 rounded-lg font-medium cursor-pointer transition-all duration-200 takeover-btn" data-id="${t.id}" data-stale="${isStale}">
                  Take Over
                </button>
                <button class="btn py-1.5 px-3 text-[13px] bg-red-500 text-white rounded-lg font-medium cursor-pointer transition-all duration-200 hover:bg-red-600 delete-btn" data-id="${t.id}" title="Delete task">
                  Delete
                </button>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  tasksEl.innerHTML = html;

  // Add click handlers for Start buttons on pending tasks
  tasksEl.querySelectorAll('.task-card-start').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      claimTask(btn.dataset.id);
    };
  });

  // Add click handler for card body (also starts)
  tasksEl.querySelectorAll('[data-id]:not(.takeover-btn):not(.delete-btn):not(.task-card-start)').forEach(card => {
    if (card.closest('.mt-6')) return; // Skip assigned cards
    card.onclick = () => claimTask(card.dataset.id);
  });

  // Add click handlers for takeover buttons
  tasksEl.querySelectorAll('.takeover-btn').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      takeoverTask(btn.dataset.id, btn);
    };
  });

  // Add click handlers for delete buttons
  tasksEl.querySelectorAll('.delete-btn').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      deleteTask(btn.dataset.id, btn);
    };
  });
}

function renderWorkerDetail(worker) {
  document.getElementById('modalTitle').textContent = worker.taskTitle;

  document.getElementById('modalMeta').innerHTML = `
    <span class="text-xs bg-zinc-800 py-1.5 px-2.5 rounded text-zinc-400">${worker.workspaceName}</span>
    <span class="text-xs bg-zinc-800 py-1.5 px-2.5 rounded text-zinc-400">${worker.branch}</span>
    <span class="text-xs bg-zinc-800 py-1.5 px-2.5 rounded text-zinc-400 meta-tag status-${worker.status}">${worker.status}</span>
  `;

  // Render description with markdown support (collapsible if long)
  const descriptionEl = document.getElementById('modalDescription');
  if (worker.taskDescription) {
    const isLongDescription = worker.taskDescription.length > 300 || worker.taskDescription.split('\n').length > 6;
    descriptionEl.innerHTML = `
      <div class="task-description-card bg-zinc-900 rounded-lg py-3 px-3.5 mb-2 border-l-[3px] border-l-fuchsia-500 relative ${isLongDescription ? 'collapsed' : ''}">
        <div class="text-[11px] font-semibold text-zinc-400 uppercase tracking-wide mb-1.5">Task</div>
        <div class="markdown-content text-[13px] leading-normal">${marked.parse(worker.taskDescription)}</div>
        ${isLongDescription ? `
          <button class="expand-btn hidden items-center justify-center gap-1 w-full pt-1.5 pb-0.5 text-xs text-zinc-400 bg-none border-none cursor-pointer transition-colors duration-150 hover:text-fuchsia-500" onclick="toggleDescription(this)">
            <span class="expand-text">Show more</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-3.5 h-3.5 transition-transform duration-200">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
        ` : ''}
      </div>
    `;
  } else {
    descriptionEl.innerHTML = '';
  }

  // Render chat timeline
  const timelineEl = document.getElementById('chatTimeline');
  const existingTimeline = timelineEl;
  const scrollPos = existingTimeline ? existingTimeline.scrollTop : null;
  const wasAtBottom = existingTimeline
    ? (existingTimeline.scrollHeight - existingTimeline.scrollTop - existingTimeline.clientHeight < 100)
    : true;

  const messages = worker.messages || [];
  const hasMessages = messages.length > 0;

  if (hasMessages) {
    // Group consecutive same-type messages for cleaner rendering
    const grouped = groupMessages(messages);
    timelineEl.innerHTML = grouped.map(group => {
      if (group.type === 'text') {
        const combinedContent = group.items.map(m => m.content).join('\n\n');
        const isLong = combinedContent.length > 800 || combinedContent.split('\n').length > 15;
        return `
          <div class="chat-msg chat-agent max-w-[90%] animate-chat-fade-in self-start ${isLong ? 'collapsed' : ''}">
            <div class="chat-msg-content bg-zinc-900 rounded-tl-sm rounded-tr-lg rounded-br-lg rounded-bl-lg py-2.5 px-3.5 text-sm leading-relaxed relative">
              <div class="markdown-content text-sm">${marked.parse(combinedContent)}</div>
              ${isLong ? `
                <button class="expand-msg-btn hidden items-center justify-center gap-1 w-full pt-2 pb-0.5 text-xs text-zinc-400 bg-none border-none cursor-pointer transition-colors duration-150 hover:text-fuchsia-500" onclick="toggleAgentMessage(this)">
                  <span class="expand-text">Show more</span>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-3.5 h-3.5 transition-transform duration-200">
                    <polyline points="6 9 12 15 18 9"/>
                  </svg>
                </button>
              ` : ''}
            </div>
          </div>`;
      }
      if (group.type === 'user') {
        return group.items.map(m => `
          <div class="chat-msg max-w-[90%] animate-chat-fade-in self-end">
            <div class="text-[11px] text-zinc-400 mb-1 text-right">You</div>
            <div class="bg-fuchsia-500 bg-gradient-to-br from-fuchsia-500/25 to-cyan-400/15 border border-fuchsia-500/30 rounded-tl-lg rounded-tr-sm rounded-br-lg rounded-bl-lg py-2.5 px-3.5 text-sm leading-normal text-zinc-50">${escapeHtml(m.content)}</div>
          </div>`).join('');
      }
      if (group.type === 'tool_use') {
        return `
          <div class="flex flex-col gap-0.5 self-start max-w-[90%]">
            ${group.items.map(m => renderToolCallInline(m)).join('')}
          </div>`;
      }
      return '';
    }).join('');
  } else {
    // Fallback: render from old output/toolCalls arrays for backwards compat
    const fallbackHtml = worker.output.length > 0
      ? `<div class="chat-msg chat-agent max-w-[90%] animate-chat-fade-in self-start"><div class="chat-msg-content bg-zinc-900 rounded-tl-sm rounded-tr-lg rounded-br-lg rounded-bl-lg py-2.5 px-3.5 text-sm leading-relaxed relative"><div class="bg-zinc-900 rounded-lg p-3 font-mono text-[13px] leading-normal max-h-[300px] overflow-y-auto whitespace-pre-wrap break-words">${escapeHtml(worker.output.slice(-50).join('\n'))}</div></div></div>`
      : '<div class="text-center py-8 text-zinc-400 text-sm">Waiting for agent output...</div>';
    timelineEl.innerHTML = fallbackHtml;
  }

  // Status indicator at bottom
  if (worker.status === 'working') {
    timelineEl.innerHTML += `
      <div class="flex items-center gap-2 py-2 text-[13px] text-zinc-400">
        <div class="w-2 h-2 rounded-full bg-fuchsia-500 animate-pulse-fast shrink-0"></div>
        <span>${escapeHtml(worker.currentAction)}</span>
      </div>`;
  }

  // Stale worker indicator
  if (worker.status === 'stale') {
    timelineEl.innerHTML += `
      <div class="bg-gradient-to-br from-orange-500/15 to-orange-500/5 border border-orange-500 rounded-xl p-4 my-4">
        <div class="flex items-center gap-2 text-xs text-orange-500 font-semibold uppercase tracking-wide mb-2">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          Agent appears stuck
        </div>
        <div class="text-sm text-zinc-50 leading-normal mb-2">No activity for over 2 minutes. Last action: ${escapeHtml(worker.currentAction)}</div>
        <div class="text-xs text-zinc-400">Send a message below to nudge the agent, or use Retry to restart the session</div>
        <button class="btn py-1.5 px-3 text-[13px] bg-zinc-800 text-zinc-50 rounded-lg font-medium cursor-pointer transition-all duration-200 mt-2" onclick="retryWorker()">Retry</button>
      </div>`;
  }

  // Question prompt for waiting workers
  if (worker.status === 'waiting' && worker.waitingFor) {
    const options = worker.waitingFor.options || [];
    timelineEl.innerHTML += `
      <div class="bg-gradient-to-br from-orange-500/15 to-orange-500/5 border border-orange-500 rounded-xl p-4 my-4">
        <div class="text-xs text-orange-500 font-semibold uppercase tracking-wide mb-2">Agent is asking:</div>
        <div class="text-sm text-zinc-50 leading-normal mb-3">${escapeHtml(worker.waitingFor.prompt)}</div>
        ${options.length > 0 ? `
          <div class="flex flex-wrap gap-2">
            ${options.map((opt, i) => `
              <button class="flex flex-col items-start gap-0.5 py-2.5 px-4 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-50 text-[13px] font-medium cursor-pointer transition-all duration-150 ease-in-out hover:bg-zinc-900 hover:border-orange-500" data-option="${i}"
                onclick="sendQuestionAnswer('${escapeHtml(opt.label)}')">
                ${escapeHtml(opt.label)}
                ${opt.description ? `<span class="text-[11px] text-zinc-400 font-normal">${escapeHtml(opt.description)}</span>` : ''}
              </button>
            `).join('')}
          </div>
        ` : ''}
      </div>`;
  }

  // Error indicator for failed/aborted workers
  if (worker.status === 'error') {
    timelineEl.innerHTML += `
      <div class="bg-gradient-to-br from-red-500/15 to-red-500/5 border border-red-500 rounded-xl p-4 my-4">
        <div class="flex items-center gap-2 text-xs text-red-500 font-semibold uppercase tracking-wide mb-2">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          Task stopped
        </div>
        <div class="text-sm text-zinc-50 leading-normal mb-2">${escapeHtml(worker.error || 'Task was aborted or failed')}</div>
        <div class="text-xs text-zinc-400">Send a message below to restart with new instructions</div>
      </div>`;
  }

  // Restore scroll position (only auto-scroll if was at bottom)
  if (scrollPos !== null) {
    if (wasAtBottom) {
      timelineEl.scrollTop = timelineEl.scrollHeight;
    } else {
      timelineEl.scrollTop = scrollPos;
    }
  } else {
    timelineEl.scrollTop = timelineEl.scrollHeight;
  }

  // Show/hide message input based on status
  // Allow input for working, done, waiting, stale, AND error (to restart/continue)
  const messageInputEl = workerModal.querySelector('.border-t.bg-zinc-900');
  if (worker.status === 'working' || worker.status === 'done' || worker.status === 'waiting' || worker.status === 'error' || worker.status === 'stale') {
    messageInputEl.classList.remove('hidden');
    let placeholder = 'Send a message to the agent...';
    if (worker.status === 'done') {
      placeholder = 'Give the agent a follow-up task...';
    } else if (worker.status === 'waiting') {
      placeholder = 'Type your answer or click an option above...';
    } else if (worker.status === 'error') {
      placeholder = 'Send a message to restart the task...';
    } else if (worker.status === 'stale') {
      placeholder = 'Send a message to nudge the agent...';
    }
    document.getElementById('messageInput').placeholder = placeholder;
  } else {
    messageInputEl.classList.add('hidden');
  }

  // Show/hide footer action buttons based on status
  const modalFooter = document.getElementById('modalFooter');
  const abortBtn = document.getElementById('modalAbortBtn');
  const doneBtn = document.getElementById('modalDoneBtn');

  if (worker.status === 'working' || worker.status === 'waiting' || worker.status === 'stale') {
    modalFooter.classList.remove('hidden');
    abortBtn.classList.remove('hidden');
    doneBtn.classList.remove('hidden');
  } else if (worker.status === 'done' || worker.status === 'error') {
    // Hide footer entirely for completed/failed tasks - message input handles follow-ups
    modalFooter.classList.add('hidden');
  } else {
    modalFooter.classList.add('hidden');
  }
}

// Group consecutive messages of the same type
function groupMessages(messages) {
  const groups = [];
  let current = null;
  for (const msg of messages) {
    if (current && current.type === msg.type) {
      current.items.push(msg);
    } else {
      current = { type: msg.type, items: [msg] };
      groups.push(current);
    }
  }
  return groups;
}

// Render a tool call as an inline compact card
function renderToolCallInline(tc) {
  const name = tc.name;
  const input = tc.input || {};
  let detail = '';
  let icon = '';

  if (name === 'Read') {
    icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
    detail = shortPath(input.file_path);
  } else if (name === 'Edit') {
    icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
    detail = shortPath(input.file_path);
  } else if (name === 'Write') {
    icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`;
    detail = shortPath(input.file_path);
  } else if (name === 'Bash') {
    icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`;
    const cmd = input.command || '';
    detail = cmd.length > 80 ? cmd.slice(0, 80) + '...' : cmd;
  } else if (name === 'Glob' || name === 'Grep') {
    icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
    detail = input.pattern || input.query || '';
  } else if (name === 'Task') {
    icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`;
    detail = input.description || name;
  } else {
    icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>`;
    detail = input.file_path || input.command || name;
  }

  return `
    <div class="flex items-center gap-1.5 py-1 px-2.5 bg-zinc-900 border-l-2 border-l-zinc-800 rounded-r text-xs text-zinc-400 overflow-hidden">
      <span class="shrink-0 flex items-center text-zinc-400 opacity-70">${icon}</span>
      <span class="font-semibold text-fuchsia-500 text-xs shrink-0">${escapeHtml(name)}</span>
      ${detail ? `<span class="font-mono text-[11px] text-zinc-400 whitespace-nowrap overflow-hidden text-ellipsis min-w-0">${escapeHtml(detail)}</span>` : ''}
    </div>`;
}

// Shorten file paths to last 2-3 segments
function shortPath(p) {
  if (!p) return '';
  const parts = p.split('/');
  return parts.length > 3 ? '.../' + parts.slice(-3).join('/') : p;
}

function appendOutput(line) {
  const box = document.getElementById('outputBox');
  if (box) {
    box.textContent += '\n' + line;
    // Only auto-scroll if user is already at bottom (within 100px threshold)
    const isAtBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 100;
    if (isAtBottom) {
      box.scrollTop = box.scrollHeight;
    }
  }
}

// Modals
function openWorkerModal(workerId) {
  currentWorkerId = workerId;
  const worker = workers.find(w => w.id === workerId);
  if (!worker) return;

  // Mark as read
  fetch('/api/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workerId })
  });

  renderWorkerDetail(worker);
  workerModal.classList.remove('hidden');
}

function closeWorkerModal() {
  currentWorkerId = null;
  workerModal.classList.add('hidden');
}

function openTaskModal() {
  loadWorkspaces();
  taskModal.classList.remove('hidden');
}

function closeTaskModal() {
  taskModal.classList.add('hidden');
  clearTaskForm();
}

function openSettingsModal() {
  settingsModal.classList.remove('hidden');
}

function closeSettingsModal() {
  settingsModal.classList.add('hidden');
}

function updateSettings() {
  document.getElementById('settingsRoot').value = config.projectsRoot || '';
  const serverInput = document.getElementById('settingsServer');
  serverInput.value = config.builddServer || '';

  // Show save button when server URL is modified
  const serverSaveBtn = document.getElementById('settingsServerSave');
  serverInput.oninput = () => {
    const changed = serverInput.value.trim() !== (config.builddServer || '');
    serverSaveBtn.style.display = changed ? '' : 'none';
  };

  const modelSelect = document.getElementById('settingsModel');
  if (modelSelect && config.model) {
    modelSelect.value = config.model;
  }

  const maxEl = document.getElementById('settingsMax');
  maxEl.innerHTML = `
    <input type="number" min="1" max="20" value="${config.maxConcurrent || 3}"
      class="bg-zinc-900 border border-zinc-700 rounded-lg py-2 px-3 text-sm text-zinc-50 w-20 focus:outline-none focus:border-fuchsia-500"
      id="settingsMaxInput">
  `;

  const maxInput = document.getElementById('settingsMaxInput');
  let maxDebounce = null;
  maxInput.onchange = () => {
    const val = Math.max(1, Math.min(20, parseInt(maxInput.value) || 1));
    maxInput.value = val;
    clearTimeout(maxDebounce);
    maxDebounce = setTimeout(() => handleMaxConcurrentChange(val), 300);
  };

  const bypassCheckbox = document.getElementById('settingsBypass');
  if (bypassCheckbox) {
    bypassCheckbox.checked = config.bypassPermissions || false;
  }

  const acceptRemoteCheckbox = document.getElementById('settingsAcceptRemote');
  if (acceptRemoteCheckbox) {
    acceptRemoteCheckbox.checked = config.acceptRemoteTasks !== false;
  }

  const openBrowserCheckbox = document.getElementById('settingsOpenBrowser');
  if (openBrowserCheckbox) {
    openBrowserCheckbox.checked = config.openBrowser !== false;
  }
}

// Handle server URL change
async function handleServerUrlChange() {
  const serverInput = document.getElementById('settingsServer');
  const serverSaveBtn = document.getElementById('settingsServerSave');
  const hint = document.getElementById('settingsServerHint');
  const server = serverInput.value.trim();

  if (!server) return;

  serverSaveBtn.disabled = true;
  serverSaveBtn.textContent = 'Saving...';

  try {
    const res = await fetch('/api/config/server', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server }),
    });
    const data = await res.json();
    if (data.ok) {
      config.builddServer = data.builddServer;
      serverSaveBtn.style.display = 'none';
      hint.textContent = 'Server URL updated. Reconnecting...';
      hint.style.color = '#22c55e';
      // Reconnect SSE and reload all data
      connectSSE();
      await Promise.all([loadTasks(), loadWorkspaces()]);
      hint.textContent = 'Server URL updated. Connection reinitialized.';
      setTimeout(() => {
        hint.textContent = 'Reinitializes connection when changed';
        hint.style.color = '';
      }, 3000);
    } else {
      hint.textContent = data.error || 'Failed to update server URL';
      hint.style.color = '#ef4444';
    }
  } catch (err) {
    hint.textContent = 'Failed to save server URL';
    hint.style.color = '#ef4444';
  } finally {
    serverSaveBtn.disabled = false;
    serverSaveBtn.textContent = 'Save';
  }
}

// Outbox badge UI
function updateOutboxBadge(count) {
  const btn = document.getElementById('outboxBtn');
  const badge = document.getElementById('outboxBadge');
  if (!btn || !badge) return;
  if (count > 0) {
    btn.classList.remove('hidden');
    badge.textContent = count > 99 ? '99+' : count;
    btn.title = `${count} pending sync item(s) - click to flush`;
  } else {
    btn.classList.add('hidden');
  }
}

async function handleOutboxFlush() {
  const btn = document.getElementById('outboxBtn');
  btn.style.opacity = '0.5';
  btn.style.pointerEvents = 'none';
  try {
    const res = await fetch('/api/outbox/flush', { method: 'POST' });
    const data = await res.json();
    updateOutboxBadge(data.remaining || 0);
    if (data.flushed > 0) {
      console.log(`Outbox: synced ${data.flushed} items`);
    }
  } catch (err) {
    console.error('Outbox flush failed:', err);
  } finally {
    btn.style.opacity = '';
    btn.style.pointerEvents = '';
  }
}

// Poll outbox status periodically (picks up changes from background flushes)
setInterval(async () => {
  try {
    const res = await fetch('/api/outbox');
    const data = await res.json();
    updateOutboxBadge(data.count || 0);
  } catch { /* ignore */ }
}, 30000);

// Handle model selection change
async function handleModelChange() {
  const modelSelect = document.getElementById('settingsModel');
  const model = modelSelect.value;

  try {
    const res = await fetch('/api/config/model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });

    if (res.ok) {
      config.model = model;
      // Show success feedback
      showToast(`Model updated to ${getModelDisplayName(model)}. New workers will use this model.`, 'success');
    } else {
      showToast('Failed to update model', 'error');
    }
  } catch (err) {
    console.error('Failed to update model:', err);
    showToast('Failed to update model', 'error');
  }
}

async function handleBypassChange() {
  const bypassCheckbox = document.getElementById('settingsBypass');
  const enabled = bypassCheckbox.checked;

  try {
    const res = await fetch('/api/config/bypass-permissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });

    if (res.ok) {
      config.bypassPermissions = enabled;
      showToast(enabled
        ? 'Permission bypass enabled. New workers will skip permission prompts.'
        : 'Permission bypass disabled. New workers will use standard permissions.', 'success');
    } else {
      bypassCheckbox.checked = !enabled; // Revert
      showToast('Failed to update bypass permissions', 'error');
    }
  } catch (err) {
    console.error('Failed to update bypass permissions:', err);
    bypassCheckbox.checked = !enabled; // Revert
    showToast('Failed to update bypass permissions', 'error');
  }
}

async function handleAcceptRemoteChange() {
  const acceptRemoteCheckbox = document.getElementById('settingsAcceptRemote');
  const enabled = acceptRemoteCheckbox.checked;

  try {
    const res = await fetch('/api/config/accept-remote-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });

    if (res.ok) {
      config.acceptRemoteTasks = enabled;
      showToast(enabled
        ? 'Remote task assignments enabled. Dashboard can push tasks to this worker.'
        : 'Remote task assignments disabled. Tasks will only run when started locally.', 'success');
    } else {
      acceptRemoteCheckbox.checked = !enabled; // Revert
      showToast('Failed to update remote task setting', 'error');
    }
  } catch (err) {
    console.error('Failed to update remote task setting:', err);
    acceptRemoteCheckbox.checked = !enabled; // Revert
    showToast('Failed to update remote task setting', 'error');
  }
}

async function handleOpenBrowserChange() {
  const openBrowserCheckbox = document.getElementById('settingsOpenBrowser');
  const enabled = openBrowserCheckbox.checked;

  try {
    const res = await fetch('/api/config/open-browser', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });

    if (res.ok) {
      config.openBrowser = enabled;
      showToast(enabled
        ? 'Auto-open browser enabled. Browser will open on next startup.'
        : 'Auto-open browser disabled.', 'success');
    } else {
      openBrowserCheckbox.checked = !enabled; // Revert
      showToast('Failed to update browser setting', 'error');
    }
  } catch (err) {
    console.error('Failed to update browser setting:', err);
    openBrowserCheckbox.checked = !enabled; // Revert
    showToast('Failed to update browser setting', 'error');
  }
}

async function handleMaxConcurrentChange(value) {
  try {
    const res = await fetch('/api/config/max-concurrent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxConcurrent: value }),
    });

    if (res.ok) {
      config.maxConcurrent = value;
      updateSettings(); // Re-render to show active state
      showToast(`Max concurrent workers set to ${value}`, 'success');
    } else {
      showToast('Failed to update max concurrent setting', 'error');
    }
  } catch (err) {
    console.error('Failed to update max concurrent:', err);
    showToast('Failed to update max concurrent setting', 'error');
  }
}

function getModelDisplayName(model) {
  const names = {
    'claude-opus-4-5-20251101': 'Opus 4.5',
    'claude-sonnet-4-5-20250929': 'Sonnet 4.5',
    'claude-haiku-4-20250514': 'Haiku 4',
  };
  return names[model] || model;
}

function showToast(message, type = 'info') {
  // Remove existing toast
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const icons = {
    success: '\u2713',
    error: '\u2715',
    warning: '\u26a0',
    info: '\u2139'
  };

  const borderColors = {
    success: 'border-l-green-500',
    error: 'border-l-red-500',
    warning: 'border-l-orange-500',
    info: 'border-l-blue-500',
  };

  const toast = document.createElement('div');
  toast.className = `toast fixed bottom-6 left-1/2 bg-zinc-800 text-zinc-50 py-3 px-5 rounded-lg shadow-[0_4px_20px_rgba(0,0,0,0.4)] text-sm z-[1000] flex items-center gap-2.5 max-w-[min(500px,90vw)] border-l-[3px] ${borderColors[type] || borderColors.info}`;

  const icon = document.createElement('span');
  icon.className = 'shrink-0 w-[18px] h-[18px]';
  icon.textContent = icons[type] || icons.info;
  toast.appendChild(icon);

  const text = document.createElement('span');
  text.textContent = message;
  toast.appendChild(text);

  document.body.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => toast.classList.add('show'));

  // Remove after delay (longer for errors)
  const duration = type === 'error' ? 5000 : 3000;
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// API calls
async function loadTasks() {
  try {
    const res = await fetch('/api/tasks');
    const data = await res.json();

    // Handle auth errors - show setup screen
    if (data.needsSetup || res.status === 401) {
      console.error('API key invalid, showing setup');
      isConfigured = false;
      showSetup();
      return;
    }

    tasks = data.tasks || [];
    renderTasks();
  } catch (err) {
    console.error('Failed to load tasks:', err);
  }
}

let combinedWorkspaces = [];
let selectedWorkspaceId = '';

// Custom dropdown component
function initCustomSelect(id, onSelect, { searchable = false } = {}) {
  const container = document.getElementById(id);
  if (!container) return;

  const trigger = container.querySelector('.custom-select-trigger');
  const dropdown = container.querySelector('.custom-select-dropdown');
  const optionsContainer = container.querySelector('.custom-select-options');

  let allOptions = [];
  let searchInput = null;

  if (searchable) {
    const searchWrapper = document.createElement('div');
    searchWrapper.className = 'custom-select-search';
    searchWrapper.innerHTML = `
      <input type="text" class="custom-select-search-input" placeholder="Search workspaces...">
    `;
    dropdown.insertBefore(searchWrapper, optionsContainer);
    searchInput = searchWrapper.querySelector('input');

    searchInput.addEventListener('input', () => {
      const query = searchInput.value.toLowerCase().trim();
      filterOptions(query);
    });

    searchInput.addEventListener('click', (e) => e.stopPropagation());
    searchInput.addEventListener('keydown', (e) => {
      const visibleOptions = optionsContainer.querySelectorAll('.custom-select-option:not(.hidden):not(.disabled)');
      const highlighted = optionsContainer.querySelector('.custom-select-option.highlighted');

      if (e.key === 'Escape') {
        closeAllDropdowns();
      } else if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        const toSelect = highlighted || visibleOptions[0];
        if (toSelect) {
          toSelect.click();
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        navigateOptions(visibleOptions, highlighted, 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        navigateOptions(visibleOptions, highlighted, -1);
      }
    });
  }

  function navigateOptions(visibleOptions, current, direction) {
    if (visibleOptions.length === 0) return;

    // Remove current highlight
    if (current) current.classList.remove('highlighted');

    let nextIndex = 0;
    if (current) {
      const currentIndex = Array.from(visibleOptions).indexOf(current);
      nextIndex = currentIndex + direction;
      if (nextIndex < 0) nextIndex = visibleOptions.length - 1;
      if (nextIndex >= visibleOptions.length) nextIndex = 0;
    } else {
      nextIndex = direction > 0 ? 0 : visibleOptions.length - 1;
    }

    const next = visibleOptions[nextIndex];
    next.classList.add('highlighted');
    next.scrollIntoView({ block: 'nearest' });
  }

  function filterOptions(query) {
    const optionEls = optionsContainer.querySelectorAll('.custom-select-option');
    optionEls.forEach((el, i) => {
      const opt = allOptions[i];
      if (!opt) return;
      const matchLabel = opt.label.toLowerCase().includes(query);
      const matchHint = opt.hint && opt.hint.toLowerCase().includes(query);
      el.classList.toggle('hidden', query && !matchLabel && !matchHint);
      el.classList.remove('highlighted');
    });
    // Auto-highlight first visible option
    const firstVisible = optionsContainer.querySelector('.custom-select-option:not(.hidden):not(.disabled)');
    if (firstVisible) firstVisible.classList.add('highlighted');
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !dropdown.classList.contains('hidden');
    closeAllDropdowns();
    if (!isOpen) {
      dropdown.classList.remove('hidden');
      container.classList.add('open');
      if (searchInput) {
        searchInput.value = '';
        filterOptions('');
        setTimeout(() => searchInput.focus(), 0);
      }
    }
  });

  optionsContainer.addEventListener('click', (e) => {
    const option = e.target.closest('.custom-select-option');
    if (option && !option.classList.contains('disabled') && !option.classList.contains('hidden')) {
      const value = option.dataset.value;
      const label = option.querySelector('.option-label')?.textContent || option.textContent;
      selectOption(container, value, label.trim());
      if (onSelect) onSelect(value);
      closeAllDropdowns();
    }
  });

  return {
    setOptions: (opts) => {
      allOptions = opts;
      optionsContainer.innerHTML = opts.map(o => `
        <div class="custom-select-option flex items-center gap-2.5 py-2.5 px-3 rounded-lg cursor-pointer transition-all duration-100 mb-0.5 ${o.disabled ? 'disabled' : ''}" data-value="${o.value}">
          ${o.icon ? `<span class="shrink-0 w-5 h-5 flex items-center justify-center">${o.icon}</span>` : ''}
          <span class="option-label flex-1 whitespace-nowrap overflow-hidden text-ellipsis">${escapeHtml(o.label)}</span>
          ${o.hint ? `<span class="option-hint text-xs text-zinc-400 whitespace-nowrap">${escapeHtml(o.hint)}</span>` : ''}
        </div>
      `).join('');
    },
    setValue: (value, label) => selectOption(container, value, label),
    getValue: () => container.querySelector('.custom-select-trigger').dataset.value || '',
  };
}

function selectOption(container, value, label) {
  const trigger = container.querySelector('.custom-select-trigger');
  const valueEl = trigger.querySelector('.custom-select-value');
  trigger.dataset.value = value;
  valueEl.textContent = label;
  valueEl.classList.toggle('placeholder', !value);
  valueEl.classList.toggle('text-zinc-400', !value);
}

function closeAllDropdowns() {
  document.querySelectorAll('.custom-select-dropdown').forEach(d => d.classList.add('hidden'));
  document.querySelectorAll('.custom-select').forEach(c => c.classList.remove('open'));
}

// Close dropdowns when clicking outside
document.addEventListener('click', closeAllDropdowns);

// Workspace select
let workspaceSelect = null;

const LAST_WORKSPACE_KEY = 'buildd_last_workspace_id';

function saveLastWorkspace(workspaceId) {
  try {
    localStorage.setItem(LAST_WORKSPACE_KEY, workspaceId);
  } catch (e) {
    // localStorage not available
  }
}

function getLastWorkspace() {
  try {
    return localStorage.getItem(LAST_WORKSPACE_KEY);
  } catch (e) {
    return null;
  }
}

async function loadWorkspaces() {
  try {
    const res = await fetch('/api/combined-workspaces');
    const data = await res.json();
    combinedWorkspaces = data.workspaces || [];
    const serverError = data.serverError || null;

    const hint = document.getElementById('workspaceHint');
    const hiddenInput = document.getElementById('taskWorkspace');

    // Initialize custom select if not done (with searchable typeahead)
    if (!workspaceSelect) {
      workspaceSelect = initCustomSelect('workspaceSelect', (value) => {
        selectedWorkspaceId = value;
        hiddenInput.value = value;
        saveLastWorkspace(value);
      }, { searchable: true });
    }

    // Show ready workspaces, or local-only when server is unreachable
    const ready = combinedWorkspaces.filter(w => w.status === 'ready');
    const needsClone = combinedWorkspaces.filter(w => w.status === 'needs-clone');
    const localOnly = combinedWorkspaces.filter(w => w.status === 'local-only');

    // When server is unreachable, treat local-only repos as usable workspaces
    const usable = ready.length > 0 ? ready : (serverError ? localOnly : []);

    let options = [];

    if (usable.length > 0) {
      options = usable.map(w => ({
        value: w.id || w.localPath, // Use localPath as ID fallback for local-only
        label: w.name,
        hint: w.localPath?.split('/').pop() || '',
      }));

      if (serverError) {
        hint.textContent = `Server unreachable - showing ${usable.length} local workspace(s). Change server URL in Settings.`;
        hint.classList.remove('hidden');
      } else {
        hint.classList.add('hidden');
      }

      // Default to last used workspace if available
      const lastWorkspaceId = getLastWorkspace();
      const lastWorkspace = lastWorkspaceId ? usable.find(w => (w.id || w.localPath) === lastWorkspaceId) : null;
      const defaultWorkspace = lastWorkspace || usable[0];

      if (!selectedWorkspaceId && defaultWorkspace) {
        selectedWorkspaceId = defaultWorkspace.id || defaultWorkspace.localPath;
        hiddenInput.value = selectedWorkspaceId;
        workspaceSelect.setValue(selectedWorkspaceId, defaultWorkspace.name);
      }
    } else {
      options = [{ value: '', label: 'No workspaces ready', disabled: true }];

      if (serverError) {
        hint.textContent = `Server unreachable. Check connection or change server URL in Settings.`;
        hint.classList.remove('hidden');
      } else if (needsClone.length > 0) {
        hint.textContent = `${needsClone.length} workspace(s) need to be cloned locally. Click Manage.`;
        hint.classList.remove('hidden');
      } else if (localOnly.length > 0) {
        hint.textContent = `${localOnly.length} local repo(s) can be synced. Click Manage.`;
        hint.classList.remove('hidden');
      } else {
        hint.textContent = 'Add a git repository to your project folder to get started.';
        hint.classList.remove('hidden');
      }
      workspaceSelect.setValue('', 'Select workspace...');
    }

    workspaceSelect.setOptions(options);
  } catch (err) {
    console.error('Failed to load workspaces:', err);
  }
}

// Manage workspaces button
const manageWorkspacesBtn = document.getElementById('manageWorkspacesBtn');
if (manageWorkspacesBtn) {
  manageWorkspacesBtn.addEventListener('click', () => {
    openWorkspaceModal();
  });
}

// Workspace modal
const workspaceModal = document.getElementById('workspaceModal');
const workspaceModalBack = document.getElementById('workspaceModalBack');

if (workspaceModalBack) {
  workspaceModalBack.addEventListener('click', closeWorkspaceModal);
}

// Rescan button
const rescanBtn = document.getElementById('rescanBtn');
if (rescanBtn) {
  rescanBtn.addEventListener('click', async () => {
    rescanBtn.disabled = true;
    const originalText = rescanBtn.innerHTML;
    rescanBtn.innerHTML = `
      <svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
        <path d="M21 12a9 9 0 11-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/>
        <path d="M21 3v5h-5"/>
      </svg>
      Scanning...
    `;

    try {
      const res = await fetch('/api/rescan', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        // Refresh workspace modal data
        await renderWorkspaceModal();
        await loadWorkspaces();
      }
    } catch (err) {
      console.error('Rescan failed:', err);
    } finally {
      rescanBtn.disabled = false;
      rescanBtn.innerHTML = originalText;
    }
  });
}

function openWorkspaceModal() {
  renderWorkspaceModal();
  workspaceModal.classList.remove('hidden');
}

function closeWorkspaceModal() {
  workspaceModal.classList.add('hidden');
}

async function renderWorkspaceModal() {
  // Refresh data
  const res = await fetch('/api/combined-workspaces');
  const data = await res.json();
  combinedWorkspaces = data.workspaces || [];

  const ready = combinedWorkspaces.filter(w => w.status === 'ready');
  const needsClone = combinedWorkspaces.filter(w => w.status === 'needs-clone');
  const localOnly = combinedWorkspaces.filter(w => w.status === 'local-only');

  document.getElementById('workspacesReady').innerHTML = ready.length ? ready.map(w => `
    <div class="flex items-center justify-between p-3 bg-zinc-900 rounded-lg gap-3">
      <div class="flex-1 min-w-0">
        <div class="font-medium whitespace-nowrap overflow-hidden text-ellipsis">${escapeHtml(w.name)}</div>
        <div class="text-xs text-zinc-400 whitespace-nowrap overflow-hidden text-ellipsis">${escapeHtml(w.localPath)}</div>
      </div>
      <span class="py-1 px-2 text-[11px] font-medium rounded uppercase bg-green-500/15 text-green-500">Ready</span>
    </div>
  `).join('') : '<div class="text-[13px] text-zinc-400 py-2">None</div>';

  document.getElementById('workspacesNeedsClone').innerHTML = needsClone.length ? needsClone.map(w => `
    <div class="flex items-center justify-between p-3 bg-zinc-900 rounded-lg gap-3">
      <div class="flex-1 min-w-0">
        <div class="font-medium whitespace-nowrap overflow-hidden text-ellipsis">${escapeHtml(w.name)}</div>
        <div class="text-xs text-zinc-400 whitespace-nowrap overflow-hidden text-ellipsis">${escapeHtml(w.repo || '')}</div>
      </div>
      <button class="btn py-1.5 px-3 text-[13px] bg-gradient-primary text-white rounded-lg font-medium cursor-pointer transition-all duration-200" onclick="cloneWorkspace('${w.id}', '${escapeHtml(w.repo)}')">
        Clone
      </button>
    </div>
  `).join('') : '<div class="text-[13px] text-zinc-400 py-2">None</div>';

  document.getElementById('workspacesLocalOnly').innerHTML = localOnly.length ? localOnly.map(w => `
    <div class="flex items-center justify-between p-3 bg-zinc-900 rounded-lg gap-3">
      <div class="flex-1 min-w-0">
        <div class="font-medium whitespace-nowrap overflow-hidden text-ellipsis">${escapeHtml(w.name)}</div>
        <div class="text-xs text-zinc-400 whitespace-nowrap overflow-hidden text-ellipsis">${escapeHtml(w.normalizedUrl || '')}</div>
      </div>
      <button class="btn py-1.5 px-3 text-[13px] bg-zinc-800 text-zinc-50 rounded-lg font-medium cursor-pointer transition-all duration-200" onclick="syncWorkspace('${escapeHtml(w.localPath)}', '${escapeHtml(w.name)}')">
        Sync
      </button>
    </div>
  `).join('') : '<div class="text-[13px] text-zinc-400 py-2">None</div>';
}

async function cloneWorkspace(workspaceId, repoUrl) {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = 'Cloning...';

  try {
    const res = await fetch('/api/workspaces/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, repoUrl }),
    });

    if (!res.ok) {
      const err = await res.json();
      showToast(`Clone failed: ${err.error}`, 'error');
      return;
    }

    // Refresh
    await renderWorkspaceModal();
    await loadWorkspaces();
    showToast('Workspace cloned successfully', 'success');
  } catch (err) {
    showToast('Clone failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Clone';
  }
}

async function syncWorkspace(localPath, name) {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = 'Syncing...';

  try {
    const res = await fetch('/api/local-repos/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath: localPath, name }),
    });

    if (!res.ok) {
      const err = await res.json();
      showToast(`Sync failed: ${err.error}`, 'error');
      return;
    }

    // Refresh
    await renderWorkspaceModal();
    await loadWorkspaces();
    showToast('Workspace synced successfully', 'success');
  } catch (err) {
    showToast('Sync failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync';
  }
}

async function claimTask(taskId) {
  // Find the task being claimed for optimistic UI
  const task = tasks.find(t => t.id === taskId);

  // Optimistic: move task to active section immediately
  if (task) {
    tasks = tasks.filter(t => t.id !== taskId);
    const optimisticWorker = {
      id: `claiming-${taskId}`,
      taskTitle: task.title,
      workspaceName: task.workspace?.name || 'Unknown',
      branch: '',
      status: 'working',
      hasNewActivity: false,
      lastActivity: Date.now(),
      milestones: [],
      currentAction: 'Starting...',
      _optimistic: true,
    };
    workers.push(optimisticWorker);
    renderTasks();
    renderWorkers();
  }

  // Disable all start buttons to prevent double-click
  tasksEl.querySelectorAll('.task-card-start').forEach(btn => { btn.disabled = true; });

  try {
    const res = await fetch('/api/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId })
    });
    const data = await res.json();
    if (data.worker) {
      // Remove optimistic worker (real one comes via SSE)
      workers = workers.filter(w => w.id !== `claiming-${taskId}`);
      renderWorkers();
      showToast('Task started', 'success');
      loadTasks();
    } else {
      // Failed - restore task to pending
      workers = workers.filter(w => w.id !== `claiming-${taskId}`);
      if (task) tasks.unshift(task);
      renderTasks();
      renderWorkers();
      showToast(data.error || 'Failed to claim task', 'error');
    }
  } catch (err) {
    console.error('Failed to claim task:', err);
    // Restore on error
    workers = workers.filter(w => w.id !== `claiming-${taskId}`);
    if (task) tasks.unshift(task);
    renderTasks();
    renderWorkers();
    showToast('Failed to claim task', 'error');
  }
}

async function takeoverTask(taskId, btn) {
  if (!btn) btn = event?.target;
  const originalText = btn?.textContent || 'Take Over';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Taking over...';
  }

  try {
    const res = await fetch('/api/takeover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId })
    });
    const data = await res.json();

    if (data.worker) {
      showToast('Task taken over successfully', 'success');
      loadTasks();
    } else {
      const errorMsg = data.error || 'Failed to take over task';
      if (data.canTakeover === false) {
        showToast(`${errorMsg}. Only stale tasks in your workspace can be taken over.`, 'error');
      } else {
        showToast(errorMsg, 'error');
      }
    }
  } catch (err) {
    console.error('Failed to take over task:', err);
    showToast('Failed to take over task', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }
}

async function deleteTask(taskId, btn) {
  if (!btn) btn = event?.target;
  const originalText = btn?.textContent || 'Delete';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Deleting...';
  }

  try {
    const res = await fetch(`/api/tasks/${taskId}`, {
      method: 'DELETE',
    });
    const data = await res.json();

    // Handle auth errors - show setup screen
    if (data.needsSetup || res.status === 401) {
      console.error('API key invalid, showing setup');
      isConfigured = false;
      showSetup();
      return;
    }

    if (data.success) {
      showToast('Task deleted', 'success');
      loadTasks();
    } else {
      showToast(data.error || 'Failed to delete task', 'error');
    }
  } catch (err) {
    console.error('Failed to delete task:', err);
    showToast('Failed to delete task', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }
}

async function abortWorker() {
  if (!currentWorkerId) return;
  const abortBtn = document.getElementById('confirmAction');
  if (abortBtn) {
    abortBtn.disabled = true;
    abortBtn.textContent = 'Stopping...';
  }
  try {
    const res = await fetch('/api/abort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId: currentWorkerId })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showToast(data.error || 'Failed to stop task', 'error');
    }
    hideConfirmDialog();
    closeWorkerModal();
  } catch (err) {
    console.error('Failed to abort:', err);
    showToast('Failed to stop task', 'error');
    hideConfirmDialog();
  } finally {
    if (abortBtn) {
      abortBtn.disabled = false;
      abortBtn.textContent = 'Stop Task';
    }
  }
}

function showConfirmDialog(title, message, actionLabel, onConfirm) {
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmMessage').textContent = message;
  const actionBtn = document.getElementById('confirmAction');
  actionBtn.textContent = actionLabel;
  actionBtn.disabled = false;
  actionBtn.onclick = onConfirm;
  document.getElementById('confirmCancel').onclick = hideConfirmDialog;
  const overlay = document.getElementById('confirmDialog');
  overlay.classList.remove('hidden');
  // Close on clicking backdrop
  overlay.onclick = (e) => {
    if (e.target === overlay) hideConfirmDialog();
  };
}

function hideConfirmDialog() {
  document.getElementById('confirmDialog').classList.add('hidden');
}

function confirmAbort() {
  showConfirmDialog(
    'Stop this task?',
    'The agent will be terminated and the task will be marked as failed. You can restart it later by sending a new message.',
    'Stop Task',
    abortWorker
  );
}

async function retryWorker() {
  if (!currentWorkerId) return;
  try {
    const res = await fetch('/api/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId: currentWorkerId })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showToast(data.error || 'Failed to retry task', 'error');
      return;
    }
    showToast('Retrying task...', 'success');
  } catch (err) {
    console.error('Failed to retry:', err);
    showToast('Failed to retry task', 'error');
  }
}

async function markDone() {
  if (!currentWorkerId) return;
  try {
    const res = await fetch('/api/done', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId: currentWorkerId })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showToast(data.error || 'Failed to mark done', 'error');
      return;
    }
    closeWorkerModal();
  } catch (err) {
    console.error('Failed to mark done:', err);
    showToast('Failed to mark done', 'error');
  }
}

async function sendMessage() {
  if (!currentWorkerId) return;
  const input = document.getElementById('messageInput');
  const message = input.value.trim();
  if (!message) return;

  try {
    const res = await fetch(`/api/workers/${currentWorkerId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showToast(data.error || 'Message not delivered', 'error');
      return;
    }
    input.value = '';
  } catch (err) {
    console.error('Failed to send message:', err);
    showToast('Failed to send message', 'error');
  }
}

// Send a predefined answer from question options
async function sendQuestionAnswer(answer) {
  if (!currentWorkerId) return;

  try {
    await fetch(`/api/workers/${currentWorkerId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: answer })
    });
  } catch (err) {
    console.error('Failed to send answer:', err);
  }
}

async function createTask() {
  const workspaceId = selectedWorkspaceId || document.getElementById('taskWorkspace').value;
  const title = document.getElementById('taskTitle').value.trim();
  const description = document.getElementById('taskDescription').value.trim();

  if (!workspaceId || !title) {
    showToast('Please select a workspace and fill in the title', 'warning');
    return;
  }

  // Find workspace name for optimistic rendering
  const workspace = combinedWorkspaces.find(w => (w.id || w.localPath) === workspaceId);
  const workspaceName = workspace?.name || 'Unknown';

  const payload = {
    workspaceId,
    title,
    description,
    attachments: attachments.map(a => ({
      data: a.data,
      mimeType: a.mimeType,
      filename: a.filename
    }))
  };

  // Optimistic: add temp task, close modal, show toast immediately
  const tempId = `temp-${Date.now()}`;
  const optimisticTask = {
    id: tempId,
    title,
    description,
    workspaceId,
    status: 'pending',
    workspace: { name: workspaceName },
    _optimistic: true,
  };
  tasks.unshift(optimisticTask);
  renderTasks();
  closeTaskModal();
  showToast('Task created', 'success');

  // Background POST
  try {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.task) {
      tasks = tasks.map(t => t.id === tempId ? { ...data.task, workspace: data.task.workspace || { name: workspaceName } } : t);
    } else {
      tasks = tasks.filter(t => t.id !== tempId);
      showToast('Failed to create task', 'error');
    }
    renderTasks();
  } catch (err) {
    console.error('Failed to create task:', err);
    tasks = tasks.filter(t => t.id !== tempId);
    renderTasks();
    showToast('Failed to create task', 'error');
  }
}

async function createAndStartTask() {
  const workspaceId = selectedWorkspaceId || document.getElementById('taskWorkspace').value;
  const title = document.getElementById('taskTitle').value.trim();
  const description = document.getElementById('taskDescription').value.trim();

  if (!workspaceId || !title) {
    showToast('Please select a workspace and fill in the title', 'warning');
    return;
  }

  // Find workspace name for optimistic rendering
  const workspace = combinedWorkspaces.find(w => (w.id || w.localPath) === workspaceId);
  const workspaceName = workspace?.name || 'Unknown';

  const payload = {
    workspaceId,
    title,
    description,
    attachments: attachments.map(a => ({
      data: a.data,
      mimeType: a.mimeType,
      filename: a.filename
    }))
  };

  // Optimistic: show task as "Starting..." in active section immediately
  const tempId = `temp-${Date.now()}`;
  const optimisticWorker = {
    id: tempId,
    taskTitle: title,
    workspaceName,
    branch: '',
    status: 'working',
    hasNewActivity: false,
    lastActivity: Date.now(),
    milestones: [],
    currentAction: 'Starting...',
    _optimistic: true,
  };
  workers.push(optimisticWorker);
  renderWorkers();
  closeTaskModal();
  showToast('Task created, starting...', 'success');

  // Background: create task then claim it
  try {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (data.task?.id) {
      // Claim the task - SSE worker_update will replace optimistic worker
      const claimRes = await fetch('/api/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: data.task.id })
      });
      const claimData = await claimRes.json();

      if (claimData.worker) {
        // Remove optimistic worker (real one comes via SSE)
        workers = workers.filter(w => w.id !== tempId);
        renderWorkers();
        loadTasks();
      } else {
        // Claim failed - remove optimistic worker, show error
        workers = workers.filter(w => w.id !== tempId);
        renderWorkers();
        showToast(claimData.error || 'Failed to start task', 'error');
        loadTasks();
      }
    } else {
      // Create failed
      workers = workers.filter(w => w.id !== tempId);
      renderWorkers();
      showToast('Failed to create task', 'error');
    }
  } catch (err) {
    console.error('Failed to create and start task:', err);
    workers = workers.filter(w => w.id !== tempId);
    renderWorkers();
    showToast('Failed to create task', 'error');
  }
}

// Attachments
function handleFileSelect(e) {
  const files = Array.from(e.target.files);
  files.forEach(file => {
    if (!file.type.startsWith('image/')) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      attachments.push({
        data: e.target.result,
        mimeType: file.type,
        filename: file.name
      });
      renderAttachments();
    };
    reader.readAsDataURL(file);
  });
  e.target.value = '';
}

function renderAttachments() {
  const container = document.getElementById('attachments');
  container.innerHTML = attachments.map((a, i) => `
    <div class="w-20 h-20 rounded-lg overflow-hidden relative">
      <img src="${a.data}" alt="${a.filename}" class="w-full h-full object-cover">
      <div class="remove absolute top-1 right-1 w-6 h-6 bg-red-500 rounded-full flex items-center justify-center text-white text-sm cursor-pointer" data-index="${i}">&times;</div>
    </div>
  `).join('') + `
    <label class="w-20 h-20 rounded-lg overflow-hidden relative bg-zinc-900 border-2 border-dashed border-zinc-700 flex items-center justify-center cursor-pointer">
      <input type="file" id="fileInput" accept="image/*" multiple hidden>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-6 h-6 text-zinc-400">
        <path d="M12 5v14M5 12h14"/>
      </svg>
    </label>
  `;

  // Re-attach handlers
  container.querySelector('#fileInput').onchange = handleFileSelect;
  container.querySelectorAll('.remove').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      attachments.splice(parseInt(btn.dataset.index), 1);
      renderAttachments();
    };
  });
}

function clearTaskForm() {
  document.getElementById('taskTitle').value = '';
  document.getElementById('taskDescription').value = '';
  document.getElementById('taskWorkspace').value = '';
  selectedWorkspaceId = '';
  attachments = [];
  renderAttachments();
}

// Utils
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Event listeners
document.getElementById('refreshBtn').onclick = loadTasks;
document.getElementById('addBtn').onclick = openTaskModal;
document.getElementById('settingsBtn').onclick = openSettingsModal;

document.getElementById('modalBack').onclick = closeWorkerModal;
const modalCloseBtn = document.getElementById('modalClose');
if (modalCloseBtn) modalCloseBtn.onclick = closeWorkerModal;
document.getElementById('modalAbortBtn').onclick = confirmAbort;
document.getElementById('modalDoneBtn').onclick = markDone;

document.getElementById('taskModalBack').onclick = closeTaskModal;
document.getElementById('taskModalCancel').onclick = closeTaskModal;
document.getElementById('taskModalCreate').onclick = createTask;
document.getElementById('taskModalStart').onclick = createAndStartTask;

// Hero & inline new task buttons
document.getElementById('heroCreateBtn').onclick = openTaskModal;
document.getElementById('inlineAddBtn').onclick = openTaskModal;

document.getElementById('settingsModalBack').onclick = closeSettingsModal;

const modelSelect = document.getElementById('settingsModel');
if (modelSelect) {
  modelSelect.onchange = handleModelChange;
}

const bypassCheckbox = document.getElementById('settingsBypass');
if (bypassCheckbox) {
  bypassCheckbox.onchange = handleBypassChange;
}

const acceptRemoteCheckbox = document.getElementById('settingsAcceptRemote');
if (acceptRemoteCheckbox) {
  acceptRemoteCheckbox.onchange = handleAcceptRemoteChange;
}

const openBrowserCheckbox = document.getElementById('settingsOpenBrowser');
if (openBrowserCheckbox) {
  openBrowserCheckbox.onchange = handleOpenBrowserChange;
}

document.getElementById('fileInput').onchange = handleFileSelect;

document.getElementById('sendMessageBtn').onclick = sendMessage;
document.getElementById('messageInput').onkeydown = (e) => {
  if (e.key === 'Enter') sendMessage();
};

// Client-side routing
function handleRoute() {
  const path = window.location.pathname;

  // /worker/:id - open worker modal directly
  const workerMatch = path.match(/^\/worker\/([^/]+)$/);
  if (workerMatch) {
    const workerId = workerMatch[1];
    // Wait for workers to load, then open modal (max 10 retries = 5s)
    let retries = 0;
    const checkAndOpen = () => {
      const worker = workers.find(w => w.id === workerId);
      if (worker) {
        openWorkerModal(workerId);
      } else if (retries++ < 10) {
        setTimeout(checkAndOpen, 500);
      }
    };
    checkAndOpen();
  }
}

// Update URL when opening/closing worker modal
function updateUrl(path) {
  if (window.location.pathname !== path) {
    history.pushState({}, '', path);
  }
}

// Override openWorkerModal to update URL
const originalOpenWorkerModal = openWorkerModal;
openWorkerModal = function(workerId) {
  updateUrl(`/worker/${workerId}`);
  return originalOpenWorkerModal(workerId);
};

// Override closeWorkerModal to update URL
const originalCloseWorkerModal = closeWorkerModal;
closeWorkerModal = function() {
  updateUrl('/');
  return originalCloseWorkerModal();
};

// Handle browser back/forward
window.onpopstate = () => {
  const path = window.location.pathname;
  if (path === '/' || path === '/index.html') {
    if (currentWorkerId) {
      originalCloseWorkerModal();
    }
  } else {
    handleRoute();
  }
};

// Initialize
checkConfig().then(() => {
  if (isConfigured) {
    handleRoute();
  }
});
