// State
let workers = [];
let tasks = [];
let workspaces = [];
let config = {};
let currentWorkerId = null;
let attachments = [];
let isConfigured = false;

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
    banner.className = 'auth-warning-banner';
    banner.innerHTML = `
      <div class="auth-warning-content">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span>Claude credentials not found. Run <code>claude login</code> in terminal, then restart buildd.</span>
      </div>
    `;
    document.querySelector('.main')?.prepend(banner);
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
        alert('Failed to enable serverless mode');
      }
    } catch (err) {
      alert('Error: ' + err.message);
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
      config = event.config || {};
      // Check if configured from SSE init
      if (event.configured === false) {
        showSetup();
        return;
      }
      renderWorkers();
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

// Render functions
function renderWorkers() {
  const active = workers.filter(w => ['working', 'stale'].includes(w.status));
  const completed = workers.filter(w => ['done', 'error'].includes(w.status));

  // Render active workers
  if (active.length === 0) {
    workersEl.innerHTML = '<div class="empty">No active workers</div>';
  } else {
    workersEl.innerHTML = active.map(w => renderWorkerCard(w)).join('');
    workersEl.querySelectorAll('.worker-card').forEach(card => {
      card.onclick = () => openWorkerModal(card.dataset.id);
    });
  }

  // Render completed section
  renderCompletedSection(completed);
}

function renderWorkerCard(w) {
  return `
    <div class="worker-card" data-id="${w.id}">
      <div class="card-header">
        <div class="status-dot ${getStatusClass(w)}"></div>
        <div class="card-title">${escapeHtml(w.taskTitle)}</div>
        <div class="card-badge">${w.status}</div>
      </div>
      <div class="card-meta">${escapeHtml(w.workspaceName)} &bull; ${w.branch}</div>
      <div class="milestones">
        ${renderMilestoneBoxes(w.milestones)}
        <span class="milestone-count">${w.milestones.length}</span>
      </div>
      <div class="card-action">${escapeHtml(w.currentAction)}</div>
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
  const recent = completed.slice(0, 10); // Show last 10

  completedEl.innerHTML = `
    <div class="section-header-collapsible ${completedCollapsed ? 'collapsed' : ''}" onclick="toggleCompleted()">
      <span class="section-title">Completed (${completed.length})</span>
      <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
    </div>
    <div class="completed-list ${completedCollapsed ? 'hidden' : ''}">
      ${recent.map(w => renderCompletedCard(w)).join('')}
    </div>
  `;

  // Add click handlers
  completedEl.querySelectorAll('.worker-card').forEach(card => {
    card.onclick = () => openWorkerModal(card.dataset.id);
  });
}

function renderCompletedCard(w) {
  return `
    <div class="worker-card completed-card" data-id="${w.id}">
      <div class="card-header">
        <div class="status-dot ${w.status}"></div>
        <div class="card-title">${escapeHtml(w.taskTitle)}</div>
        <div class="card-badge">${w.status}</div>
      </div>
      <div class="card-meta">${escapeHtml(w.workspaceName)} &bull; ${w.milestones.length} milestones</div>
    </div>
  `;
}

function toggleCompleted() {
  completedCollapsed = !completedCollapsed;
  const completed = workers.filter(w => ['done', 'error'].includes(w.status));
  renderCompletedSection(completed);
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
    html += `<div class="milestone-box ${i < completed ? 'completed' : ''}"></div>`;
  }
  return html;
}

function renderTasks() {
  const pending = tasks.filter(t => t.status === 'pending');
  const assigned = tasks.filter(t => t.status === 'assigned');

  let html = '';

  // Pending tasks
  if (pending.length === 0) {
    html += '<div class="empty">No pending tasks</div>';
  } else {
    html += pending.map(t => `
      <div class="task-card" data-id="${t.id}">
        <div class="card-header">
          <div class="status-dot pending"></div>
          <div class="card-title">${escapeHtml(t.title)}</div>
        </div>
        <div class="card-meta">${escapeHtml(t.workspace?.name || 'Unknown')}</div>
      </div>
    `).join('');
  }

  // Assigned tasks section
  if (assigned.length > 0) {
    html += `
      <div class="assigned-section">
        <div class="section-label">Assigned Elsewhere (${assigned.length})</div>
        ${assigned.map(t => {
          const isStale = t.expiresAt && new Date(t.expiresAt) < new Date();
          const staleLabel = isStale ? '<span class="badge badge-warning">Stale</span>' : '';
          return `
            <div class="task-card assigned-card" data-id="${t.id}" data-stale="${isStale}">
              <div class="card-header">
                <div class="status-dot assigned"></div>
                <div class="card-title">${escapeHtml(t.title)}</div>
                ${staleLabel}
              </div>
              <div class="card-meta">${escapeHtml(t.workspace?.name || 'Unknown')}</div>
              <div class="card-actions">
                <button class="btn btn-small btn-secondary takeover-btn" data-id="${t.id}" data-stale="${isStale}">
                  Take Over
                </button>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  tasksEl.innerHTML = html;

  // Add click handlers for pending tasks
  tasksEl.querySelectorAll('.task-card:not(.assigned-card)').forEach(card => {
    card.onclick = () => claimTask(card.dataset.id);
  });

  // Add click handlers for takeover buttons
  tasksEl.querySelectorAll('.takeover-btn').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      takeoverTask(btn.dataset.id, btn);
    };
  });
}

function renderWorkerDetail(worker) {
  document.getElementById('modalTitle').textContent = worker.taskTitle;

  document.getElementById('modalMeta').innerHTML = `
    <span class="meta-tag">${worker.workspaceName}</span>
    <span class="meta-tag">${worker.branch}</span>
    <span class="meta-tag status-${worker.status}">${worker.status}</span>
  `;

  // Render description with markdown support
  const descriptionEl = document.getElementById('modalDescription');
  if (worker.taskDescription) {
    descriptionEl.innerHTML = `
      <div class="task-description-card">
        <div class="task-description-header">Task</div>
        <div class="markdown-content">${marked.parse(worker.taskDescription)}</div>
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
        return `
          <div class="chat-msg chat-agent">
            <div class="chat-msg-content">
              <div class="markdown-content">${marked.parse(group.items.map(m => m.content).join('\n\n'))}</div>
            </div>
          </div>`;
      }
      if (group.type === 'user') {
        return group.items.map(m => `
          <div class="chat-msg chat-user">
            <div class="chat-msg-label">You</div>
            <div class="chat-msg-content">${escapeHtml(m.content)}</div>
          </div>`).join('');
      }
      if (group.type === 'tool_use') {
        return `
          <div class="chat-tool-group">
            ${group.items.map(m => renderToolCallInline(m)).join('')}
          </div>`;
      }
      return '';
    }).join('');
  } else {
    // Fallback: render from old output/toolCalls arrays for backwards compat
    const fallbackHtml = worker.output.length > 0
      ? `<div class="chat-msg chat-agent"><div class="chat-msg-content"><div class="output-box">${escapeHtml(worker.output.slice(-50).join('\n'))}</div></div></div>`
      : '<div class="chat-empty">Waiting for agent output...</div>';
    timelineEl.innerHTML = fallbackHtml;
  }

  // Status indicator at bottom
  if (worker.status === 'working' || worker.status === 'stale') {
    timelineEl.innerHTML += `
      <div class="chat-status">
        <div class="chat-status-dot"></div>
        <span>${escapeHtml(worker.currentAction)}</span>
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
  const messageInputEl = document.querySelector('.modal-input');
  if (worker.status === 'working' || worker.status === 'done') {
    messageInputEl.classList.remove('hidden');
    const placeholder = worker.status === 'done'
      ? 'Give the agent a follow-up task...'
      : 'Send a message to the agent...';
    document.getElementById('messageInput').placeholder = placeholder;
  } else {
    messageInputEl.classList.add('hidden');
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
    <div class="chat-tool-call">
      <span class="chat-tool-icon">${icon}</span>
      <span class="chat-tool-name">${escapeHtml(name)}</span>
      ${detail ? `<span class="chat-tool-detail">${escapeHtml(detail)}</span>` : ''}
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
  document.getElementById('settingsServer').value = config.builddServer || '';

  const modelSelect = document.getElementById('settingsModel');
  if (modelSelect && config.model) {
    modelSelect.value = config.model;
  }

  const maxEl = document.getElementById('settingsMax');
  maxEl.innerHTML = [1, 2, 3, 4].map(n => `
    <button class="btn ${n === config.maxConcurrent ? 'btn-primary' : 'btn-secondary'}">${n}</button>
  `).join('');
}

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
      showToast(`Model updated to ${getModelDisplayName(model)}. New workers will use this model.`);
    } else {
      alert('Failed to update model');
    }
  } catch (err) {
    console.error('Failed to update model:', err);
    alert('Failed to update model');
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

function showToast(message) {
  // Remove existing toast
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => toast.classList.add('show'));

  // Remove after 3s
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
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
        <div class="custom-select-option ${o.disabled ? 'disabled' : ''}" data-value="${o.value}">
          ${o.icon ? `<span class="option-icon">${o.icon}</span>` : ''}
          <span class="option-label">${escapeHtml(o.label)}</span>
          ${o.hint ? `<span class="option-hint">${escapeHtml(o.hint)}</span>` : ''}
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

    // Only show ready workspaces in dropdown
    const ready = combinedWorkspaces.filter(w => w.status === 'ready');
    const needsClone = combinedWorkspaces.filter(w => w.status === 'needs-clone');
    const localOnly = combinedWorkspaces.filter(w => w.status === 'local-only');

    let options = [];

    if (ready.length > 0) {
      options = ready.map(w => ({
        value: w.id,
        label: w.name,
        hint: w.localPath?.split('/').pop() || '',
      }));
      hint.classList.add('hidden');

      // Default to last used workspace if available and still ready
      const lastWorkspaceId = getLastWorkspace();
      const lastWorkspace = lastWorkspaceId ? ready.find(w => w.id === lastWorkspaceId) : null;
      const defaultWorkspace = lastWorkspace || ready[0];

      if (!selectedWorkspaceId && defaultWorkspace) {
        selectedWorkspaceId = defaultWorkspace.id;
        hiddenInput.value = defaultWorkspace.id;
        workspaceSelect.setValue(defaultWorkspace.id, defaultWorkspace.name);
      }
    } else {
      options = [{ value: '', label: 'No workspaces ready', disabled: true }];

      if (needsClone.length > 0) {
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
    <div class="workspace-item">
      <div class="workspace-info">
        <div class="workspace-name">${escapeHtml(w.name)}</div>
        <div class="workspace-path">${escapeHtml(w.localPath)}</div>
      </div>
      <span class="badge badge-success">Ready</span>
    </div>
  `).join('') : '<div class="empty-small">None</div>';

  document.getElementById('workspacesNeedsClone').innerHTML = needsClone.length ? needsClone.map(w => `
    <div class="workspace-item">
      <div class="workspace-info">
        <div class="workspace-name">${escapeHtml(w.name)}</div>
        <div class="workspace-repo">${escapeHtml(w.repo || '')}</div>
      </div>
      <button class="btn btn-small btn-primary" onclick="cloneWorkspace('${w.id}', '${escapeHtml(w.repo)}')">
        Clone
      </button>
    </div>
  `).join('') : '<div class="empty-small">None</div>';

  document.getElementById('workspacesLocalOnly').innerHTML = localOnly.length ? localOnly.map(w => `
    <div class="workspace-item">
      <div class="workspace-info">
        <div class="workspace-name">${escapeHtml(w.name)}</div>
        <div class="workspace-repo">${escapeHtml(w.normalizedUrl || '')}</div>
      </div>
      <button class="btn btn-small btn-secondary" onclick="syncWorkspace('${escapeHtml(w.localPath)}', '${escapeHtml(w.name)}')">
        Sync
      </button>
    </div>
  `).join('') : '<div class="empty-small">None</div>';
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
      alert(`Clone failed: ${err.error}`);
      return;
    }

    // Refresh
    await renderWorkspaceModal();
    await loadWorkspaces();
  } catch (err) {
    alert('Clone failed: ' + err.message);
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
      alert(`Sync failed: ${err.error}`);
      return;
    }

    // Refresh
    await renderWorkspaceModal();
    await loadWorkspaces();
  } catch (err) {
    alert('Sync failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync';
  }
}

async function claimTask(taskId) {
  try {
    const res = await fetch('/api/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId })
    });
    const data = await res.json();
    if (data.worker) {
      loadTasks();
    } else {
      alert(data.error || 'Failed to claim task');
    }
  } catch (err) {
    console.error('Failed to claim task:', err);
    alert('Failed to claim task');
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
      showToast('Task taken over successfully');
      loadTasks();
    } else {
      const errorMsg = data.error || 'Failed to take over task';
      if (data.canTakeover === false) {
        alert(`${errorMsg}\n\nYou can only take over tasks that are:\n- Stale (expired)\n- In a workspace you own`);
      } else {
        alert(errorMsg);
      }
    }
  } catch (err) {
    console.error('Failed to take over task:', err);
    alert('Failed to take over task');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }
}

async function abortWorker() {
  if (!currentWorkerId) return;
  try {
    await fetch('/api/abort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId: currentWorkerId })
    });
    closeWorkerModal();
  } catch (err) {
    console.error('Failed to abort:', err);
  }
}

async function markDone() {
  if (!currentWorkerId) return;
  try {
    await fetch('/api/done', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId: currentWorkerId })
    });
    closeWorkerModal();
  } catch (err) {
    console.error('Failed to mark done:', err);
  }
}

async function sendMessage() {
  if (!currentWorkerId) return;
  const input = document.getElementById('messageInput');
  const message = input.value.trim();
  if (!message) return;

  try {
    await fetch(`/api/workers/${currentWorkerId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message })
    });
    input.value = '';
  } catch (err) {
    console.error('Failed to send message:', err);
  }
}

async function createTask() {
  const workspaceId = selectedWorkspaceId || document.getElementById('taskWorkspace').value;
  const title = document.getElementById('taskTitle').value.trim();
  const description = document.getElementById('taskDescription').value.trim();

  if (!workspaceId || !title) {
    alert('Please select a workspace and fill in the title');
    return;
  }

  try {
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

    await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    closeTaskModal();
    loadTasks();
  } catch (err) {
    console.error('Failed to create task:', err);
    alert('Failed to create task');
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
    <div class="attachment-preview">
      <img src="${a.data}" alt="${a.filename}">
      <div class="remove" data-index="${i}">&times;</div>
    </div>
  `).join('') + `
    <label class="attachment-add">
      <input type="file" id="fileInput" accept="image/*" multiple hidden>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
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
  attachments = [];
  renderAttachments();
}

// Utils
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Event listeners
document.getElementById('refreshBtn').onclick = loadTasks;
document.getElementById('addBtn').onclick = openTaskModal;
document.getElementById('settingsBtn').onclick = openSettingsModal;

document.getElementById('modalBack').onclick = closeWorkerModal;
document.getElementById('modalAbort').onclick = abortWorker;
document.getElementById('modalAbortBtn').onclick = abortWorker;
document.getElementById('modalDoneBtn').onclick = markDone;

document.getElementById('taskModalBack').onclick = closeTaskModal;
document.getElementById('taskModalCancel').onclick = closeTaskModal;
document.getElementById('taskModalCreate').onclick = createTask;

document.getElementById('settingsModalBack').onclick = closeSettingsModal;

const modelSelect = document.getElementById('settingsModel');
if (modelSelect) {
  modelSelect.onchange = handleModelChange;
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
    // Wait for workers to load, then open modal
    const checkAndOpen = () => {
      const worker = workers.find(w => w.id === workerId);
      if (worker) {
        openWorkerModal(workerId);
      } else {
        // Worker not loaded yet, retry
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
