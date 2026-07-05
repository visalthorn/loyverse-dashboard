import { en } from './i18n/en.js';
import { km } from './i18n/km.js';

const LANG_KEY = 'pos_lang';
const dictionaries = { en, km };

export function getLang() {
  const stored = localStorage.getItem(LANG_KEY);
  return stored === 'km' ? 'km' : 'en';
}

export function setLang(lang) {
  localStorage.setItem(LANG_KEY, lang === 'km' ? 'km' : 'en');
}

export function t(key, vars = {}) {
  const lang = getLang();
  let str = dictionaries[lang]?.[key];
  if (str === undefined) {
    console.warn(`[i18n] missing key "${key}" for lang "${lang}"`);
    str = en[key] ?? key;
  }
  return str.replace(/\{(\w+)\}/g, (_, name) => (vars[name] !== undefined ? String(vars[name]) : `{${name}}`));
}

export function applyTranslations(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  root.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.dataset.i18nTitle);
  });
}

export function days() {
  return [0, 1, 2, 3, 4, 5, 6].map(i => t(`common.day.${i}`));
}

export function renderLangSwitcher(container) {
  if (!container) return;
  const lang = getLang();
  container.innerHTML = `
    <div class="lang-switch" role="group" aria-label="Language">
      <button type="button" class="lang-btn${lang === 'en' ? ' active' : ''}" data-lang="en">EN</button>
      <button type="button" class="lang-btn${lang === 'km' ? ' active' : ''}" data-lang="km">ខ្មែរ</button>
    </div>`;
  container.querySelectorAll('.lang-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.lang === getLang()) return;
      setLang(btn.dataset.lang);
      location.reload();
    });
  });
}
