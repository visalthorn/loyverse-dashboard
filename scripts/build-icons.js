// Generates public/js/icons.js — a self-contained ES module holding only the
// Lucide icons this app actually uses, so the browser never fetches an icon
// library at runtime (the POS and KDS tablets must render offline).
//
// Run after adding a new icon name to ICONS below:
//     npm run build:icons
//
// Geometry comes from the `lucide` npm package (ISC licence), a devDependency
// used at build time only — nothing from node_modules ships to the browser.

const fs = require('fs');
const path = require('path');

const LUCIDE_ICON_DIR = path.join(__dirname, '..', 'node_modules', 'lucide', 'dist', 'esm', 'icons');
const OUT_FILE = path.join(__dirname, '..', 'public', 'js', 'icons.js');

// Every icon the UI references, grouped by where it shows up. The comment on
// each line is the emoji it replaced, so the mapping stays reviewable.
const ICONS = [
  // ── Sidebar navigation ────────────────────────────────────────────────────
  'chart-column',      // 📊 dashboard
  'banknote',          // 💸 expenses
  'clipboard-list',    // 📋 reports
  'files',             // 📑 summary report
  'receipt',           // 🧾 receipts / orders
  'users',             // 👥 staff
  'tag',               // 🏷️ items
  'boxes',             // 🧂 inventory
  'store',             // 🏬 branches
  'settings',          // ⚙️ users / settings
  'refresh-cw',        // 🔄 sync

  // ── Section titles & cards ────────────────────────────────────────────────
  'chart-line',        // 📈 trend / gross income
  'chart-pie',         // 🥧 top product performance
  'trending-up',       // 📈 growth
  'trending-down',     // 📉 decline
  'utensils',          // 🍽️ dining options
  'credit-card',       // 💳 payment methods
  'shopping-cart',     // 🛒 top products / items sold
  'leafy-green',       // 🥬 stock watch
  'user',              // 👤 employee performance
  'monitor',           // 🖥️ device performance
  'siren',             // 🚨 cancelled orders
  'shield',            // 🔐 role permissions
  'coins',             // 💰 money
  'dollar-sign',       // 💵 cash
  'calendar',          // 📅 schedule
  'archive',           // 🗄️ archive
  'dna',               // 🧬 ingredient components
  'package',           // 📦 stock / restock
  'scroll',            // 📜 history / log
  'bot',               // 🤖 AI analysis
  'scan-barcode',      // 🖲️ POS device
  'map-pin',           // 📍 branch location
  'link',              // 🔗 linked items
  'chef-hat',          // 🍳 kitchen / KDS brand

  // ── Actions & controls ────────────────────────────────────────────────────
  'menu',              // ☰ open sidebar
  'x',                 // ✕ ❌ close / remove
  'check',             // ✓ done
  'circle-check',      // ✅ success / ready
  'triangle-alert',    // ⚠ ⚠️ warning
  'ban',               // 🚫 cancelled / blocked
  'printer',           // 🖨 print
  'lock',              // 🔒 locked
  'pencil',            // ✏️ edit
  'trash-2',           // 🗑️ delete
  'eye',               // 👁 show
  'eye-off',           // 🙈 hide
  'search',            // 🔍 search
  'save',              // 💾 save
  'download',          // ⬇ export / download
  'upload',            // 📤 upload
  'play',              // ▶ start / expand
  'undo-2',            // ↩ undo / refund
  'rotate-ccw',        // ↻ reset
  'shuffle',           // 🔀 shuffle / reassign
  'scissors',          // ✂️ split
  'copy',              // 📋 copy to clipboard
  'arrow-right',       // → link affordance
  'move-horizontal',   // ⇔ collapse/expand sidebar
  'log-out',           //   logout (was a bare glyph)

  // ── Status ────────────────────────────────────────────────────────────────
  'clock',             // 🕐 🕘 time / pending
  'timer',             // ⏱ ⏱️ elapsed
  'circle-dot',        // 🔴 🟢 live status dot
  'party-popper',      // 🎉 empty-board celebration
  'wifi-off',          // ⚠ offline
  'info',              // ⓘ inline hint
  'chevron-down',      // ▾ menu caret
  'power',             // ⏻ sign out
  'alarm-clock',       // ⏰ auto-sync scheduler
  'delete',            // ⌫ PIN keypad backspace
  'activity',          // 📋 recent activity feed
  'arrow-up',          // ▲ growth up
  'arrow-down',        // ▼ growth down
  'chevron-left',      // ◀ previous month
  'chevron-right',     // ▶ expand / next
  'pause',             // ⏸ deactivate
  'skip-forward',      // ⏭ sync skipped
  'circle-x',          // ❌ sync failed

  // ── POS item-grid density modes ───────────────────────────────────────────
  'layout-grid',       // photo tiles
  'grid-3x3',          // compact tiles
  'list',              // ledger rows
  'chevron-up',        // open the cart sheet
];

function serializeNode([tag, attrs]) {
  const parts = Object.entries(attrs)
    .map(([key, value]) => `${key}="${String(value).replace(/"/g, '&quot;')}"`)
    .join(' ');
  return `<${tag} ${parts}/>`;
}

(async () => {
  const missing = ICONS.filter(name => !fs.existsSync(path.join(LUCIDE_ICON_DIR, `${name}.mjs`)));
  if (missing.length) {
    console.error(`✖ Unknown lucide icon(s): ${missing.join(', ')}`);
    process.exit(1);
  }

  const duplicates = ICONS.filter((n, i) => ICONS.indexOf(n) !== i);
  if (duplicates.length) {
    console.error(`✖ Duplicate icon name(s) in ICONS: ${[...new Set(duplicates)].join(', ')}`);
    process.exit(1);
  }

  const entries = [];
  for (const name of [...ICONS].sort()) {
    const mod = await import(new URL(`file://${path.join(LUCIDE_ICON_DIR, `${name}.mjs`).replace(/\\/g, '/')}`));
    const nodes = mod.default;
    if (!Array.isArray(nodes)) {
      console.error(`✖ ${name}.mjs did not export an icon node array`);
      process.exit(1);
    }
    entries.push(`  '${name}': '${nodes.map(serializeNode).join('')}',`);
  }

  const { version } = require(path.join(__dirname, '..', 'node_modules', 'lucide', 'package.json'));

  const out = `// AUTO-GENERATED — do not edit by hand.
// Regenerate with: npm run build:icons   (source: scripts/build-icons.js)
//
// Icon geometry from Lucide v${version}, ISC licence — https://lucide.dev
// Only the ${ICONS.length} icons this app uses are inlined, so no icon library is
// fetched at runtime and the POS/KDS screens keep their icons while offline.

const PATHS = {
${entries.join('\n')}
};

// Lucide's standard presentation: 24x24 grid, stroked, inheriting text colour.
// stroke-width is deliberately NOT set here -- style.css drives it from
// --icon-stroke so an icon's weight can track the weight of the text beside it
// (a semibold section title needs a heavier stroke than muted body copy).
// Likewise the width/height below are defaults that CSS overrides in em.
const SVG_ATTRS =
  'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"';

// Returns an inline <svg> string, for building markup in template literals.
// Decorative by default (aria-hidden); pass a label when the icon is the only
// thing conveying meaning, e.g. an icon-only button.
export function icon(name, { size = 18, cls = '', label = '' } = {}) {
  const d = PATHS[name];
  if (!d) {
    console.warn(\`[icons] unknown icon "\${name}"\`);
    return '';
  }
  const a11y = label ? \`role="img" aria-label="\${label}"\` : 'aria-hidden="true"';
  const klass = \`lucide\${cls ? ' ' + cls : ''}\`;
  return \`<svg class="\${klass}" width="\${size}" height="\${size}" \${SVG_ATTRS} \${a11y}>\${d}</svg>\`;
}

export function hasIcon(name) {
  return Object.prototype.hasOwnProperty.call(PATHS, name);
}

// Fills every <span data-icon="name"> in \`root\`. Static markup declares icons
// this way so HTML stays readable; call after injecting new markup.
// data-icon-size and data-icon-label mirror the icon() options.
export function renderIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => {
    const name = el.dataset.icon;
    const size = Number(el.dataset.iconSize) || 18;
    const label = el.dataset.iconLabel || '';
    const svg = icon(name, { size, label });
    if (svg && el.innerHTML !== svg) el.innerHTML = svg;
  });
}

export const ICON_NAMES = Object.keys(PATHS);
`;

  fs.writeFileSync(OUT_FILE, out, 'utf8');
  console.log(`✅ Wrote ${path.relative(path.join(__dirname, '..'), OUT_FILE)} — ${ICONS.length} icons from lucide v${version}`);
})();
