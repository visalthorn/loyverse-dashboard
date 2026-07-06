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

const FLAGS = {
  en: {
    label: 'English',
    svg: `<svg viewBox="0 0 60 30" xmlns="http://www.w3.org/2000/svg">
      <rect width="60" height="30" fill="#012169"/>
      <path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" stroke-width="6"/>
      <path d="M0,0 L60,30 M60,0 L0,30" stroke="#C8102E" stroke-width="2"/>
      <path d="M30,0 V30 M0,15 H60" stroke="#fff" stroke-width="10"/>
      <path d="M30,0 V30 M0,15 H60" stroke="#C8102E" stroke-width="6"/>
    </svg>`,
  },
  km: {
    label: 'ខ្មែរ',
    svg: `<svg viewBox="0 0 90 60" xmlns="http://www.w3.org/2000/svg">
      <rect width="90" height="15" fill="#032ea1"/>
      <rect y="15" width="90" height="30" fill="#e00025"/>
      <rect y="45" width="90" height="15" fill="#032ea1"/>
      <g fill="#fff">
        <rect x="33" y="32" width="24" height="6"/>
        <polygon points="45,14 41,26 49,26"/>
        <polygon points="37,20 34,26 40,26"/>
        <polygon points="53,20 50,26 56,26"/>
      </g>
    </svg>`,
  },
};

export function renderLangSwitcher(container) {
  if (!container) return;
  const lang = getLang();
  container.innerHTML = `
    <div class="lang-switch" role="group" aria-label="Language">
      <button type="button" class="lang-btn${lang === 'en' ? ' active' : ''}" data-lang="en" title="${FLAGS.en.label}" aria-label="${FLAGS.en.label}">${FLAGS.en.svg}</button>
      <button type="button" class="lang-btn${lang === 'km' ? ' active' : ''}" data-lang="km" title="${FLAGS.km.label}" aria-label="${FLAGS.km.label}">${FLAGS.km.svg}</button>
    </div>`;
  container.querySelectorAll('.lang-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.lang === getLang()) return;
      setLang(btn.dataset.lang);
      location.reload();
    });
  });
}
