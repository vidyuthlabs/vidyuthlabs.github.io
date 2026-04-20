/* ================================================================
   Parakram Web Playground — app.js
   No build step required. Open index.html in a browser.
================================================================ */

const App = (() => {
  /* ─── State ─────────────────────────────────────────────── */
  let baseUrl  = localStorage.getItem('pk_base_url') || 'http://localhost:8400';
  let token    = localStorage.getItem('pk_token') || null;
  let currentStep  = 1;
  let selectedBoard = 'VDYT-S3-R1';
  let pendingIR     = null;   // raw IR from /api/llm/intent
  let compileData   = null;   // result from /api/ir/compile
  let authResolve   = null;   // resolve fn for login promise

  /* ─── Boot ───────────────────────────────────────────────── */
  function init() {
    syncBaseUrlInputs();
    checkHealth();
    setInterval(checkHealth, 30_000);
    bindEvents();
    updateLoginButton();
  }

  function bindEvents() {
    // Textarea char count + enable/disable generate button
    const ta  = document.getElementById('promptInput');
    const btn = document.getElementById('generateBtn');
    ta.addEventListener('input', () => {
      const n = ta.value.length;
      document.getElementById('charCount').textContent = `${n} chars`;
      btn.disabled = n < 10;
    });

    // Board pills
    document.querySelectorAll('#boardPills .pill').forEach(p => {
      p.addEventListener('click', () => {
        document.querySelectorAll('#boardPills .pill').forEach(x => x.classList.remove('active'));
        p.classList.add('active');
        selectedBoard = p.dataset.board;
      });
    });

    // Example chips
    document.querySelectorAll('.example-chips .chip').forEach(c => {
      c.addEventListener('click', () => {
        const ta = document.getElementById('promptInput');
        ta.value = c.dataset.prompt;
        ta.dispatchEvent(new Event('input'));
        ta.focus();
      });
    });

    // Footer URL input
    document.getElementById('baseUrlInput').addEventListener('change', e => {
      setBaseUrl(e.target.value.trim());
    });

    // Overlay URL input
    document.getElementById('overlayUrlInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') retryConnection();
    });

    // Auth fields — enter to submit
    document.getElementById('authPassword').addEventListener('keydown', e => {
      if (e.key === 'Enter') submitLogin();
    });
  }

  /* ─── URL helpers ────────────────────────────────────────── */
  function setBaseUrl(url) {
    baseUrl = url.replace(/\/$/, '');
    localStorage.setItem('pk_base_url', baseUrl);
    syncBaseUrlInputs();
    checkHealth();
  }

  function syncBaseUrlInputs() {
    document.getElementById('baseUrlInput').value    = baseUrl;
    document.getElementById('overlayUrlInput').value = baseUrl;
  }

  /* ─── API fetch wrapper ──────────────────────────────────── */
  async function api(path, opts = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    };
    const res = await fetch(baseUrl + path, { ...opts, headers });

    if (res.status === 401) {
      // Try to login, then retry
      const ok = await promptLogin();
      if (ok) {
        return api(path, opts);
      }
      throw new Error('Authentication required');
    }

    return res;
  }

  /* ─── Health check ───────────────────────────────────────── */
  async function checkHealth() {
    const badge = document.getElementById('statusBadge');
    const label = document.getElementById('statusLabel');
    try {
      const res = await fetch(baseUrl + '/api/system/health', { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        badge.className = 'status-badge online';
        label.textContent = 'Backend: Online';
        hideOfflineOverlay();
        return;
      }
    } catch (_) {}
    badge.className = 'status-badge offline';
    label.textContent = 'Backend: Offline';
  }

  function retryConnection() {
    const url = document.getElementById('overlayUrlInput').value.trim();
    if (url) setBaseUrl(url);
    checkHealth().then(() => {
      const badge = document.getElementById('statusBadge');
      if (badge.classList.contains('online')) hideOfflineOverlay();
    });
  }

  function showOfflineOverlay() {
    document.getElementById('offlineOverlay').classList.add('show');
  }
  function hideOfflineOverlay() {
    document.getElementById('offlineOverlay').classList.remove('show');
  }

  /* ─── Step navigation ────────────────────────────────────── */
  function goStep(n) {
    // Hide current
    document.getElementById(`step-${currentStep}`).classList.remove('active');
    currentStep = n;
    // Show new
    const stepEl = document.getElementById(`step-${n}`);
    stepEl.classList.add('active');
    updateStepIndicator(n);
    stepEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function updateStepIndicator(active) {
    document.querySelectorAll('.step-item').forEach(el => {
      const s = parseInt(el.dataset.step);
      el.classList.toggle('active', s === active);
      el.classList.toggle('done',   s < active);
    });
    [1, 2, 3].forEach(i => {
      const line = document.getElementById(`line-${i}`);
      if (line) line.classList.toggle('done', i < active);
    });
  }

  /* ─── Step 1 → Generate IR ───────────────────────────────── */
  async function generate() {
    const description = document.getElementById('promptInput').value.trim();
    if (description.length < 10) return;

    const btn = document.getElementById('generateBtn');
    setLoading(btn, true);
    pendingIR   = null;
    compileData = null;

    // Move to step 2 with loader visible
    goStep(2);
    document.getElementById('irLoader').style.display  = '';
    document.getElementById('irPreview').style.display = 'none';

    try {
      const res = await api('/api/llm/intent', {
        method: 'POST',
        body: JSON.stringify({
          description: description,
          boardId: selectedBoard,
          deviceId: null,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error?.message || data.message || `Error ${res.status}`);
      }

      if (!data.feasible) {
        throw new Error(data.reason || data.error?.message || 'The AI determined this request is not feasible for the selected board.');
      }

      pendingIR = data.ir || data;
      renderIRPreview(data);
      toast('IR generated successfully', 'success');

    } catch (err) {
      if (err.name === 'TypeError' || err.message.includes('fetch')) {
        showOfflineOverlay();
        goStep(1);
      } else {
        toast(err.message || 'Generation failed', 'error');
        goStep(1);
      }
    } finally {
      setLoading(btn, false);
    }
  }

  function renderIRPreview(data) {
    const pv = data.ir_preview || data.irPreview || {};

    // Feasibility
    const badge = document.getElementById('feasibilityBadge');
    badge.className = 'feasibility-badge ' + (data.feasible ? 'feasible' : 'infeasible');
    badge.textContent = data.feasible ? 'Feasible' : 'Not Feasible';

    // Summary
    document.getElementById('irSummary').textContent =
      pv.summary || data.summary || 'Intent representation generated successfully.';

    // Sensors
    const sensors = pv.sensors_used || pv.sensors || [];
    document.getElementById('sensorTags').innerHTML =
      sensors.length
        ? sensors.map(s => `<span class="tag tag-sensor">${escHtml(s)}</span>`).join('')
        : '<span style="color:var(--text-3);font-size:12px">None</span>';

    // Actuators
    const actuators = pv.actuators_used || pv.actuators || [];
    document.getElementById('actuatorTags').innerHTML =
      actuators.length
        ? actuators.map(a => `<span class="tag tag-actuator">${escHtml(a)}</span>`).join('')
        : '<span style="color:var(--text-3);font-size:12px">None</span>';

    // Triggers
    const triggers = pv.triggers || [];
    document.getElementById('triggerList').innerHTML =
      triggers.length
        ? triggers.map(t => `<li><span class="list-bullet">▸</span>${escHtml(t.description || t)}</li>`).join('')
        : '<li><span class="list-bullet">▸</span><span style="color:var(--text-3)">None specified</span></li>';

    // Actions
    const actions = pv.actions || [];
    document.getElementById('actionList').innerHTML =
      actions.length
        ? actions.map(a => `<li><span class="list-bullet">▸</span>${escHtml(a.description || a)}</li>`).join('')
        : '<li><span class="list-bullet">▸</span><span style="color:var(--text-3)">None specified</span></li>';

    // Show preview
    document.getElementById('irLoader').style.display  = 'none';
    document.getElementById('irPreview').style.display = '';
  }

  /* ─── Step 2 → Compile ───────────────────────────────────── */
  const COMPILE_STAGES = [
    { id: 'parse',    label: 'Parsing IR document',           pct: 20, ms: 400  },
    { id: 'optimize', label: 'Optimizing pipeline graph',     pct: 50, ms: 700  },
    { id: 'emit',     label: 'Emitting bytecode instructions', pct: 75, ms: 500 },
    { id: 'sign',     label: 'Signing with Ed25519 key',      pct: 90, ms: 350  },
  ];

  async function compile() {
    if (!pendingIR) { toast('No IR available — please generate first', 'error'); return; }

    goStep(3);
    document.getElementById('compileResult').classList.remove('show');
    resetProgSteps();
    setProgBar(0);

    // Animate fake stages while real compile runs
    const compilePromise = doCompile();
    await animateStages(compilePromise);

    const result = await compilePromise;
    if (!result) return; // error already toasted

    setProgBar(100);
    markStageDone('sign');

    compileData = result;
    showCompileResult(result);
  }

  async function doCompile() {
    try {
      const res = await api('/api/ir/compile', {
        method: 'POST',
        body: JSON.stringify({
          ir: pendingIR,
          deviceId: 'demo-device',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || data.message || `Compile error ${res.status}`);
      return data;
    } catch (err) {
      if (err.name === 'TypeError' || err.message.includes('fetch')) showOfflineOverlay();
      else toast(err.message || 'Compilation failed', 'error');
      goStep(2);
      return null;
    }
  }

  function resetProgSteps() {
    document.querySelectorAll('.prog-step').forEach(el => {
      el.className = 'prog-step';
    });
  }

  async function animateStages(compilePromise) {
    let done = false;
    compilePromise.then(() => { done = true; });

    for (let i = 0; i < COMPILE_STAGES.length; i++) {
      const stage = COMPILE_STAGES[i];
      markStageRunning(stage.id);
      setProgBar(stage.pct);
      await sleep(stage.ms);
      if (done && i < COMPILE_STAGES.length - 1) {
        // backend returned fast — finish remaining stages quickly
        for (let j = i; j < COMPILE_STAGES.length - 1; j++) {
          markStageDone(COMPILE_STAGES[j].id);
          markStageRunning(COMPILE_STAGES[j + 1].id);
          setProgBar(COMPILE_STAGES[j + 1].pct);
          await sleep(180);
        }
        break;
      }
      markStageDone(stage.id);
    }
  }

  function markStageRunning(id) {
    const el = document.querySelector(`.prog-step[data-stage="${id}"]`);
    if (el) el.className = 'prog-step running';
  }
  function markStageDone(id) {
    const el = document.querySelector(`.prog-step[data-stage="${id}"]`);
    if (el) el.className = 'prog-step done';
  }
  function setProgBar(pct) {
    document.getElementById('progBar').style.width = pct + '%';
  }

  function showCompileResult(data) {
    const sizeBytes  = data.size_bytes || data.sizeBytes || '—';
    const instrCount = data.instruction_count || data.instructionCount || data.num_instructions || '—';
    const hash       = data.hash || data.checksum || '';

    document.getElementById('cSize').textContent         = sizeBytes !== '—' ? `${sizeBytes} B` : '—';
    document.getElementById('cInstructions').textContent = instrCount;
    document.getElementById('cHash').textContent         = hash ? hash.slice(0, 8) : '—';

    document.getElementById('compileResult').classList.add('show');
    toast('Compilation successful', 'success');
  }

  /* ─── Step 3 → Deploy ────────────────────────────────────── */
  function deploy() {
    if (!compileData) return;

    const sizeBytes  = compileData.size_bytes || compileData.sizeBytes || '—';
    const instrCount = compileData.instruction_count || compileData.instructionCount || compileData.num_instructions || '—';
    const hash       = compileData.hash || compileData.checksum || '';

    document.getElementById('sSize').textContent         = sizeBytes !== '—' ? `${sizeBytes} B` : '—';
    document.getElementById('sHash').textContent         = hash ? hash.slice(0, 8) : '—';
    document.getElementById('sInstructions').textContent = instrCount;

    // Persist to sessionStorage for the flasher page
    if (compileData.bytecode_b64) {
      sessionStorage.setItem('parakram_bytecode', compileData.bytecode_b64);
      sessionStorage.setItem('parakram_bytecode_size', sizeBytes);
    }

    goStep(4);
    toast('Bytecode ready for deployment!', 'success');
  }

  /* ─── Reset ──────────────────────────────────────────────── */
  function reset() {
    pendingIR   = null;
    compileData = null;
    document.getElementById('promptInput').value = '';
    document.getElementById('charCount').textContent = '0 chars';
    document.getElementById('generateBtn').disabled  = true;
    goStep(1);
  }

  /* ─── Auth ───────────────────────────────────────────────── */
  function openLogin() {
    document.getElementById('authModal').classList.add('show');
    document.getElementById('authEmail').focus();
    document.getElementById('authError').style.display = 'none';
  }

  function closeLogin() {
    document.getElementById('authModal').classList.remove('show');
    if (authResolve) { authResolve(false); authResolve = null; }
  }

  // Called when a 401 is hit — returns promise<bool> (logged in or not)
  function promptLogin() {
    return new Promise(resolve => {
      authResolve = resolve;
      openLogin();
    });
  }

  async function submitLogin() {
    const email    = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    const errEl    = document.getElementById('authError');
    const btn      = document.getElementById('loginSubmitBtn');

    if (!email || !password) {
      showAuthError('Please enter both fields.');
      return;
    }

    errEl.style.display = 'none';
    setLoading(btn, true);

    try {
      const res = await fetch(baseUrl + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: email, email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || data.message || 'Login failed');

      token = data.token || data.access_token;
      localStorage.setItem('pk_token', token);
      updateLoginButton();
      closeLogin();
      toast('Signed in successfully', 'success');
      if (authResolve) { authResolve(true); authResolve = null; }

    } catch (err) {
      showAuthError(err.message || 'Login failed');
    } finally {
      setLoading(btn, false);
    }
  }

  function showAuthError(msg) {
    const el = document.getElementById('authError');
    el.textContent = msg;
    el.style.display = 'block';
  }

  function updateLoginButton() {
    const btn = document.getElementById('loginBtn');
    if (token) {
      btn.textContent = 'Logged In';
      btn.classList.add('logged-in');
      btn.onclick = () => {
        token = null;
        localStorage.removeItem('pk_token');
        btn.textContent = 'Login';
        btn.classList.remove('logged-in');
        btn.onclick = () => App.openLogin();
        toast('Signed out', 'info');
      };
    } else {
      btn.textContent = 'Login';
      btn.classList.remove('logged-in');
      btn.onclick = () => App.openLogin();
    }
  }

  /* ─── Toasts ─────────────────────────────────────────────── */
  function toast(msg, type = 'info') {
    const wrap = document.getElementById('toastWrap');
    const el   = document.createElement('div');
    el.className = `toast toast-${type}`;
    const icon = type === 'error' ? '✕ ' : type === 'success' ? '✓ ' : 'ℹ ';
    el.textContent = icon + msg;
    wrap.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateX(24px)';
      el.style.transition = 'opacity 0.3s, transform 0.3s';
      setTimeout(() => el.remove(), 310);
    }, 4000);
  }

  /* ─── Utilities ──────────────────────────────────────────── */
  function setLoading(btn, loading) {
    btn.classList.toggle('loading', loading);
    btn.disabled = loading;
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ─── Public API ─────────────────────────────────────────── */
  return {
    init,
    generate,
    compile,
    deploy,
    reset,
    goStep,
    openLogin,
    closeLogin,
    submitLogin,
    retryConnection,
  };
})();

// Boot
document.addEventListener('DOMContentLoaded', () => App.init());
