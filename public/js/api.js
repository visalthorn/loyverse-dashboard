import { getToken, logout } from './auth.js';

export async function fetchJSON(url) {
  const token = getToken();
  try {
    const r = await fetch(url, { headers: { Authorization: token ? 'Bearer ' + token : '' } });
    if (r.status === 401) { logout(); return null; }
    if (!r.ok) throw new Error(r.statusText);
    return await r.json();
  } catch (e) {
    console.error('API error:', url, e);
    return null;
  }
}

export async function apiPost(url, body) {
  const token = getToken();
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token ? 'Bearer ' + token : '' },
    body: JSON.stringify(body),
  });
  if (r.status === 401) { logout(); return { ok: false, status: 401, data: {} }; }
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

export async function apiPut(url, body) {
  const token = getToken();
  const r = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: token ? 'Bearer ' + token : '' },
    body: JSON.stringify(body),
  });
  if (r.status === 401) { logout(); return { ok: false, status: 401, data: {} }; }
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

export async function apiPatch(url, body = {}) {
  const token = getToken();
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: token ? 'Bearer ' + token : '' },
    body: JSON.stringify(body),
  });
  if (r.status === 401) { logout(); return { ok: false, status: 401, data: {} }; }
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

export async function apiDelete(url) {
  const token = getToken();
  const r = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: token ? 'Bearer ' + token : '' },
  });
  if (r.status === 401) { logout(); return { ok: false, status: 401, data: {} }; }
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}
