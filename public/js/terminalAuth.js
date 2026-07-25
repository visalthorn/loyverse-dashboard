// POS/KDS auth — completely separate from the dashboard's user-JWT login
// (public/js/auth.js). Shop-floor devices authenticate as a TERMINAL (short
// code + PIN), not as a dashboard user, and the token lives under its own
// localStorage key so a tablet that's also used to view the dashboard can't
// cross-contaminate sessions.

const TOKEN_KEY     = 'terminal_token';
const INFO_KEY      = 'terminal_info';
const DEVICE_ID_KEY = 'device_terminal_id';

export function getTerminalToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function getTerminalInfo() {
  try { return JSON.parse(localStorage.getItem(INFO_KEY)); }
  catch { return null; }
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

// No navigation here (unlike the dashboard's logout()) -- there's no /login
// page for a terminal to go to. Callers show the PIN screen again instead.
export function terminalLogout() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(INFO_KEY);
  window.dispatchEvent(new Event('terminal-logged-out'));
}

export async function terminalLogin(terminalId, passcode) {
  try {
    const r = await fetch('/api/terminal/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminal_id: terminalId, passcode }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, message: data.message || 'Invalid terminal ID or passcode.' };
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(INFO_KEY, JSON.stringify(data.terminal));
    setDeviceTerminalId(terminalId);
    return { ok: true, terminal: data.terminal };
  } catch {
    return { ok: false, message: 'Network error. Please try again.' };
  }
}

async function request(method, url, body) {
  const token = getTerminalToken();
  try {
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: token ? 'Bearer ' + token : '' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401) {
      terminalLogout();
      return { ok: false, status: 401, data: {}, networkError: false };
    }
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data, networkError: false };
  } catch {
    return { ok: false, status: 0, data: {}, networkError: true };
  }
}

export async function fetchTerminalJSON(url) {
  const { ok, data } = await request('GET', url);
  return ok ? data : null;
}
export function terminalApiPost(url, body = {})  { return request('POST', url, body); }
export function terminalApiPatch(url, body = {}) { return request('PATCH', url, body); }

// ─── PIN-pad login screen ───────────────────────────────────────────────────
// Shared between pos.html and kds.html. Renders a full-screen overlay on top
// of whatever's already in the DOM; the caller's page markup stays untouched
// underneath until login succeeds.

export function showTerminalLogin({ label, onSuccess }) {
  // Several concurrent API calls can each 401 against an invalid/expired
  // token right after startup, each independently asking to show the login
  // screen -- without this guard every one of them would stack its own copy.
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
    if (btn) btn.disabled = !(terminalId && pin.length >= 4);
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
    onSuccess(result.terminal);
  }

  render();
}
