'use strict';

const Admin = (() => {
  // ── State ──────────────────────────────────────────────────────────────────
  let token = '';
  let currentPage = 'dashboard';
  let pendingDrivers = [];
  let allDrivers = [];
  let drawerDriver = null;
  let healthPollTimer = null;

  const BASE = (() => {
    const stored = localStorage.getItem('adminBaseURL');
    return stored || `${location.protocol}//${location.host}`;
  })();

  // ── Bootstrap ──────────────────────────────────────────────────────────────

  function init() {
    token = sessionStorage.getItem('adminToken') || '';
    if (token) {
      showShell();
    } else {
      showLogin();
    }
  }

  function showLogin() {
    document.getElementById('loginScreen').classList.add('show');
    document.getElementById('adminShell').style.display = 'none';
    if (healthPollTimer) clearInterval(healthPollTimer);
  }

  function showShell() {
    document.getElementById('loginScreen').classList.remove('show');
    document.getElementById('adminShell').style.display = 'flex';

    // Restore sidebar state
    const collapsed = localStorage.getItem('sidebarCollapsed') === 'true';
    if (collapsed) {
      document.getElementById('sidebar').classList.add('collapsed');
      document.getElementById('mainArea').classList.add('expanded');
    }

    navigate(currentPage);
    startHealthPoll();
  }

  // ── Auth ───────────────────────────────────────────────────────────────────

  async function submitLogin() {
    const username = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const btn = document.getElementById('loginBtn');
    const errEl = document.getElementById('loginError');
    errEl.style.display = 'none';

    if (!username || !password) {
      errEl.textContent = 'Username and password are required.';
      errEl.style.display = 'block';
      return;
    }

    btn.classList.add('loading');
    try {
      const res = await apiFetch('/api/auth/login', 'POST', { username, password }, false);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message || `Login failed (${res.status})`);
      }
      const data = await res.json();
      token = data.token;
      sessionStorage.setItem('adminToken', token);

      // Show admin name
      const name = username;
      document.getElementById('userName').textContent = name;
      document.getElementById('userAvatar').textContent = name[0].toUpperCase();

      showShell();
    } catch (e) {
      errEl.textContent = e.message;
      errEl.style.display = 'block';
    } finally {
      btn.classList.remove('loading');
    }
  }

  function logout() {
    token = '';
    sessionStorage.removeItem('adminToken');
    showLogin();
    toast('Signed out', 'info');
  }

  // ── Navigation ─────────────────────────────────────────────────────────────

  const PAGE_TITLES = {
    dashboard: 'Dashboard',
    pending: 'Pending Review',
    'all-drivers': 'All Drivers',
    payments: 'UPI Payments',
    users: 'Users',
    system: 'System',
  };

  function navigate(page) {
    currentPage = page;

    // Update active nav item
    document.querySelectorAll('.nav-item').forEach(el => {
      el.classList.toggle('active', el.dataset.page === page);
    });

    // Show correct page view
    document.querySelectorAll('.page-view').forEach(el => {
      el.classList.toggle('active', el.id === `page-${page}`);
    });

    document.getElementById('headerTitle').textContent = PAGE_TITLES[page] || page;

    // Load data for the page
    switch (page) {
      case 'dashboard':   loadDashboard(); break;
      case 'pending':     loadPending(); break;
      case 'all-drivers': loadAllDrivers(); break;
      case 'payments':    loadPayments(); break;
      case 'users':       loadUsers(); break;
      case 'system':      loadHealth(); loadMetrics(); break;
    }

    // Close mobile sidebar
    document.getElementById('sidebar').classList.remove('mobile-open');
    document.getElementById('sidebarOverlay').classList.remove('show');
  }

  function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const mainArea = document.getElementById('mainArea');
    const overlay = document.getElementById('sidebarOverlay');

    const isMobile = window.innerWidth <= 768;
    if (isMobile) {
      sidebar.classList.toggle('mobile-open');
      overlay.classList.toggle('show');
    } else {
      sidebar.classList.toggle('collapsed');
      mainArea.classList.toggle('expanded');
      localStorage.setItem('sidebarCollapsed', sidebar.classList.contains('collapsed'));
    }
  }

  // ── Health Poll ────────────────────────────────────────────────────────────

  function startHealthPoll() {
    checkHealth();
    healthPollTimer = setInterval(checkHealth, 30_000);
  }

  async function checkHealth() {
    try {
      const res = await apiFetch('/api/system/health', 'GET', null, false);
      const online = res.ok;
      const badge = document.getElementById('statusBadge');
      const label = document.getElementById('statusLabel');
      badge.className = `status-badge ${online ? 'online' : 'offline'}`;
      label.textContent = online ? 'Online' : 'Offline';
    } catch {
      document.getElementById('statusBadge').className = 'status-badge offline';
      document.getElementById('statusLabel').textContent = 'Offline';
    }
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────

  async function loadDashboard() {
    await Promise.allSettled([
      loadDashStats(),
      loadRecentActivity(),
      loadHealthCard(),
    ]);
  }

  async function loadDashStats() {
    try {
      const [mpRes, fleetRes] = await Promise.all([
        apiFetch('/api/marketplace/list?limit=1', 'GET'),
        apiFetch('/api/fleet/overview', 'GET'),
      ]);

      if (mpRes.ok) {
        const mp = await mpRes.json();
        setText('statTotalDrivers', mp.total ?? mp.drivers?.length ?? '—');
        const pending = (mp.drivers || []).filter(d => d.status === 'pending').length;
        setText('statPending', pending);
        updateBadge('pendingBadge', pending);
      }

      if (fleetRes.ok) {
        const fleet = await fleetRes.json();
        setText('statDeploys', fleet.total_deployed ?? fleet.total_projects ?? '—');
      }

      // Users count — try devices as proxy
      setText('statUsers', '—');
    } catch (e) {
      console.warn('Dashboard stats:', e);
    }
  }

  async function loadRecentActivity() {
    const feed = document.getElementById('activityFeed');
    try {
      const res = await apiFetch('/api/fleet/overview', 'GET');
      if (!res.ok) throw new Error('fleet failed');
      const data = await res.json();
      const history = (data.recent_deploys || []).slice(0, 8);

      if (!history.length) {
        feed.innerHTML = `<li class="activity-item"><div class="activity-dot submit"></div><div class="activity-text"><div class="activity-name text-muted">No recent activity</div></div></li>`;
        return;
      }

      feed.innerHTML = history.map(d => `
        <li class="activity-item">
          <div class="activity-dot approve"></div>
          <div class="activity-text">
            <div class="activity-name">${esc(d.project_name || d.project_id || 'Deploy')}</div>
            <div class="activity-meta">${esc(d.device_name || d.device_id || '')}</div>
          </div>
          <div class="activity-time">${relativeTime(d.deployed_at || d.created_at)}</div>
        </li>
      `).join('');
    } catch {
      feed.innerHTML = `<li class="activity-item"><div class="activity-dot submit"></div><div class="activity-text"><div class="activity-name text-muted">Could not load activity</div></div></li>`;
    }
  }

  async function loadHealthCard() {
    const el = document.getElementById('healthCardContent');
    try {
      const res = await apiFetch('/api/system/health', 'GET', null, false);
      if (!res.ok) throw new Error('offline');
      const data = await res.json();

      el.innerHTML = Object.entries({
        Status: ['OK', 'ok'],
        Database: [data.database ?? 'ok', data.database === 'ok' ? 'ok' : 'err'],
        Drivers: [data.drivers ?? '—', 'ok'],
        Version: [data.version ?? '1.0.0', ''],
      }).map(([k, [v, cls]]) => `
        <div class="health-row">
          <span class="health-key">${esc(k)}</span>
          <span class="health-val ${cls}">${esc(String(v))}</span>
        </div>
      `).join('');
    } catch {
      el.innerHTML = `<div class="health-row"><span class="health-key">Status</span><span class="health-val err">Offline</span></div>`;
    }
  }

  // ── Pending Drivers ────────────────────────────────────────────────────────

  async function loadPending() {
    const tbody = document.getElementById('pendingTableBody');
    tbody.innerHTML = skeletonRows(3, 6);
    try {
      const res = await apiFetch('/api/marketplace/list?status=pending&limit=100', 'GET');
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      pendingDrivers = (data.drivers || data || []).filter(d => d.status === 'pending' || !d.status);

      updateBadge('pendingBadge', pendingDrivers.length);
      setText('statPending', pendingDrivers.length);

      renderPendingTable(pendingDrivers);
    } catch (e) {
      tbody.innerHTML = emptyRow(6, `Could not load pending drivers: ${e.message}`);
    }
  }

  function renderPendingTable(drivers) {
    const tbody = document.getElementById('pendingTableBody');
    if (!drivers.length) {
      tbody.innerHTML = emptyRow(6, 'No pending drivers — all caught up! ✅');
      return;
    }
    tbody.innerHTML = drivers.map(d => `
      <tr onclick="Admin.openDriver('${esc(d.driver_id || d.id)}', 'pending')">
        <td class="td-name">${esc(d.name)}</td>
        <td>${esc(d.sensor_type || d.driver_type || '—')}</td>
        <td>${(d.bus_types || d.bus_type || [d.bus_type]).filter(Boolean).map(b => `<span class="tag tag-bus">${esc(b)}</span>`).join(' ')}</td>
        <td class="td-mono">${esc(d.submitted_by || d.author || '—')}</td>
        <td class="td-mono">${formatDate(d.submitted_at || d.created_at)}</td>
        <td onclick="event.stopPropagation()">
          <div class="row-actions">
            <button class="btn-approve" onclick="Admin.approveDriver('${esc(d.driver_id || d.id)}')">✓ Approve</button>
            <button class="btn-reject"  onclick="Admin.openRejectDialog('${esc(d.driver_id || d.id)}')">✕ Reject</button>
            <button class="btn-view"    onclick="Admin.openDriver('${esc(d.driver_id || d.id)}', 'pending')">Detail</button>
          </div>
        </td>
      </tr>
    `).join('');
  }

  function filterPending() {
    const q = document.getElementById('pendingSearch').value.toLowerCase();
    const filtered = q
      ? pendingDrivers.filter(d =>
          (d.name || '').toLowerCase().includes(q) ||
          (d.sensor_type || d.driver_type || '').toLowerCase().includes(q) ||
          (d.submitted_by || '').toLowerCase().includes(q)
        )
      : pendingDrivers;
    renderPendingTable(filtered);
  }

  // ── All Drivers ────────────────────────────────────────────────────────────

  async function loadAllDrivers() {
    const tbody = document.getElementById('allDriversBody');
    tbody.innerHTML = skeletonRows(3, 6);
    try {
      const res = await apiFetch('/api/marketplace/list?limit=200', 'GET');
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      allDrivers = data.drivers || data || [];
      setText('statTotalDrivers', allDrivers.length);
      renderAllDriversTable(allDrivers);
    } catch (e) {
      tbody.innerHTML = emptyRow(6, `Could not load drivers: ${e.message}`);
    }
  }

  function renderAllDriversTable(drivers) {
    const tbody = document.getElementById('allDriversBody');
    if (!drivers.length) {
      tbody.innerHTML = emptyRow(6, 'No drivers found.');
      return;
    }
    tbody.innerHTML = drivers.map(d => `
      <tr onclick="Admin.openDriver('${esc(d.driver_id || d.id)}', 'all')">
        <td class="td-name">${esc(d.name)}</td>
        <td>${esc(d.sensor_type || d.driver_type || '—')}</td>
        <td class="td-mono">${(d.download_count ?? d.install_count ?? 0).toLocaleString()}</td>
        <td class="td-mono">${d.avg_rating ? Number(d.avg_rating).toFixed(1) + ' ★' : '—'}</td>
        <td>${statusBadge(d.status || 'approved')}</td>
        <td onclick="event.stopPropagation()">
          <div class="row-actions">
            ${d.status === 'approved'
              ? `<button class="btn-revoke" onclick="Admin.revokeDriver('${esc(d.driver_id || d.id)}')">Revoke</button>`
              : `<button class="btn-approve" onclick="Admin.approveDriver('${esc(d.driver_id || d.id)}')">Approve</button>`
            }
            <button class="btn-view" onclick="Admin.openDriver('${esc(d.driver_id || d.id)}', 'all')">Detail</button>
          </div>
        </td>
      </tr>
    `).join('');
  }

  function filterAllDrivers() {
    const q = document.getElementById('allDriversSearch').value.toLowerCase();
    const filtered = q
      ? allDrivers.filter(d =>
          (d.name || '').toLowerCase().includes(q) ||
          (d.sensor_type || d.driver_type || '').toLowerCase().includes(q)
        )
      : allDrivers;
    renderAllDriversTable(filtered);
  }

  // ── Driver Detail Drawer ───────────────────────────────────────────────────

  async function openDriver(driverId, context) {
    drawerDriver = { id: driverId, context };
    document.getElementById('drawerTitle').textContent = 'Loading…';
    document.getElementById('drawerSubtitle').textContent = '';
    document.getElementById('drawerBody').innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-3)">Loading driver details…</div>';
    document.getElementById('drawerFooter').innerHTML = '';
    openDrawer();

    try {
      const res = await apiFetch(`/api/marketplace/driver/${driverId}`, 'GET');
      if (!res.ok) throw new Error(`${res.status}`);
      const d = await res.json();
      drawerDriver.data = d;

      document.getElementById('drawerTitle').textContent = d.name;
      document.getElementById('drawerSubtitle').textContent = `${d.sensor_type || d.driver_type || ''} · ${d.status || 'unknown'}`;

      const busTags = (d.bus_types || [d.bus_type].filter(Boolean)).map(b => `<span class="tag tag-bus">${esc(b)}</span>`).join(' ');
      const capTags = (d.capabilities || []).map(c => `<span class="tag tag-cap">${esc(c)}</span>`).join(' ');

      document.getElementById('drawerBody').innerHTML = `
        <div class="drawer-section">
          <div class="drawer-section-title">Overview</div>
          <div class="meta-grid">
            <div class="meta-item"><div class="meta-key">Driver ID</div><div class="meta-val text-mono">${esc(d.driver_id || d.id)}</div></div>
            <div class="meta-item"><div class="meta-key">Status</div><div class="meta-val">${statusBadge(d.status)}</div></div>
            <div class="meta-item"><div class="meta-key">Author</div><div class="meta-val">${esc(d.submitted_by || d.author || '—')}</div></div>
            <div class="meta-item"><div class="meta-key">Submitted</div><div class="meta-val">${formatDate(d.submitted_at || d.created_at)}</div></div>
            <div class="meta-item"><div class="meta-key">Downloads</div><div class="meta-val">${(d.download_count ?? 0).toLocaleString()}</div></div>
            <div class="meta-item"><div class="meta-key">Rating</div><div class="meta-val">${d.avg_rating ? Number(d.avg_rating).toFixed(1) + ' / 5' : '—'}</div></div>
          </div>
        </div>

        ${d.description ? `
        <div class="drawer-section">
          <div class="drawer-section-title">Description</div>
          <p style="font-size:14px;color:var(--text-2);line-height:1.65">${esc(d.description)}</p>
        </div>` : ''}

        <div class="drawer-section">
          <div class="drawer-section-title">Bus Types</div>
          <div class="tag-list">${busTags || '<span class="text-muted" style="font-size:13px">None listed</span>'}</div>
        </div>

        ${capTags ? `
        <div class="drawer-section">
          <div class="drawer-section-title">Capabilities</div>
          <div class="tag-list">${capTags}</div>
        </div>` : ''}

        ${d.source_code ? `
        <div class="drawer-section">
          <div class="drawer-section-title">Source Preview</div>
          <div class="source-viewer">
            <div class="source-toolbar">
              <span class="source-lang">C</span>
              <button class="btn-copy" onclick="Admin.copySource()">Copy</button>
            </div>
            <pre class="source-code" id="sourceCode">${highlightC(d.source_code)}</pre>
          </div>
        </div>` : ''}
      `;

      // Footer actions
      const isPending = d.status === 'pending' || context === 'pending';
      document.getElementById('drawerFooter').innerHTML = isPending ? `
        <div class="reject-reason-wrap">
          <div class="reject-reason-label">Reject Reason (optional)</div>
          <input type="text" class="reject-reason-input" id="drawerRejectReason" placeholder="e.g. Missing I2C address, code has bugs…" />
        </div>
        <div class="drawer-actions">
          <button class="btn btn-danger" onclick="Admin.rejectFromDrawer()">
            <div class="spin"></div><span class="btn-text">✕ Reject</span>
          </button>
          <button class="btn btn-success-full" onclick="Admin.approveFromDrawer()">
            <div class="spin"></div><span class="btn-text">✓ Approve</span>
          </button>
        </div>
      ` : `
        <div class="drawer-actions">
          ${d.status === 'approved' ? `
          <button class="btn btn-danger" onclick="Admin.revokeFromDrawer()">
            <div class="spin"></div><span class="btn-text">Revoke Approval</span>
          </button>` : `
          <button class="btn btn-success-full" onclick="Admin.approveFromDrawer()">
            <div class="spin"></div><span class="btn-text">✓ Approve</span>
          </button>`}
          <button class="btn btn-ghost" onclick="Admin.closeDrawer()">Close</button>
        </div>
      `;
    } catch (e) {
      document.getElementById('drawerBody').innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-title">Failed to load</div><div class="empty-msg">${esc(e.message)}</div></div>`;
    }
  }

  function openDrawer() {
    document.getElementById('drawer').classList.add('open');
    document.getElementById('drawerOverlay').classList.add('show');
    document.body.style.overflow = 'hidden';
  }

  function closeDrawer() {
    document.getElementById('drawer').classList.remove('open');
    document.getElementById('drawerOverlay').classList.remove('show');
    document.body.style.overflow = '';
    drawerDriver = null;
  }

  function copySource() {
    const el = document.getElementById('sourceCode');
    if (el) navigator.clipboard.writeText(el.innerText).then(() => toast('Source copied', 'success'));
  }

  // ── Driver Actions ─────────────────────────────────────────────────────────

  async function approveDriver(driverId) {
    try {
      const res = await apiFetch(`/api/marketplace/approve/${driverId}`, 'POST');
      if (!res.ok) throw new Error(`${res.status}`);
      toast('Driver approved', 'success');
      refreshCurrentPage();
    } catch (e) {
      toast(`Approve failed: ${e.message}`, 'error');
    }
  }

  async function openRejectDialog(driverId) {
    const reason = prompt('Reject reason (optional):') ?? '';
    if (reason === null) return; // cancelled
    await rejectDriver(driverId, reason);
  }

  async function rejectDriver(driverId, reason) {
    try {
      const res = await apiFetch(`/api/marketplace/reject/${driverId}`, 'POST', { reason });
      if (!res.ok) throw new Error(`${res.status}`);
      toast('Driver rejected', 'info');
      refreshCurrentPage();
    } catch (e) {
      toast(`Reject failed: ${e.message}`, 'error');
    }
  }

  async function revokeDriver(driverId) {
    if (!confirm('Revoke approval? This will hide the driver from the marketplace.')) return;
    try {
      const res = await apiFetch(`/api/marketplace/reject/${driverId}`, 'POST', { reason: 'Revoked by admin' });
      if (!res.ok) throw new Error(`${res.status}`);
      toast('Driver revoked', 'warning');
      refreshCurrentPage();
    } catch (e) {
      toast(`Revoke failed: ${e.message}`, 'error');
    }
  }

  async function approveFromDrawer() {
    if (!drawerDriver) return;
    const btn = document.querySelector('#drawerFooter .btn-success-full');
    btn?.classList.add('loading');
    await approveDriver(drawerDriver.id);
    btn?.classList.remove('loading');
    closeDrawer();
  }

  async function rejectFromDrawer() {
    if (!drawerDriver) return;
    const reason = document.getElementById('drawerRejectReason')?.value || '';
    const btn = document.querySelector('#drawerFooter .btn-danger');
    btn?.classList.add('loading');
    await rejectDriver(drawerDriver.id, reason);
    btn?.classList.remove('loading');
    closeDrawer();
  }

  async function revokeFromDrawer() {
    if (!drawerDriver) return;
    if (!confirm('Revoke approval?')) return;
    await revokeDriver(drawerDriver.id);
    closeDrawer();
  }

  function refreshCurrentPage() {
    navigate(currentPage);
  }

  // ── Users Page ─────────────────────────────────────────────────────────────

  async function loadUsers() {
    const pageEl = document.getElementById('page-users');
    pageEl.innerHTML = `
      <div class="page-header">
        <div class="page-title">Users</div>
        <div class="page-sub">Registered platform users.</div>
      </div>
      <div class="card">
        <div class="table-toolbar">
          <input class="search-input" type="text" placeholder="Search users…" id="userSearch" oninput="Admin.filterUsers()" />
          <button class="btn btn-ghost" style="flex-shrink:0" onclick="Admin.loadUsers()">↻ Refresh</button>
        </div>
        <div class="table-wrap">
          <table id="usersTable">
            <thead>
              <tr>
                <th>Username</th>
                <th>Email</th>
                <th>Devices</th>
                <th>Projects</th>
                <th>Joined</th>
                <th>Last Login</th>
              </tr>
            </thead>
            <tbody id="usersTableBody">${skeletonRows(4, 6)}</tbody>
          </table>
        </div>
      </div>
    `;
    try {
      const res = await apiFetch('/api/users', 'GET');
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      _allUsers = data.users || [];
      setText('statUsers', data.total ?? _allUsers.length);
      renderUsersTable(_allUsers);
    } catch (e) {
      document.getElementById('usersTableBody').innerHTML = emptyRow(6, `Could not load users: ${e.message}`);
    }
  }

  let _allUsers = [];

  function renderUsersTable(users) {
    const tbody = document.getElementById('usersTableBody');
    if (!tbody) return;
    if (!users.length) {
      tbody.innerHTML = emptyRow(6, 'No users found.');
      return;
    }
    tbody.innerHTML = users.map(u => `
      <tr>
        <td class="td-name">${esc(u.username)}</td>
        <td class="td-mono">${esc(u.email || '—')}</td>
        <td class="td-mono">${u.device_count ?? 0}</td>
        <td class="td-mono">${u.project_count ?? 0}</td>
        <td class="td-mono">${formatDate(u.created_at)}</td>
        <td class="td-mono">${u.last_login_at ? relativeTime(u.last_login_at) : '—'}</td>
      </tr>
    `).join('');
  }

  function filterUsers() {
    const q = (document.getElementById('userSearch')?.value || '').toLowerCase();
    const filtered = q
      ? _allUsers.filter(u =>
          (u.username || '').toLowerCase().includes(q) ||
          (u.email || '').toLowerCase().includes(q)
        )
      : _allUsers;
    renderUsersTable(filtered);
  }

  // ── System Page ────────────────────────────────────────────────────────────

  async function loadHealth() {
    const el = document.getElementById('sysHealthContent');
    el.innerHTML = `<div class="health-row"><span class="health-key">Checking…</span><span class="health-val"></span></div>`;
    try {
      const res = await apiFetch('/api/system/health', 'GET', null, false);
      const data = await res.json().catch(() => ({}));

      const rows = {
        Status:   [res.ok ? 'OK' : 'ERROR', res.ok ? 'ok' : 'err'],
        Database: [data.database ?? '—', data.database === 'ok' ? 'ok' : 'err'],
        Drivers:  [data.drivers ?? '—', 'ok'],
        Version:  [data.version ?? '1.0.0', ''],
      };

      el.innerHTML = Object.entries(rows).map(([k, [v, cls]]) => `
        <div class="health-row">
          <span class="health-key">${esc(k)}</span>
          <span class="health-val ${cls}">${esc(String(v))}</span>
        </div>
      `).join('');

      // Update info card
      if (data.version) setText('infoVersion', data.version);
      if (data.uptime_secs != null) setText('infoUptime', formatUptime(data.uptime_secs));
      setText('infoEnv', 'production');
      if (data.database) setText('infoDb', data.database === 'ok' ? 'Connected' : 'Error');
    } catch {
      el.innerHTML = `<div class="health-row"><span class="health-key">Status</span><span class="health-val err">Offline</span></div>`;
    }
  }

  async function loadMetrics() {
    const tbody = document.getElementById('metricsBody');
    tbody.innerHTML = skeletonRows(3, 3);
    try {
      const res = await apiFetch('/api/system/metrics', 'GET', null, false);
      if (!res.ok) throw new Error(`${res.status}`);
      const text = await res.text();

      // Parse Prometheus text format
      const lines = text.split('\n').filter(l => l && !l.startsWith('#'));
      const parsed = lines.map(line => {
        const m = line.match(/^([^\s{]+)(\{[^}]*\})?\s+([\d.e+\-]+)(\s+\d+)?$/);
        if (!m) return null;
        return { name: m[1], labels: m[2] || '', value: m[3] };
      }).filter(Boolean);

      if (!parsed.length) {
        tbody.innerHTML = emptyRow(3, 'No metrics available.');
        return;
      }

      tbody.innerHTML = parsed.map(m => `
        <tr>
          <td class="td-mono" style="color:var(--text)">${esc(m.name)}${m.labels ? `<span style="color:var(--text-3);font-size:11px">${esc(m.labels)}</span>` : ''}</td>
          <td class="td-mono" style="color:var(--secondary)">${esc(m.value)}</td>
          <td><span class="badge badge-approved">gauge</span></td>
        </tr>
      `).join('');
    } catch (e) {
      tbody.innerHTML = emptyRow(3, `Could not load metrics: ${e.message}`);
    }
  }

  // ── Toast ──────────────────────────────────────────────────────────────────

  function toast(msg, type = 'info', duration = 3800) {
    const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
    const wrap = document.getElementById('toastWrap');
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ'}</span><span>${esc(msg)}</span>`;
    wrap.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.4s';
      setTimeout(() => el.remove(), 400);
    }, duration);
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  async function apiFetch(path, method = 'GET', body = null, useToken = true) {
    const headers = { 'Content-Type': 'application/json' };
    if (useToken && token) headers['Authorization'] = `Bearer ${token}`;
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(BASE + path, opts);
    if (res.status === 401 && useToken) {
      logout();
      throw new Error('Session expired — please sign in again');
    }
    return res;
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = String(text);
  }

  function updateBadge(id, count) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = count;
    el.className = `nav-badge${count === 0 ? ' zero' : ''}`;
  }

  function esc(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch { return iso; }
  }

  function relativeTime(iso) {
    if (!iso) return '—';
    try {
      const diff = Date.now() - new Date(iso).getTime();
      const m = Math.floor(diff / 60000);
      if (m < 1) return 'Just now';
      if (m < 60) return `${m}m ago`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h ago`;
      return `${Math.floor(h / 24)}d ago`;
    } catch { return iso; }
  }

  function formatUptime(secs) {
    if (secs == null) return '—';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return `${h}h ${m}m`;
  }

  function statusBadge(status) {
    const map = {
      pending:  'badge-pending',
      approved: 'badge-approved',
      rejected: 'badge-rejected',
      admin:    'badge-admin',
    };
    const cls = map[status] || 'badge-pending';
    return `<span class="badge ${cls}">${esc(status || '—')}</span>`;
  }

  function skeletonRows(rows, cols) {
    const sizes = ['skel-sm', 'skel-md', 'skel-lg'];
    return Array.from({ length: rows }, () =>
      `<tr class="skel-row">${Array.from({ length: cols }, (_, i) =>
        `<td><div class="skel ${sizes[i % 3]}"></div></td>`
      ).join('')}</tr>`
    ).join('');
  }

  function emptyRow(cols, msg) {
    return `<tr><td colspan="${cols}"><div class="empty-state"><div class="empty-icon">📭</div><div class="empty-title">Nothing here</div><div class="empty-msg">${esc(msg)}</div></div></td></tr>`;
  }

  // Very lightweight C syntax highlighter
  function highlightC(code) {
    if (!code) return '';
    const safe = esc(code);
    return safe
      .replace(/\b(void|int|uint8_t|uint16_t|uint32_t|bool|char|float|double|return|static|const|struct|typedef|enum|if|else|for|while|switch|case|break|default|include|define|ifndef|endif)\b/g, '<span class="kw">$1</span>')
      .replace(/\b(esp_err_t|ESP_OK|ESP_FAIL|ESP_LOGI|ESP_LOGE|ESP_LOGW|i2c_master_write_byte|gpio_set_level|vTaskDelay)\b/g, '<span class="kw2">$1</span>')
      .replace(/(&#34;[^&#]*&#34;)/g, '<span class="str">$1</span>')
      .replace(/(\/\*[\s\S]*?\*\/|\/\/[^\n]*)/g, '<span class="cmt">$1</span>')
      .replace(/\b(\d+)\b/g, '<span class="num">$1</span>');
  }

  // ── UPI Payments ──────────────────────────────────────────────────────────

  async function loadPayments() {
    const tbody = document.getElementById('paymentsTableBody');
    tbody.innerHTML = skeletonRows(3, 6);
    try {
      const res = await apiFetch('/api/billing/admin/pending', 'GET');
      if (!res.ok) throw new Error(`${res.status}`);
      const claims = await res.json();

      updateBadge('paymentsBadge', claims.length);

      if (!claims.length) {
        tbody.innerHTML = emptyRow(6, 'No pending payment claims — all caught up! ✅');
        return;
      }

      tbody.innerHTML = claims.map(c => `
        <tr>
          <td class="td-mono">${c.id}</td>
          <td class="td-mono">${esc(c.user_id)}</td>
          <td class="td-mono" style="color:var(--secondary);font-weight:600">${esc(c.upi_utr)}</td>
          <td>₹${c.amount_inr}</td>
          <td class="td-mono">${formatDate(c.submitted_at)}</td>
          <td onclick="event.stopPropagation()">
            <div class="row-actions">
              <button class="btn-approve" onclick="Admin.approvePayment(${c.id})">✓ Approve</button>
              <button class="btn-reject" onclick="Admin.rejectPayment(${c.id})">✕ Reject</button>
            </div>
          </td>
        </tr>
      `).join('');
    } catch (e) {
      tbody.innerHTML = emptyRow(6, `Could not load payment claims: ${e.message}`);
    }
  }

  async function approvePayment(claimId) {
    try {
      const res = await apiFetch('/api/billing/admin/approve', 'POST', { claim_id: claimId });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      toast(data.message || 'Payment approved — user upgraded to Maker tier', 'success');
      loadPayments();
    } catch (e) {
      toast(`Approve failed: ${e.message}`, 'error');
    }
  }

  async function rejectPayment(claimId) {
    if (!confirm('Reject this payment claim?')) return;
    try {
      const res = await apiFetch('/api/billing/admin/reject', 'POST', { claim_id: claimId });
      if (!res.ok) throw new Error(`${res.status}`);
      toast('Payment claim rejected', 'info');
      loadPayments();
    } catch (e) {
      toast(`Reject failed: ${e.message}`, 'error');
    }
  }

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeDrawer();
    if (e.key === 'Enter' && document.getElementById('loginScreen').classList.contains('show')) {
      submitLogin();
    }
  });

  // ── Public API ─────────────────────────────────────────────────────────────

  return {
    init,
    submitLogin,
    logout,
    navigate,
    toggleSidebar,
    loadDashboard,
    loadPending,
    loadAllDrivers,
    loadUsers,
    loadPayments,
    approvePayment,
    rejectPayment,
    loadHealth,
    loadMetrics,
    filterPending,
    filterAllDrivers,
    filterUsers,
    openDriver,
    openDrawer,
    closeDrawer,
    copySource,
    approveDriver,
    openRejectDialog,
    rejectDriver,
    revokeDriver,
    approveFromDrawer,
    rejectFromDrawer,
    revokeFromDrawer,
    toast,
  };
})();

document.addEventListener('DOMContentLoaded', Admin.init);
