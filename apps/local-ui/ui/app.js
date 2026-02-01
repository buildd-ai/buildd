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
const tasksEl = document.getElementById('tasks');
const workerModal = document.getElementById('workerModal');
const taskModal = document.getElementById('taskModal');
const settingsModal = document.getElementById('settingsModal');

// Setup UI elements
const manualKeyBtn = document.getElementById('manualKeyBtn');
const manualKeyForm = document.getElementById('manualKeyForm');
const apiKeyInput = document.getElementById('apiKeyInput');
const cancelKeyBtn = document.getElementById('cancelKeyBtn');
const saveKeyBtn = document.getElementById('saveKeyBtn');
const setupError = document.getElementById('setupError');

let isServerless = false;

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

    if (isConfigured || isServerless) {
      showApp();
    } else {
      showSetup();
    }
  } catch (err) {
    console.error('Failed to check config:', err);
    showSetup();
  }
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
  if (workers.length === 0) {
    workersEl.innerHTML = '<div class="empty">No active workers</div>';
    return;
  }

  workersEl.innerHTML = workers.map(w => `
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
  `).join('');

  // Add click handlers
  workersEl.querySelectorAll('.worker-card').forEach(card => {
    card.onclick = () => openWorkerModal(card.dataset.id);
  });
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

  if (pending.length === 0) {
    tasksEl.innerHTML = '<div class="empty">No pending tasks</div>';
    return;
  }

  tasksEl.innerHTML = pending.map(t => `
    <div class="task-card" data-id="${t.id}">
      <div class="card-header">
        <div class="status-dot pending"></div>
        <div class="card-title">${escapeHtml(t.title)}</div>
      </div>
      <div class="card-meta">${escapeHtml(t.workspace?.name || 'Unknown')}</div>
    </div>
  `).join('');

  // Add click handlers
  tasksEl.querySelectorAll('.task-card').forEach(card => {
    card.onclick = () => claimTask(card.dataset.id);
  });
}

function renderWorkerDetail(worker) {
  document.getElementById('modalTitle').textContent = worker.taskTitle;

  document.getElementById('modalMeta').innerHTML = `
    <span class="meta-tag">${worker.workspaceName}</span>
    <span class="meta-tag">${worker.branch}</span>
    <span class="meta-tag">${worker.status}</span>
  `;

  document.getElementById('modalMilestones').innerHTML = `
    <h3>Milestones</h3>
    <div class="milestone-list">
      ${worker.milestones.slice(-10).map(m => `
        <div class="milestone-item">
          <span class="check">&#10003;</span>
          <span>${escapeHtml(m.label)}</span>
        </div>
      `).join('')}
    </div>
  `;

  document.getElementById('modalOutput').innerHTML = `
    <h3>Output</h3>
    <div class="output-box" id="outputBox">${escapeHtml(worker.output.slice(-50).join('\n'))}</div>
  `;

  document.getElementById('modalCommits').innerHTML = worker.commits.length > 0 ? `
    <h3>Commits</h3>
    <div class="commit-list">
      ${worker.commits.map(c => `
        <div class="commit-item">
          <span class="commit-sha">${c.sha.slice(0, 7)}</span>
          <span>${escapeHtml(c.message)}</span>
        </div>
      `).join('')}
    </div>
  ` : '';
}

function appendOutput(line) {
  const box = document.getElementById('outputBox');
  if (box) {
    box.textContent += '\n' + line;
    box.scrollTop = box.scrollHeight;
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

  const maxEl = document.getElementById('settingsMax');
  maxEl.innerHTML = [1, 2, 3, 4].map(n => `
    <button class="btn ${n === config.maxConcurrent ? 'btn-primary' : 'btn-secondary'}">${n}</button>
  `).join('');
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
function initCustomSelect(id, onSelect) {
  const container = document.getElementById(id);
  if (!container) return;

  const trigger = container.querySelector('.custom-select-trigger');
  const dropdown = container.querySelector('.custom-select-dropdown');
  const options = container.querySelector('.custom-select-options');

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !dropdown.classList.contains('hidden');
    closeAllDropdowns();
    if (!isOpen) {
      dropdown.classList.remove('hidden');
      container.classList.add('open');
    }
  });

  options.addEventListener('click', (e) => {
    const option = e.target.closest('.custom-select-option');
    if (option && !option.classList.contains('disabled')) {
      const value = option.dataset.value;
      const label = option.textContent;
      selectOption(container, value, label);
      if (onSelect) onSelect(value);
      closeAllDropdowns();
    }
  });

  return {
    setOptions: (opts) => {
      options.innerHTML = opts.map(o => `
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

async function loadWorkspaces() {
  try {
    const res = await fetch('/api/combined-workspaces');
    const data = await res.json();
    combinedWorkspaces = data.workspaces || [];

    const hint = document.getElementById('workspaceHint');
    const hiddenInput = document.getElementById('taskWorkspace');

    // Initialize custom select if not done
    if (!workspaceSelect) {
      workspaceSelect = initCustomSelect('workspaceSelect', (value) => {
        selectedWorkspaceId = value;
        hiddenInput.value = value;
      });
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
      // Auto-select first
      if (!selectedWorkspaceId && ready[0]) {
        selectedWorkspaceId = ready[0].id;
        hiddenInput.value = ready[0].id;
        workspaceSelect.setValue(ready[0].id, ready[0].name);
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
