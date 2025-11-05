// Global state
let credentials = null;
let allTasks = [];
let allProjects = [];
let isOnline = navigator.onLine;
let currentView = 'dashboard';
let currentUser = '';

// IndexedDB for offline storage
const DB_NAME = 'task-manager-db';
const DB_VERSION = 1;
let db = null;

async function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      
      if (!db.objectStoreNames.contains('tasks')) {
        db.createObjectStore('tasks', { keyPath: 'id', autoIncrement: true });
      }
      
      if (!db.objectStoreNames.contains('offline_queue')) {
        db.createObjectStore('offline_queue', { keyPath: 'id', autoIncrement: true });
      }
    };
  });
}

async function saveTaskOffline(taskData) {
  const transaction = db.transaction(['offline_queue'], 'readwrite');
  const store = transaction.objectStore('offline_queue');
  
  const item = {
    data: taskData,
    timestamp: new Date().toISOString(),
    type: 'task'
  };
  
  return new Promise((resolve, reject) => {
    const request = store.add(item);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getOfflineQueue() {
  const transaction = db.transaction(['offline_queue'], 'readonly');
  const store = transaction.objectStore('offline_queue');
  
  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function clearOfflineQueue() {
  const transaction = db.transaction(['offline_queue'], 'readwrite');
  const store = transaction.objectStore('offline_queue');
  
  return new Promise((resolve, reject) => {
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// API Functions
async function apiRequest(endpoint, method = 'GET', data = null) {
  if (!credentials) throw new Error('Not authenticated');
  
  const url = credentials.server.replace(/\/+$/, '') + endpoint;
  const config = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include'
  };
  
  if (data && method !== 'GET') {
    config.body = JSON.stringify(data);
  }
  
  const response = await fetch(url, config);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function createTask(taskData) {
  try {
    showMessage('task-msg', 'Creating task...', '');
    console.log(taskData.assignedTo);
    const payload = {
      doctype: 'Task',
      subject: taskData.subject,
      description: taskData.description || '',
      priority: taskData.priority,
      status: taskData.status,
      exp_start_date: taskData.startDate || '',
      exp_end_date: taskData.endDate || '',
      custom_assigned_to:taskData.assignedTo || '',
      project: taskData.project || ''  // ADD THIS LINE
    
      
    };
    
    if (taskData.assignedTo) {
      payload.custom_assigned_to = taskData.assignedTo;
      payload._assign = JSON.stringify([taskData.assignedTo]);
    }
    
    // Add project only if selected
    if (taskData.project) {
      payload.project = taskData.project;
    }

    console.log('Payload:', payload);

    if (isOnline) {
      await apiRequest('/api/resource/Task', 'POST', payload);
      showMessage('task-msg', '✅ Task created successfully!', 'bb-ok');
      setTimeout(() => {
        closeModal('task-modal');
        loadAllTasks();
      }, 1500);
    } else {
      await saveTaskOffline(payload);
      showMessage('task-msg', '📱 Task saved offline! Will sync when online.', 'bb-ok');
      setTimeout(() => {
        closeModal('task-modal');
        updateOfflineIndicator();
      }, 2000);
    }
  } catch (error) {
    console.error('Task creation error:', error);
    showMessage('task-msg', '❌ Error: ' + error.message, 'bb-err');
  }
}

async function loadAllTasks() {
  try {
    // --- Step 1: Get logged-in user ---
    let loggedUser;
    try {
      const userRes = await apiRequest('/api/method/frappe.auth.get_logged_user');
      loggedUser = userRes.message;
    } catch {
      console.warn("⚠️ Could not get logged user via API, using fallback");
      loggedUser = currentUser || "Guest";
    }

    // --- Step 2: Get roles for that user ---
    let userRoles = [];
    try {
      const rolesRes = await apiRequest(
        `/api/method/shete.server_scripts.user_api.custom_get_user_roles?user=${loggedUser}`
      );
      console.log("rolesRes",rolesRes);
      userRoles = Array.isArray(rolesRes.message) ? rolesRes.message : [];
      console.log("userRoles",userRoles);
    } catch (err) {
      console.warn("⚠️ Could not load roles, defaulting to empty list", err);
    }

    console.log("🧍 User:", loggedUser);
    console.log("🎭 Roles:", userRoles);

    // --- Step 3: Build API URL based on role ---
    let apiUrl;
    if (userRoles.includes('System Manager')) {
      apiUrl = '/api/resource/Task?fields=["*"]&limit_page_length=100';
    } else {
      apiUrl = `/api/resource/Task?fields=["*"]&filters=[["custom_assigned_to","=","${encodeURIComponent(loggedUser)}"]]&limit_page_length=100`;
    }

    // --- Step 4: Fetch tasks ---
    const response = await apiRequest(apiUrl);
    allTasks = response.data || [];

    console.log(`📋 Loaded ${allTasks.length} tasks for ${loggedUser}`);

    // --- Step 5: Render ---
    updateDashboard();
    renderCurrentView();
    renderTeamView();

  } catch (error) {
    console.error('❌ Failed to load tasks:', error);
    showNotification('Failed to load tasks', 'error');
  }
}



async function loadAllProjects() {
  try {
    const response = await apiRequest('/api/resource/Project?fields=["name","project_name","status"]&limit_page_length=200');
    allProjects = response.data || [];
    populateProjectDropdown();
  } catch (error) {
    console.error('Failed to load projects:', error);
  }
}
async function loadAllUsers() {
  try {
    const response = await apiRequest('/api/resource/User?fields=["name","full_name"]&limit_page_length=200');
    allUsers = response.data || [];
    populateUserDropdown();
  } catch (error) {
    console.error('Failed to load users:', error);
  }
}
function populateProjectDropdown() {
  const dropdown = document.getElementById('task-project');
  if (!dropdown) return; // Safety check
  dropdown.innerHTML = '<option value="">No Project</option>';
  
  allProjects.forEach(project => {
    const option = document.createElement('option');
    option.value = project.name;
    option.textContent = project.project_name || project.name;
    dropdown.appendChild(option);
  });
}

async function createProject(projectData) {
  try {
    showMessage('project-msg', 'Creating project...', '');
    
    const payload = {
      project_name: projectData.name,
      status: projectData.status,
      expected_start_date: projectData.startDate || '',
      expected_end_date: projectData.endDate || ''
    };
    
    const result = await apiRequest('/api/resource/Project', 'POST', payload);
    showMessage('project-msg', '✅ Project created successfully!', 'bb-ok');
    
    setTimeout(async () => {
      closeModal('project-modal');
      await loadAllProjects();
      // Auto-select the newly created project
      document.getElementById('task-project').value = result.data.name;
      showNotification('Project created and selected!', 'success');
    }, 1500);
  } catch (error) {
    console.error('Project creation error:', error);
    showMessage('project-msg', '❌ Error: ' + error.message, 'bb-err');
  }
}

// UI Functions
function showMessage(elementId, message, className) {
  const el = document.getElementById(elementId);
  el.textContent = message;
  el.className = 'bb-msg ' + className;
}

function showNotification(message, type = 'info') {
  const colors = {
    success: '#10b981',
    error: '#ef4444',
    warning: '#f59e0b',
    info: '#3b82f6'
  };
  
  const notification = document.createElement('div');
  notification.style.cssText = `
    position: fixed;
    top: 90px;
    right: 24px;
    background: ${colors[type]};
    color: white;
    padding: 16px 20px;
    border-radius: 12px;
    font-weight: 600;
    z-index: 10002;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    animation: slideIn 0.3s ease-out;
  `;
  notification.textContent = message;
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.style.animation = 'slideOut 0.3s ease-out';
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

function updateOfflineIndicator() {
  const indicator = document.getElementById('offline-indicator');
  
  if (!isOnline) {
    getOfflineQueue().then(queue => {
      if (queue.length > 0) {
        indicator.innerHTML = `📱 Offline Mode - ${queue.length} items pending sync`;
      } else {
        indicator.innerHTML = '📱 Offline Mode';
      }
      indicator.classList.add('show');
    });
  } else {
    getOfflineQueue().then(queue => {
      if (queue.length > 0) {
        indicator.innerHTML = `🔄 Online - ${queue.length} items ready to sync <button onclick="syncNow()" style="margin-left:10px;padding:4px 12px;border:none;background:rgba(255,255,255,0.3);color:white;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">Sync Now</button>`;
        indicator.style.background = '#10b981';
        indicator.classList.add('show');
      } else {
        indicator.classList.remove('show');
      }
    });
  }
}

window.syncNow = async function() {
  const queue = await getOfflineQueue();
  if (queue.length === 0) {
    showNotification('No items to sync', 'info');
    return;
  }
  
  showNotification(`Syncing ${queue.length} items...`, 'info');
  
  let synced = 0;
  for (const item of queue) {
    try {
      await apiRequest('/api/resource/Task', 'POST', item.data);
      synced++;
    } catch (error) {
      console.error('Sync failed for item:', error);
    }
  }
  
  if (synced > 0) {
    await clearOfflineQueue();
    showNotification(`✅ Synced ${synced} items successfully!`, 'success');
    updateOfflineIndicator();
    loadAllTasks();
  }
};
function filterDashboardTasks(type) {
  let filtered = [];

  switch (type) {
    case 'total tasks':
      filtered = allTasks;
      break;
    case 'in progress':
      filtered = allTasks.filter(t => t.status === 'Working');
      break;
    case 'completed':
      filtered = allTasks.filter(t => t.status === 'Completed');
      break;
    case 'overdue':
      const today = new Date().toISOString().split('T')[0];
      filtered = allTasks.filter(t =>
        t.exp_end_date && t.exp_end_date < today && t.status !== 'Completed'
      );
      break;
  }

  renderTasks(filtered, 'dashboard-tasks');
}


function updateDashboard() {
    document.querySelectorAll('.stat-card').forEach(card => {
  card.addEventListener('click', () => {
    const type = card.querySelector('h3').textContent.trim().toLowerCase();
    filterDashboardTasks(type);
  });
});

  const total = allTasks.length;
  const inProgress = allTasks.filter(t => t.status === 'Working').length;
  const completed = allTasks.filter(t => t.status === 'Completed').length;
  const today = new Date().toISOString().split('T')[0];
  const overdue = allTasks.filter(t => 
    t.exp_end_date && t.exp_end_date < today && t.status !== 'Completed'
  ).length;
  
  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-progress').textContent = inProgress;
  document.getElementById('stat-completed').textContent = completed;
  document.getElementById('stat-overdue').textContent = overdue;
  
  // Reports
  const rate = total > 0 ? Math.round((completed / total) * 100) : 0;
  document.getElementById('report-rate').textContent = rate + '%';
  document.getElementById('report-week').textContent = allTasks.filter(t => {
    if (!t.modified) return false;
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    return new Date(t.modified) > weekAgo && t.status === 'Completed';
  }).length;
  
  const assignees = new Set();
  allTasks.forEach(t => {
    if (t._assign) {
      try {
        const parsed = JSON.parse(t._assign);
        parsed.forEach(a => assignees.add(a));
      } catch (e) {}
    }
  });
  document.getElementById('report-users').textContent = assignees.size;
  
  document.getElementById('report-avg').textContent = '3.5d';
}

function renderTasks(tasks, containerId) {
  const container = document.getElementById(containerId);
  
  if (tasks.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📭</div>
        <h3>No tasks found</h3>
        <p>Create your first task to get started!</p>
      </div>
    `;
    return;
  }
  
  container.innerHTML = tasks.map(task => {
    const isCompleted = task.status === 'Completed';
    const priorityClass = `priority-${task.priority?.toLowerCase() || 'medium'}`;
    const statusClass = `status-${task.status?.toLowerCase().replace(' ', '-') || 'open'}`;
    
    let assignee = 'Unassigned';
    if (task.custom_assigned_to) {
      try {
        // const parsed = JSON.parse(task._assign);
        assignee = task.custom_assigned_to || 'Unassigned';
      } catch (e) {}
    }
    
    return `
      <div class="task-item" data-id="${task.name}">
        <input type="checkbox" class="task-checkbox" ${isCompleted ? 'checked' : ''} 
               onchange="toggleTaskStatus('${task.name}', this.checked)">
        <div class="task-content">
          <div class="task-title">${task.subject || 'Untitled Task'}</div>
          <div class="task-meta">
            <span class="task-badge ${priorityClass}">${task.priority || 'Medium'}</span>
            <span class="status-badge ${statusClass}">${task.status || 'Open'}</span>
            ${task.exp_end_date ? `<span>📅 ${formatDate(task.exp_end_date)}</span>` : ''}
            <span>👤 ${assignee}</span>
            ${task.project ? `<span class="project-badge">📁 ${getProjectName(task.project)}</span>` : ''}
          </div>
        </div>
        <div class="task-actions">
          <button class="icon-btn" onclick="editTask('${task.name}')" title="Edit">✏️</button>
        </div>
      </div>
    `;
  }).join('');
}

window.toggleTaskStatus = async function(taskId, isCompleted) {
  try {
    const newStatus = isCompleted ? 'Completed' : 'Open';
    await apiRequest(`/api/resource/Task/${taskId}`, 'PUT', { status: newStatus });
    showNotification(`Task marked as ${newStatus}`, 'success');
    loadAllTasks();
  } catch (error) {
    console.error('Failed to update task:', error);
    showNotification('Failed to update task', 'error');
  }
};

window.editTask = function(taskId) {
  const task = allTasks.find(t => t.name === taskId);
  if (!task) return;
  
  document.getElementById('modal-title').textContent = 'Edit Task';
  document.getElementById('task-subject').value = task.subject || '';
  document.getElementById('task-description').value = task.description || '';
  document.getElementById('task-priority').value = task.priority || 'Medium';
  document.getElementById('task-status').value = task.status || 'Open';
  document.getElementById('task-start-date').value = task.exp_start_date || '';
  document.getElementById('task-end-date').value = task.exp_end_date || '';
  document.getElementById('task-project').value = task.project || '';
  
  if (task.custom_assigned_to) {
      console.log("edit",task.custom_assigned_to)
    try {
        document.getElementById('task-assigned-to').value = task.custom_assigned_to || '';
      
    //   const parsed = JSON.parse(task.custom_assigned_to);
    //   document.getElementById('task-assigned-to').value = parsed[0] || '';
    } catch (e) {}
  }
  document.getElementById('task-form').setAttribute('data-edit-id', taskId);
  openModal('task-modal');
};

function formatDate(dateStr) {
  const date = new Date(dateStr);
  const today = new Date();
  const diff = Math.floor((date - today) / (1000 * 60 * 60 * 24));
  
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff < 0) return `${Math.abs(diff)}d overdue`;
  if (diff <= 7) return `${diff}d left`;
  
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getProjectName(projectId) {
  const project = allProjects.find(p => p.name === projectId);
  return project ? (project.project_name || project.name) : projectId;
}

async function renderCurrentView() {
  switch(currentView) {
    case 'dashboard':
      renderTasks(allTasks.slice(0), 'dashboard-tasks');
      break;
    case 'my-tasks':
        await loadProjectsForFilter();
       const myTasks = allTasks.filter(t => {
        if (!t.custom_assigned_to) return false;
        try {
          const assignees = t.custom_assigned_to;
          return assignees.includes(currentUser);
        } catch (e) {
          return false;
        }
      });
      renderTasks(applyMyTasksFilters(myTasks), 'my-tasks-list');
      break;
    case 'all-tasks':
        
       
      renderTasks(applyAllTasksFilters(allTasks), 'all-tasks-list');
      setTimeout(() => loadProjectsForFilter(), 100);
      break;
    case 'team':
      renderTeamView();
      break;
    case 'reports':
      break;
  }
}

function applyMyTasksFilters(tasks) {
  const status = document.getElementById('filter-my-status')?.value;
  const priority = document.getElementById('filter-my-priority')?.value;
  const project = document.getElementById('filter-my-project')?.value;

  return tasks.filter(t => {
    if (status && t.status !== status) return false;
    if (priority && t.priority !== priority) return false;
    if (project && t.project !== project) return false;
    return true;
  });
}


function applyAllTasksFilters(tasks) {
  const search = document.getElementById('filter-search')?.value.toLowerCase();
  const status = document.getElementById('filter-status')?.value;
  const priority = document.getElementById('filter-priority')?.value;
  const project = document.getElementById('filter-my-project')?.value;
  
  return tasks.filter(t => {
    if (search && !t.subject?.toLowerCase().includes(search)) return false;
    if (status && t.status !== status) return false;
    if (priority && t.priority !== priority) return false;
    if (project && t.project !== project) return false;
    return true;
  });
}

function renderTeamView() {
  const teamContainer = document.getElementById('team-tasks');
  const grouped = {};
  
  allTasks.forEach(task => {
    if (!task._assign) {
      if (!grouped['Unassigned']) grouped['Unassigned'] = [];
      grouped['Unassigned'].push(task);
    } else {
      try {
        const assignees = JSON.parse(task._assign);
        assignees.forEach(assignee => {
          if (!grouped[assignee]) grouped[assignee] = [];
          grouped[assignee].push(task);
        });
      } catch (e) {}
    }
  });
  
  const html = Object.entries(grouped).map(([user, tasks]) => `
    <div style="padding: 20px; border-bottom: 1px solid var(--border);">
      <h3 style="margin-bottom: 12px; color: var(--primary); font-size: 16px;">
        👤 ${user} (${tasks.length} tasks)
      </h3>
      ${tasks.map(t => `
        <div style="padding: 8px 0; font-size: 14px;">
          <span class="task-badge priority-${t.priority?.toLowerCase() || 'medium'}" style="margin-right: 8px;">
            ${t.priority || 'Medium'}
          </span>
          <span class="status-badge status-${t.status?.toLowerCase() || 'open'}" style="margin-right: 8px;">
            ${t.status || 'Open'}
          </span>
          ${t.subject}
        </div>
        ${user === 'Unassigned' ? `
      <button class="assign-btn" data-task='${t.name}' 
        style="background: var(--primary); color: white; border: none; border-radius: 4px; padding: 4px 8px; cursor: pointer;">
        Assign
      </button>
    ` : ''}
      `).join('')}
    </div>
  `).join('');
  
  teamContainer.innerHTML = html || '<div class="empty-state"><div class="empty-state-icon">👥</div><h3>No team tasks</h3></div>';
   document.querySelectorAll('.assign-btn').forEach(btn => {
    btn.addEventListener('click', e => openAssignDialog(e.target.dataset.task));
  });
}

function openModal(modalId) {
  document.getElementById(modalId).classList.add('show');
}

function closeModal(modalId) {
  document.getElementById(modalId).classList.remove('show');
  
  
  
  if (modalId === 'task-modal') {
    document.getElementById('task-form').reset();
    showMessage('task-msg', '', '');
    document.getElementById('modal-title').textContent = 'Create New Task';
    document.getElementById('task-form').removeAttribute('data-edit-id');
  } else if (modalId === 'project-modal') {
      populateProjectDropdown();
    document.getElementById('project-form').reset();
    showMessage('project-msg', '', '');
  }
}

async function showApp() {
  document.getElementById('bb-login-overlay').classList.add('hidden');
  document.getElementById('bb-app').classList.add('show');
  await loadAllProjects();
  await loadAllUsers();
  loadAllTasks();
  updateOfflineIndicator();
}

function showLogin() {
  document.getElementById('bb-login-overlay').classList.remove('hidden');
  document.getElementById('bb-app').classList.remove('show');
}

// Event Listeners
document.getElementById('bb-login').addEventListener('click', async () => {
  const server = document.getElementById('bb-server').value.trim();
  const usr = document.getElementById('bb-username').value.trim();
  const pwd = document.getElementById('bb-password').value.trim();
  
  if (!server || !usr || !pwd) {
    showMessage('bb-msg', 'Please fill all fields', 'bb-err');
    return;
  }
  
  try {
    showMessage('bb-msg', 'Logging in...', '');
    
    const url = server.replace(/\/+$/, '') + '/api/method/login';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ usr, pwd }),
      credentials: 'include'
    });
    
    if (!res.ok) throw new Error('Login failed');
    
    credentials = { server, usr, pwd };
    currentUser = usr;
    sessionStorage.setItem('credentials', JSON.stringify(credentials));
    await loadAllProjects(); 
    showMessage('bb-msg', '✅ Login successful!', 'bb-ok');
    setTimeout(showApp, 500);
    
  } catch (error) {
    showMessage('bb-msg', '❌ ' + error.message, 'bb-err');
  }
});

document.getElementById('bb-logout').addEventListener('click', () => {
  sessionStorage.removeItem('credentials');
  credentials = null;
  showLogin();
});

document.getElementById('quick-add').addEventListener('click', () => {
  openModal('task-modal');
});

document.getElementById('close-modal').addEventListener('click', () => {
  closeModal('task-modal');
});

document.getElementById('cancel-task').addEventListener('click', () => {
  closeModal('task-modal');
});

document.getElementById('task-modal').addEventListener('click', (e) => {
  if (e.target.id === 'task-modal') closeModal('task-modal');
});

document.getElementById('task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const taskData = {
    subject: document.getElementById('task-subject').value.trim(),
    description: document.getElementById('task-description').value.trim(),
    priority: document.getElementById('task-priority').value,
    status: document.getElementById('task-status').value,
    startDate: document.getElementById('task-start-date').value,
    endDate: document.getElementById('task-end-date').value,
    assignedTo: document.getElementById('task-assigned-to').value.trim(),
    project: document.getElementById('task-project').value
  };
  
  if (!taskData.subject) {
    showMessage('task-msg', 'Task subject is required', 'bb-err');
    return;
  }
  
  const form = document.getElementById('task-form');
const editId = form.getAttribute('data-edit-id');

if (editId) {
  await updateTask(editId, taskData);      
  form.removeAttribute('data-edit-id');    
} else {
  await createTask(taskData);              
}
});

// Project Modal Events
document.getElementById('create-project-btn').addEventListener('click', () => {
  openModal('project-modal');
});

document.getElementById('close-project-modal').addEventListener('click', () => {
  closeModal('project-modal');
});

document.getElementById('cancel-project').addEventListener('click', () => {
  closeModal('project-modal');
});

document.getElementById('project-modal').addEventListener('click', (e) => {
  if (e.target.id === 'project-modal') closeModal('project-modal');
});

document.getElementById('project-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const projectData = {
    name: document.getElementById('project-name').value.trim(),
    status: document.getElementById('project-status').value,
    startDate: document.getElementById('project-start-date').value,
    endDate: document.getElementById('project-end-date').value
  };
  
  if (!projectData.name) {
    showMessage('project-msg', 'Project name is required', 'bb-err');
    return;
  }
  
  await createProject(projectData);
});

document.getElementById('sync-btn').addEventListener('click', syncNow);

// Tab Navigation
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    
    document.querySelectorAll('.view-section').forEach(v => v.classList.remove('active'));
    
    currentView = tab.dataset.view;
    document.getElementById(currentView + '-view').classList.add('active');
    renderCurrentView();
  });
});

// Filters
document.getElementById('filter-my-status')?.addEventListener('change', renderCurrentView);
document.getElementById('filter-my-priority')?.addEventListener('change', renderCurrentView);
document.getElementById('filter-status')?.addEventListener('change', renderCurrentView);
document.getElementById('filter-priority')?.addEventListener('change', renderCurrentView);
document.getElementById('filter-search')?.addEventListener('input', renderCurrentView);

// Network Events
window.addEventListener('online', () => {
  isOnline = true;
  updateOfflineIndicator();
  showNotification('🌐 Back online!', 'success');
  setTimeout(syncNow, 2000);
});

window.addEventListener('offline', () => {
  isOnline = false;
  updateOfflineIndicator();
  showNotification('📱 Offline mode - changes will sync later', 'warning');
});

// Initialize
(async () => {
  await initDB();
  
  const stored = sessionStorage.getItem('credentials');
  if (stored) {
    credentials = JSON.parse(stored);
    currentUser = credentials.usr;
    await loadAllProjects();
    showApp();
  }
  
  const today = new Date().toISOString().split('T')[0];
  const nextWeek = new Date();
  nextWeek.setDate(nextWeek.getDate() + 7);
  
  document.getElementById('task-start-date').value = today;
  document.getElementById('task-end-date').value = nextWeek.toISOString().split('T')[0];
  
  // Project form defaults
  document.getElementById('project-start-date').value = today;
  document.getElementById('project-end-date').value = nextWeek.toISOString().split('T')[0];
})();
async function updateTask(taskId, taskData) {
  try {
    showMessage('task-msg', 'Updating task...', '');
    
    const payload = {
      subject: taskData.subject,
      description: taskData.description || '',
      priority: taskData.priority,
      status: taskData.status,
      exp_start_date: taskData.startDate || '',
      exp_end_date: taskData.endDate || ''
    };

    // Add custom field for assigned user
    if (taskData.assignedTo) {
      payload.custom_assigned_to = taskData.assignedTo;
      payload._assign = JSON.stringify([taskData.assignedTo]);
    }
    
    // Add project only if selected
    if (taskData.project) {
      payload.project = taskData.project;
    }

    console.log('Update Payload:', payload);
    
    await apiRequest(`/api/resource/Task/${taskId}`, 'PUT', payload);

    showMessage('task-msg', '✅ Task updated successfully!', 'bb-ok');
    setTimeout(() => {
      closeModal('task-modal');
      loadAllTasks();
    }, 1500);
  } catch (error) {
    console.error('Task update error:', error);
    showMessage('task-msg', '❌ Error: ' + error.message, 'bb-err');
  }
}
function populateUserDropdown() {
  const dropdown = document.getElementById('task-assigned-to');
  if (!dropdown) return; // Safety check
  dropdown.innerHTML = '<option value="">Unassigned</option>';

  allUsers.forEach(user => {
    const option = document.createElement('option');
    option.value = user.name;
    option.textContent = user.full_name || user.name;
    dropdown.appendChild(option);
  });
}

(function addManifest(){
  const link = document.createElement('link');
  link.rel = 'manifest';
  link.href = '/files/taskmanifast.json';
  document.head.appendChild(link);
})();

// Register service worker from /files (scope will be /files/)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/files/tasksw.js')
    .then(registration => {
      console.log('Service Worker registered successfully');
      
      // Register for background sync
      if ('sync' in window.ServiceWorkerRegistration.prototype) {
        console.log('Background sync supported');
      }
    })
    .catch(error => {
      console.log('Service worker registration failed:', error);
    });
}

// Listen for service worker messages
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data && event.data.type === 'GET_CREDENTIALS') {
      // Send credentials to service worker
      event.source.postMessage({
        type: 'CREDENTIALS_RESPONSE',
        credentials: credentials
      });
    }
    
    if (event.data && event.data.type === 'SYNC_SUCCESS') {
      // Show sync success notification
      showSyncNotification(event.data.item, event.data.name);
    }
  });
}
// Show update notification
function showUpdateNotification() {
  const notification = document.createElement('div');
  notification.style.cssText = `
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: #6351a2;
    color: white;
    padding: 16px 24px;
    border-radius: 12px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    z-index: 10003;
    display: flex;
    align-items: center;
    gap: 16px;
    font-weight: 600;
  `;
  
  notification.innerHTML = `
    <span>🎉 New version available!</span>
    <button onclick="updateApp()" style="
      background: white;
      color: #6351a2;
      border: none;
      padding: 8px 16px;
      border-radius: 6px;
      font-weight: 700;
      cursor: pointer;
    ">Update Now</button>
  `;
  
  document.body.appendChild(notification);
}

// Update app function
window.updateApp = function() {
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'SKIP_WAITING' });
  }
  window.location.reload();
};

// Handle install prompt (PWA Install Button)
let deferredPrompt;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  showInstallButton();
});

function showInstallButton() {
  const installBtn = document.createElement('button');
  installBtn.textContent = '📱 Install App';
  installBtn.className = 'btn-small btn-primary install-app-btn';
  installBtn.style.cssText = 'margin-left: 8px;';
  
  installBtn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    
    console.log('Install prompt outcome:', outcome);
    
    if (outcome === 'accepted') {
      showNotification('✅ App installed successfully!', 'success');
    }
    
    deferredPrompt = null;
    installBtn.remove();
  });
  
  const headerActions = document.querySelector('.header-actions');
  if (headerActions && !document.querySelector('.install-app-btn')) {
    headerActions.insertBefore(installBtn, headerActions.firstChild);
  }
}

// Handle app installed
window.addEventListener('appinstalled', () => {
  console.log('✅ PWA installed successfully');
  showNotification('🎉 App installed! You can now use it offline.', 'success');
  deferredPrompt = null;
  
  const installBtn = document.querySelector('.install-app-btn');
  if (installBtn) installBtn.remove();
});

// Enhanced syncNow with service worker support
const originalSyncNow = window.syncNow;
window.syncNow = async function() {
  const queue = await getOfflineQueue();
  if (queue.length === 0) {
    showNotification('No items to sync', 'info');
    return;
  }
  
  showNotification(`Syncing ${queue.length} items...`, 'info');
  
  // Try to use service worker background sync first
  if ('serviceWorker' in navigator && 'sync' in navigator.serviceWorker) {
    try {
      const registration = await navigator.serviceWorker.ready;
      await registration.sync.register('sync-tasks');
      console.log('Background sync registered');
      
      // Trigger immediate sync via message
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'SYNC_NOW' });
      }
      
      // Wait a bit then check and reload
      setTimeout(async () => {
        const remainingQueue = await getOfflineQueue();
        if (remainingQueue.length < queue.length) {
          showNotification(`✅ Synced ${queue.length - remainingQueue.length} items!`, 'success');
        }
        loadAllTasks();
        updateOfflineIndicator();
      }, 2000);
      
      return;
    } catch (error) {
      console.log('Background sync not available, using fallback:', error);
    }
  }
  
  // Fallback to original sync method
  let synced = 0;
  for (const item of queue) {
    try {
      await apiRequest('/api/resource/Task', 'POST', item.data);
      synced++;
    } catch (error) {
      console.error('Sync failed for item:', error);
    }
  }
  
  if (synced > 0) {
    await clearOfflineQueue();
    showNotification(`✅ Synced ${synced} items successfully!`, 'success');
    updateOfflineIndicator();
    loadAllTasks();
  }
};

// Enhanced online event to trigger background sync
const originalOnlineHandler = window.addEventListener('online', () => {
  isOnline = true;
  updateOfflineIndicator();
  showNotification('🌐 Back online!', 'success');
  
  // Try background sync first
  if ('serviceWorker' in navigator && 'sync' in navigator.serviceWorker) {
    navigator.serviceWorker.ready.then(registration => {
      return registration.sync.register('sync-tasks');
    }).then(() => {
      console.log('Background sync registered');
      setTimeout(() => {
        loadAllTasks();
        updateOfflineIndicator();
      }, 2000);
    }).catch(err => {
      console.log('Background sync registration failed:', err);
      // Fallback to manual sync
      setTimeout(syncNow, 2000);
    });
  } else {
    // Fallback if service worker not available
    setTimeout(syncNow, 2000);
  }
});
function openAssignDialog(taskName) {
  const modal = document.createElement('div');
  modal.className = 'assign-modal';
  modal.style.cssText = `
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    background: white; padding: 20px; border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.2);
    z-index: 1000; width: 300px;
  `;

  modal.innerHTML = `
    <h4 style="margin-bottom: 12px;">Assign Task</h4>
    <select id="assign-user-dropdown" style="width:100%; padding:6px; margin-bottom:12px;">
      <option value="">Select User</option>
      ${allUsers.map(u => `<option value="${u.name}">${u.full_name || u.name}</option>`).join('')}
    </select>
    <div style="text-align:right;">
      <button id="assign-cancel" style="margin-right:8px;">Cancel</button>
      <button id="assign-save" style="background:var(--primary); color:white; border:none; padding:6px 10px; border-radius:4px;">Assign</button>
    </div>
  `;

  document.body.appendChild(modal);

  document.getElementById('assign-cancel').onclick = () => modal.remove();
  document.getElementById('assign-save').onclick = async () => {
    const user = document.getElementById('assign-user-dropdown').value;
    
    if (!user) {
      alert('Please select a user');
      return;
    }

    await assignTaskToUser(taskName, user);
    modal.remove();
  };
}

async function assignTaskToUser(taskName, user) {
  try {
    // Build only the payload you need
    const payload = {
      custom_assigned_to: user
    };

    // ✅ Correct syntax for your apiRequest() function
    await apiRequest(`/api/resource/Task/${taskName}`, 'PUT', payload);

    frappe.show_alert({ message: `✅ Task ${taskName} assigned to ${user}`, indicator: 'green' });

    // Optional: refresh list
    await loadAllTasks();
    renderTeamView();

  } catch (error) {
    console.error('Failed to assign task:', error);
    frappe.show_alert({ message: '❌ Failed to assign task: ' + error.message, indicator: 'red' });
  }
}

async function loadProjectsForFilter() {
  try {
    // Wait until the dropdown exists in the DOM
    let dropdownCheck = 0;
    while (
      !document.getElementById('filter-project') &&
      
      dropdownCheck < 10
    ) {
      await new Promise(r => setTimeout(r, 100));
      dropdownCheck++;
    }

    // Now both dropdowns should exist
    const dropdowns = [
      document.getElementById('filter-project'),
      
    ].filter(Boolean);

    if (dropdowns.length === 0) {
      return;
    }

    // Fetch all projects
    const response = await apiRequest(
      '/api/resource/Project?fields=["name","project_name"]&limit_page_length=200'
    );

    const projects = response.data || [];
console.log("Dropdown innerHTML before:", dropdowns.map(d => d.innerHTML));
    // Populate each dropdown
    dropdowns.forEach(dropdown => {
      dropdown.innerHTML = '<option value="">All Projects</option>';
      projects.forEach(project => {
        const option = document.createElement('option');
        option.value = project.name;
        option.textContent = project.project_name || project.name;
        dropdown.appendChild(option);
      });
    });

  } catch (error) {
    console.error('❌ Failed to load projects:', error);
  }
}



