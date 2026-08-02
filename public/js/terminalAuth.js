// POS/KDS auth — completely separate from the dashboard's user-JWT login
// (public/js/auth.js). Shop-floor devices authenticate as a TERMINAL (short
// code + PIN), not as a dashboard user.
//
// Auth material lives ONLY in httpOnly cookies now (cm_device, cm_session),
// set by the server and never readable or storable from this module. cm_csrf
// is the one non-httpOnly cookie (by design, for the double-submit CSRF
// check) and is echoed back as the X-CSRF-Token header on every
// state-changing request. Nothing here persists a token to localStorage --
// only display metadata (terminal name/branch) and small UX flags.

const INFO_KEY      = 'terminal_info';        // display-only: { type, terminal_id, branch_id, name, idle_timeout_minutes }
const DEVICE_ID_KEY = 'device_terminal_id';    // remembered terminal_id, just to prefill the login screen
const LOCKED_KEY_PREFIX = 'terminal_locked_';  // per-terminal, so switching terminals on one browser doesn't cross-lock

export function getTerminalInfo() {
  try { return JSON.parse(localStorage.getItem(INFO_KEY)); }
  catch { return null; }
}
function setTerminalInfo(info) {
  localStorage.setItem(INFO_KEY, JSON.stringify(info));
}

export function getDeviceTerminalId() {
  return localStorage.getItem(DEVICE_ID_KEY) || '';
}
export function setDeviceTerminalId(id) {
  localStorage.setItem(DEVICE_ID_KEY, id);
}
export function clearDeviceTerminalId() {
  localStorage.removeItem(DEVICE_ID_KEY);
}

function lockedKey() {
  const info = getTerminalInfo();
  return LOCKED_KEY_PREFIX + (info ? info.terminal_id : 'unknown');
}

export function getCsrfToken() {
  const m = document.cookie.match(/(?:^|;\s*)cm_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

// No navigation here (unlike the dashboard's logout()) -- there's no /login
// page for a terminal to go to. Callers show the PIN screen again instead.
export function terminalLogout() {
  // Best-effort explicit revoke -- a deliberate sign-out, unlike an idle lock,
  // so the device token itself is invalidated server-side too.
  fetch('/api/terminal/logout', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'X-CSRF-Token': getCsrfToken() },
  }).catch(() => { /* cookies are cleared client-side regardless below */ });

  localStorage.removeItem(lockedKey());
  localStorage.removeItem(INFO_KEY);
  window.dispatchEvent(new Event('terminal-logged-out'));
}

export async function terminalLogin(terminalId, passcode) {
  try {
    const r = await fetch('/api/terminal/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminal_id: terminalId, passcode }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, message: data.message || 'Invalid terminal ID or passcode.' };
    setTerminalInfo({ ...data.terminal, idle_timeout_minutes: data.idle_timeout_minutes });
    setDeviceTerminalId(terminalId);
    localStorage.removeItem(lockedKey());
    return { ok: true, terminal: data.terminal, idle_timeout_minutes: data.idle_timeout_minutes };
  } catch {
    return { ok: false, message: 'Network error. Please try again.' };
  }
}

// ─── Silent session refresh ─────────────────────────────────────────────────
// Re-mints the session cookie from the (much longer-lived) device cookie.
// Shared as a single in-flight promise so a stampede of simultaneous 401s
// (several API calls failing at once right after boot, or right as a 12h
// session lapses mid-shift) triggers exactly one refresh call, not one each.

let refreshPromise = null;

function refreshSession() {
  if (!refreshPromise) {
    refreshPromise = fetch('/api/terminal/session/refresh', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': getCsrfToken() },
    })
      .then(async r => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) return { ok: false };
        setTerminalInfo({ ...data.terminal, idle_timeout_minutes: data.idle_timeout_minutes });
        return { ok: true, terminal: data.terminal, idle_timeout_minutes: data.idle_timeout_minutes };
      })
      .catch(() => ({ ok: false }))
      .finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}
export { refreshSession };

// Called once at app boot, before rendering anything -- if it succeeds, staff
// see the POS/KDS immediately with no login prompt at all, no matter how
// long it's been since the tablet was last touched or rebooted.
export async function bootSession() {
  return refreshSession();
}

// ─── Authenticated fetch wrapper ────────────────────────────────────────────
// Every terminal API call goes through this: credentials included, CSRF
// header set on state-changing methods, and a single silent-refresh-then-
// retry on a 401 before giving up and dropping to the PIN screen.
async function request(method, url, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (method !== 'GET') headers['X-CSRF-Token'] = getCsrfToken();
  const opts = { method, credentials: 'same-origin', headers, body: body !== undefined ? JSON.stringify(body) : undefined };

  let r;
  try { r = await fetch(url, opts); }
  catch { return { ok: false, status: 0, data: {}, networkError: true }; }

  if (r.status === 401) {
    const refreshed = await refreshSession();
    if (refreshed.ok) {
      if (method !== 'GET') opts.headers['X-CSRF-Token'] = getCsrfToken(); // refresh rotates this cookie too
      try { r = await fetch(url, opts); }
      catch { return { ok: false, status: 0, data: {}, networkError: true }; }
    }
    if (r.status === 401) {
      terminalLogout();
      return { ok: false, status: 401, data: {}, networkError: false };
    }
  }

  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data, networkError: false };
}

export async function fetchTerminalJSON(url) {
  const { ok, data } = await request('GET', url);
  return ok ? data : null;
}
export function terminalApiPost(url, body = {})   { return request('POST', url, body); }
export function terminalApiPatch(url, body = {})  { return request('PATCH', url, body); }
export function terminalApiDelete(url)            { return request('DELETE', url); }

// ─── Idle lock (person check, not device check) ─────────────────────────────
// Locks the screen after inactivity without touching the session -- cart/KDS
// board state stays intact underneath. Persisted across a refresh or reboot
// via localStorage so neither can be used to bypass the lock.

let idleTimer = null;
let idleTimeoutMs = 30 * 60 * 1000;
let lockOverlayEl = null;

function clearIdleTimer() { clearTimeout(idleTimer); }

function armIdleTimer() {
  clearIdleTimer();
  idleTimer = setTimeout(triggerLock, idleTimeoutMs);
}

function triggerLock() {
  if (lockOverlayEl) return; // already locked
  localStorage.setItem(lockedKey(), '1');
  clearIdleTimer();
  showLockOverlay();
}

/** Manual lock, e.g. the POS header's 🔒 button. */
export function lockNow() { triggerLock(); }

async function callUnlock(passcode) {
  try {
    const r = await fetch('/api/terminal/unlock', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
      body: JSON.stringify({ passcode }),
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } catch {
    return { ok: false, status: 0, data: {} };
  }
}

function showLockOverlay() {
  if (lockOverlayEl) return;
  const info = getTerminalInfo();

  let pin = '';
  const overlay = document.createElement('div');
  lockOverlayEl = overlay;
  overlay.id = 'terminalLockOverlay';
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 10000; display: flex; align-items: safe center; justify-content: center;
    background: var(--bg-canvas); color: var(--text-primary); font-family: var(--font-sans);
    overflow-y: auto; padding: 16px; box-sizing: border-box;
  `;
  document.body.appendChild(overlay);

  function render() {
    const dots = Array.from({ length: 6 }, (_, i) => `
      <span style="width:16px;height:16px;border-radius:50%;border:2px solid var(--border-strong);
        background:${i < pin.length ? 'var(--accent)' : 'transparent'};
        border-color:${i < pin.length ? 'var(--accent)' : 'var(--border-strong)'};"></span>
    `).join('');

    overlay.innerHTML = `
      <div style="width:100%;max-width:340px;padding:28px;border-radius:16px;background:var(--bg-surface);
        border:1px solid var(--border);box-shadow:var(--shadow-lift);">
        <div style="text-align:center;font-size:22px;margin-bottom:6px;">🔒</div>
        <div style="text-align:center;font-size:15px;font-weight:700;color:var(--accent-strong);margin-bottom:4px;">${info ? (info.name || info.terminal_id) : 'Locked'}</div>
        <div style="text-align:center;font-size:12px;color:var(--text-secondary);margin-bottom:18px;">Enter PIN to resume</div>

        <div style="display:flex;justify-content:center;gap:10px;margin:18px 0;">${dots}</div>

        <div id="tlkError" style="min-height:18px;text-align:center;font-size:12px;color:var(--loss);margin-bottom:8px;"></div>

        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;">
          ${[1,2,3,4,5,6,7,8,9].map(n => `<button type="button" class="tlk-digit" data-d="${n}"
              style="height:52px;border-radius:10px;border:1px solid var(--border);background:var(--bg-surface-alt);
              color:var(--text-primary);font-size:18px;font-weight:700;cursor:pointer;">${n}</button>`).join('')}
          <button type="button" id="tlkClear" style="height:52px;border-radius:10px;border:1px solid var(--border);
            background:none;color:var(--text-secondary);font-size:13px;font-weight:600;cursor:pointer;">Clear</button>
          <button type="button" class="tlk-digit" data-d="0" style="height:52px;border-radius:10px;border:1px solid var(--border);
            background:var(--bg-surface-alt);color:var(--text-primary);font-size:18px;font-weight:700;cursor:pointer;">0</button>
          <button type="button" id="tlkBackspace" style="height:52px;border-radius:10px;border:1px solid var(--border);
            background:none;color:var(--text-secondary);font-size:18px;cursor:pointer;">⌫</button>
        </div>

        <button type="button" id="tlkSubmit" style="width:100%;height:52px;margin-top:14px;border-radius:10px;border:none;
          background:var(--accent);color:var(--accent-contrast);font-size:15px;font-weight:700;cursor:pointer;" disabled>Unlock</button>
      </div>
    `;

    overlay.querySelectorAll('.tlk-digit').forEach(btn => {
      btn.addEventListener('click', () => {
        if (pin.length >= 6) return;
        pin += btn.dataset.d;
        render();
        if (pin.length === 6) submit();
      });
    });
    overlay.querySelector('#tlkBackspace').addEventListener('click', () => { pin = pin.slice(0, -1); render(); });
    overlay.querySelector('#tlkClear').addEventListener('click', () => { pin = ''; render(); });
    overlay.querySelector('#tlkSubmit').addEventListener('click', submit);
    overlay.querySelector('#tlkSubmit').disabled = pin.length < 6;
  }

  async function submit() {
    if (pin.length < 6) return;
    const btn = overlay.querySelector('#tlkSubmit');
    const errEl = overlay.querySelector('#tlkError');
    if (btn) btn.disabled = true;
    if (errEl) errEl.textContent = '';

    const { ok, status, data } = await callUnlock(pin);
    if (ok) {
      localStorage.removeItem(lockedKey());
      overlay.remove();
      lockOverlayEl = null;
      armIdleTimer();
      return;
    }

    if (status === 423 && /too many/i.test(data.message || '')) {
      // Server already cleared the session cookie -- drop all the way back
      // to the full terminal-ID+PIN login rather than re-showing unlock.
      localStorage.removeItem(lockedKey());
      overlay.remove();
      lockOverlayEl = null;
      window.dispatchEvent(new Event('terminal-logged-out'));
      return;
    }

    pin = '';
    render();
    const msg = overlay.querySelector('#tlkError');
    if (msg) msg.textContent = data.message || 'Incorrect PIN.';
  }

  render();
}

/** Starts (or restarts) the idle watch. Call once per app boot / after login. */
export function startIdleWatch(idleMinutes) {
  idleTimeoutMs = (Number(idleMinutes) || 30) * 60 * 1000;
  ['pointerdown', 'keydown', 'touchstart'].forEach(evt => {
    window.addEventListener(evt, () => { if (!lockOverlayEl) armIdleTimer(); }, { passive: true });
  });
  if (localStorage.getItem(lockedKey()) === '1') {
    triggerLock();
  } else {
    armIdleTimer();
  }
}

// ─── PIN-pad login screen ───────────────────────────────────────────────────
// Shared between pos.html and kds.html. Renders a full-screen overlay on top
// of whatever's already in the DOM; the caller's page markup stays untouched
// underneath until login succeeds.

export function showTerminalLogin({ label, onSuccess }) {
  // Several concurrent API calls can each 401 right after startup, each
  // independently asking to show the login screen -- without this guard
  // every one of them would stack its own copy.
  if (document.getElementById('terminalLoginOverlay')) return;

  let pin = '';
  let terminalId = getDeviceTerminalId();
  let editingTerminalId = !terminalId;

  const overlay = document.createElement('div');
  overlay.id = 'terminalLoginOverlay';
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 9999; display: flex; align-items: safe center; justify-content: center;
    background: var(--bg-canvas); color: var(--text-primary); font-family: var(--font-sans);
    overflow-y: auto; padding: 16px; box-sizing: border-box;
  `;
  document.body.appendChild(overlay);

  function render() {
    const dots = Array.from({ length: 6 }, (_, i) => `
      <span style="width:16px;height:16px;border-radius:50%;border:2px solid var(--border-strong);
        background:${i < pin.length ? 'var(--accent)' : 'transparent'};
        border-color:${i < pin.length ? 'var(--accent)' : 'var(--border-strong)'};"></span>
    `).join('');

    overlay.innerHTML = `
      <div style="width:100%;max-width:340px;padding:28px;border-radius:16px;background:var(--bg-surface);
        border:1px solid var(--border);box-shadow:var(--shadow-lift);">
        <div style="text-align:center;font-size:15px;font-weight:700;color:var(--accent-strong);margin-bottom:18px;">${label}</div>

        <div style="margin-bottom:14px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-secondary);margin-bottom:6px;">Terminal ID</div>
          ${editingTerminalId
            ? `<input id="tlTerminalIdInput" type="text" placeholder="e.g. PP-POS-01" value="${terminalId}"
                 style="width:100%;height:46px;border-radius:10px;border:1px solid var(--border);background:var(--bg-canvas);
                 color:var(--text-primary);padding:0 12px;font-size:15px;text-transform:uppercase;"/>`
            : `<div style="display:flex;align-items:center;justify-content:space-between;height:46px;padding:0 12px;
                 border-radius:10px;background:var(--bg-surface-alt);border:1px solid var(--border);">
                 <span style="font-weight:700;font-family:var(--font-num);">${terminalId}</span>
                 <button type="button" id="tlChangeTerminalBtn" style="background:none;border:none;color:var(--accent-strong);
                   font-size:12px;font-weight:600;cursor:pointer;padding:4px;">change terminal</button>
               </div>`
          }
        </div>

        <div style="display:flex;justify-content:center;gap:10px;margin:18px 0;">${dots}</div>

        <div id="tlError" style="min-height:18px;text-align:center;font-size:12px;color:var(--loss);margin-bottom:8px;"></div>

        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;">
          ${[1,2,3,4,5,6,7,8,9].map(n => `<button type="button" class="tl-digit" data-d="${n}"
              style="height:52px;border-radius:10px;border:1px solid var(--border);background:var(--bg-surface-alt);
              color:var(--text-primary);font-size:18px;font-weight:700;cursor:pointer;">${n}</button>`).join('')}
          <button type="button" id="tlClear" style="height:52px;border-radius:10px;border:1px solid var(--border);
            background:none;color:var(--text-secondary);font-size:13px;font-weight:600;cursor:pointer;">Clear</button>
          <button type="button" class="tl-digit" data-d="0" style="height:52px;border-radius:10px;border:1px solid var(--border);
            background:var(--bg-surface-alt);color:var(--text-primary);font-size:18px;font-weight:700;cursor:pointer;">0</button>
          <button type="button" id="tlBackspace" style="height:52px;border-radius:10px;border:1px solid var(--border);
            background:none;color:var(--text-secondary);font-size:18px;cursor:pointer;">⌫</button>
        </div>

        <button type="button" id="tlSubmit" style="width:100%;height:52px;margin-top:14px;border-radius:10px;border:none;
          background:var(--accent);color:var(--accent-contrast);font-size:15px;font-weight:700;cursor:pointer;" disabled>Log In</button>
      </div>
    `;

    if (editingTerminalId) {
      const input = overlay.querySelector('#tlTerminalIdInput');
      input.addEventListener('input', () => { terminalId = input.value.trim().toUpperCase(); updateSubmitState(); });
      input.focus();
    } else {
      overlay.querySelector('#tlChangeTerminalBtn').addEventListener('click', () => {
        editingTerminalId = true;
        terminalId = '';
        pin = '';
        render();
      });
    }

    overlay.querySelectorAll('.tl-digit').forEach(btn => {
      btn.addEventListener('click', () => {
        if (pin.length >= 6) return;
        pin += btn.dataset.d;
        render();
      });
    });
    overlay.querySelector('#tlBackspace').addEventListener('click', () => { pin = pin.slice(0, -1); render(); });
    overlay.querySelector('#tlClear').addEventListener('click', () => { pin = ''; render(); });
    overlay.querySelector('#tlSubmit').addEventListener('click', submit);

    updateSubmitState();
  }

  function updateSubmitState() {
    const btn = overlay.querySelector('#tlSubmit');
    if (btn) btn.disabled = !(terminalId && pin.length === 6);
  }

  async function submit() {
    const btn = overlay.querySelector('#tlSubmit');
    const errEl = overlay.querySelector('#tlError');
    btn.disabled = true;
    errEl.textContent = '';

    const result = await terminalLogin(terminalId, pin);
    if (!result.ok) {
      pin = '';
      render();
      overlay.querySelector('#tlError').textContent = result.message;
      return;
    }

    overlay.remove();
    onSuccess(result.terminal, result.idle_timeout_minutes);
  }

  render();
}
