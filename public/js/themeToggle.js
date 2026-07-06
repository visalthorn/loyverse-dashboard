// public/js/themeToggle.js
const THEME_KEY = 'pos_theme';

const ICONS = {
  light: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>`,
  dark: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12.3 2a9 9 0 1 0 9.7 13.3A9.4 9.4 0 0 1 12.3 2Z"/></svg>`,
};

export function getTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  return stored === 'light' ? 'light' : 'dark';
}

export function setTheme(theme) {
  localStorage.setItem(THEME_KEY, theme === 'light' ? 'light' : 'dark');
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

export function renderThemeToggle(mountEl) {
  if (!mountEl) return;
  const theme = getTheme();
  mountEl.innerHTML = `
    <div class="theme-switch" role="group" aria-label="Theme">
      <button type="button" class="theme-btn${theme === 'light' ? ' active' : ''}" data-theme-choice="light" title="Light" aria-label="Light theme">${ICONS.light}</button>
      <button type="button" class="theme-btn${theme === 'dark' ? ' active' : ''}" data-theme-choice="dark" title="Dark" aria-label="Dark theme">${ICONS.dark}</button>
    </div>`;
  mountEl.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const choice = btn.dataset.themeChoice;
      if (choice === getTheme()) return;
      setTheme(choice);
      location.reload();
    });
  });
}
