const TOKEN_KEY = 'pos_token';
const USER_KEY  = 'pos_user';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function getUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY)); }
  catch { return null; }
}

export function logout() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  window.location.href = '/login';
}

export async function checkAuth() {
  const token = getToken();
  if (!token) { window.location.href = '/login'; return null; }
  try {
    const res = await fetch('/api/auth/verify', { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) { logout(); return null; }
    return await res.json();
  } catch {
    logout();
    return null;
  }
}
