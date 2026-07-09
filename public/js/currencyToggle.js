// public/js/currencyToggle.js
import { getCurrency } from './utils.js';

const CURRENCY_KEY = 'pos_currency';

export function setCurrency(currency) {
  localStorage.setItem(CURRENCY_KEY, currency === 'USD' ? 'USD' : 'KHR');
}

export function renderCurrencyToggle(mountEl) {
  if (!mountEl) return;
  const currency = getCurrency();
  mountEl.innerHTML = `
    <div class="theme-switch" role="group" aria-label="Currency">
      <button type="button" class="currency-btn theme-btn${currency === 'KHR' ? ' active' : ''}" data-currency-choice="KHR" title="Riel (KHR)" aria-label="Khmer Riel">៛</button>
      <button type="button" class="currency-btn theme-btn${currency === 'USD' ? ' active' : ''}" data-currency-choice="USD" title="US Dollar (4,000៛ = $1)" aria-label="US Dollar">$</button>
    </div>`;
  mountEl.querySelectorAll('.currency-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const choice = btn.dataset.currencyChoice;
      if (choice === getCurrency()) return;
      setCurrency(choice);
      location.reload();
    });
  });
}
