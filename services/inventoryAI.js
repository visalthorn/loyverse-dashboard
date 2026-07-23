const crypto = require('crypto');
const pool   = require('../db');
const { anthropicApiKey } = require('../config');
const { analyzeIngredient } = require('./inventoryAnalysis');

// AI interpretation layer over the deterministic inventory stats.
// Credit-saving architecture:
//   1. All math happens locally (inventoryAnalysis); the API only receives the
//      compact computed stats and returns interpretation.
//   2. A per-ingredient fingerprint (input_hash) skips the API for ingredients
//      whose data hasn't changed — cached results are served from inv_ai_analyses.
//   3. All changed ingredients go in ONE batched request; nothing changed = no call.
//   4. claude-sonnet-5, max_tokens scaled to batch size, temperature 0.

const MODEL          = 'claude-sonnet-5';
// Output budget must scale with the batch: each ingredient entry carries an
// English + Khmer summary (Khmer script is token-heavy), anomalies, and refill
// advice — a fixed cap truncated the JSON mid-object once ~4+ ingredients
// changed at once, failing the whole batch while still billing the tokens.
const MAX_TOKENS_BASE    = 300;   // JSON envelope + slack
const MAX_TOKENS_PER_ING = 550;   // bilingual entry allowance
const MAX_TOKENS_CEILING = 16000; // 25-item cap fits well within the model's output limit
const API_URL        = 'https://api.anthropic.com/v1/messages';
const COOLDOWN_MS    = 2 * 60 * 1000;  // API-calling runs: max 1 per 2 minutes
const MAX_PER_RUN    = 25;             // hard cap; overflow processed next run
const HEALTH_VALUES  = ['good', 'watch', 'urgent'];

const SYSTEM_PROMPT = `You are an inventory analyst for a Cambodian BBQ & Oyster restaurant.
Ingredients are free add-ons and consumables (garlic, butter, chili, charcoal)
restocked periodically; consumption is estimated from restock history vs item
sales. You receive pre-computed stats per ingredient. A stats entry may
include branch_id/branch_name fields identifying which branch's restock
history the stats came from — you may reference the branch by name in
summary text if useful. Respond ONLY with valid JSON, no markdown, matching:
{ "ingredients": [ { "id": number,
    "health": "good"|"watch"|"urgent",
    "summary_en": string (max 2 sentences),
    "summary_kh": string (same content in Khmer),
    "anomalies": [string] (empty if none — e.g. consumption jumped 40% vs
                   prior periods without matching sales growth),
    "refill_advice": string (when to restock and roughly how much, based on
                   rates and days_until_empty),
    "data_quality_note": string|null (e.g. negative period detected,
                   low confidence, suggest more frequent counts) } ] }`;

const RETRY_INSTRUCTION =
  '\n\nIMPORTANT: Your previous response was not valid JSON. Respond with ONLY the raw JSON object described in the system prompt — no markdown fences, no commentary, no text outside the JSON.';

class AiAnalysisError extends Error {
  constructor(message, status = 500) { super(message); this.status = status; }
}

// ── Pure helpers (unit-tested directly) ─────────────────────────────────────

// Field order is fixed so JSON.stringify is deterministic across runs.
function computeInputHash({ last_restock_id, restock_count, links, sales_qty_since_last_restock, alert_threshold, branch_id }) {
  const canonical = {
    last_restock_id:              last_restock_id ?? null,
    restock_count:                restock_count || 0,
    links:                        [...(links || [])].sort(),
    sales_qty_since_last_restock: Math.round(sales_qty_since_last_restock || 0),
    alert_threshold:              parseFloat(alert_threshold) || 0,
    branch_id:                    branch_id ?? null,
  };
  return crypto.createHash('md5').update(JSON.stringify(canonical)).digest('hex');
}

// The compact per-ingredient payload sent to the model — stats only, never raw rows.
function compactStats(a) {
  return {
    id: a.id, name: a.name, unit: a.unit,
    alert_threshold: a.alert_threshold,
    last_restock_date: a.last_restock_date,
    last_total: a.last_total,
    estimated_remaining: a.estimated_remaining,
    rate_per_item: a.rate_per_item,
    rate_per_day: a.rate_per_day,
    days_until_empty: a.days_until_empty,
    confidence: a.confidence,
    status: a.status,
    periods: a.periods,
    bad_periods: a.bad_periods,
    ...(a.branch_id ? { branch_id: a.branch_id, branch_name: a.branch_name } : {}),
  };
}

// Most urgent first (lowest days_until_empty; unknowns last), capped at `cap`.
function selectMostUrgent(items, cap = MAX_PER_RUN) {
  const sorted = [...items].sort((x, y) => {
    const a = x.stats.days_until_empty, b = y.stats.days_until_empty;
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    return a - b;
  });
  return { selected: sorted.slice(0, cap), skipped: sorted.slice(cap) };
}

function buildRequestBody(statsList, retry = false) {
  return {
    model: MODEL,
    max_tokens: Math.min(MAX_TOKENS_CEILING, MAX_TOKENS_BASE + statsList.length * MAX_TOKENS_PER_ING),
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: JSON.stringify(statsList) + (retry ? RETRY_INSTRUCTION : ''),
    }],
  };
}

// Strip accidental ```json fences, then parse strictly.
// Returns Map<id, entry> or null when the text is unusable.
function parseAiText(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); } catch { return null; }
  if (!parsed || !Array.isArray(parsed.ingredients)) return null;

  const byId = new Map();
  for (const entry of parsed.ingredients) {
    if (!entry || typeof entry.id !== 'number' || typeof entry.summary_en !== 'string') continue;
    byId.set(entry.id, {
      id: entry.id,
      health: HEALTH_VALUES.includes(entry.health) ? entry.health : 'watch',
      summary_en: entry.summary_en,
      summary_kh: typeof entry.summary_kh === 'string' ? entry.summary_kh : '',
      anomalies: Array.isArray(entry.anomalies) ? entry.anomalies.filter(a => typeof a === 'string') : [],
      refill_advice: typeof entry.refill_advice === 'string' ? entry.refill_advice : '',
      data_quality_note: typeof entry.data_quality_note === 'string' ? entry.data_quality_note : null,
    });
  }
  return byId.size ? byId : null;
}

// ── Anthropic API (direct HTTPS, no SDK) ────────────────────────────────────

async function callAnthropic(body) {
  if (!anthropicApiKey) throw new AiAnalysisError('AI analysis is not configured (missing ANTHROPIC_API_KEY).', 503);
  const controller = new AbortController();
  // Generous: a full 25-ingredient batch can stream ~14k output tokens.
  const timer = setTimeout(() => controller.abort(), 180_000);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': anthropicApiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error?.message || `Anthropic API error (HTTP ${res.status})`;
      throw new AiAnalysisError(msg, res.status === 429 ? 503 : 502);
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new AiAnalysisError('Anthropic API request timed out.', 504);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Fingerprinting (DB) ─────────────────────────────────────────────────────

async function fingerprintIngredient(ing, branchId = null) {
  const params = branchId ? [ing.id, branchId] : [ing.id];
  const agg = await pool.query(`
    SELECT COUNT(*)::int AS restock_count,
           (ARRAY_AGG(id ORDER BY restock_date DESC, created_at DESC))[1] AS last_restock_id,
           to_char((ARRAY_AGG(restock_date ORDER BY restock_date DESC, created_at DESC))[1], 'YYYY-MM-DD') AS last_restock_date
    FROM inv_restocks WHERE ingredient_id = $1${branchId ? ' AND branch_id = $2' : ''}
  `, params);
  const { restock_count, last_restock_id, last_restock_date } = agg.rows[0];

  const linksRes = await pool.query(
    'SELECT sku FROM inv_item_links WHERE ingredient_id = $1 ORDER BY sku', [ing.id]);
  const skus = linksRes.rows.map(r => r.sku);

  let sales = 0;
  if (skus.length && last_restock_date) {
    const salesRes = await pool.query(`
      SELECT COALESCE(SUM(ri.quantity), 0)::float AS qty
      FROM receipt_items ri
      JOIN receipts r ON r.receipt_number = ri.receipt_number
      WHERE ri.sku = ANY($1)
        AND r.receipt_type = 'SALE' AND r.cancelled_at IS NULL
        AND DATE(r.receipt_date) >= $2
    `, [skus, last_restock_date]);
    sales = salesRes.rows[0].qty;
  }

  return {
    last_restock_id,
    restock_count,
    links: skus,
    sales_qty_since_last_restock: Math.round(sales),
    alert_threshold: parseFloat(ing.alert_threshold),
    branch_id: branchId ?? null,
  };
}

// branch_id is a cache-scope filter (which scope was this cached analysis run
// under?), not a data-scope filter — it must always apply, including when
// branchId is null, so IS NOT DISTINCT FROM (not =) is required to correctly
// match cache rows whose branch_id is NULL.
async function latestStoredByIngredient(branchId = null) {
  const res = await pool.query(`
    SELECT DISTINCT ON (ingredient_id)
           ingredient_id, input_hash, result, created_at
    FROM inv_ai_analyses
    WHERE branch_id IS NOT DISTINCT FROM $1
    ORDER BY ingredient_id, created_at DESC
  `, [branchId]);
  return new Map(res.rows.map(r => [r.ingredient_id, r]));
}

async function activeIngredients() {
  const res = await pool.query(`
    SELECT id, name, name_kh, unit, alert_threshold
    FROM inv_ingredients WHERE is_active = true ORDER BY name
  `);
  return res.rows;
}

// Resolve once per run/request and reuse — avoids re-querying per ingredient.
async function resolveBranchName(branchId) {
  if (!branchId) return null;
  const res = await pool.query('SELECT name FROM branches WHERE id = $1', [branchId]);
  return res.rows[0]?.name ?? null;
}

// ── Rate limit (in-memory; only API-calling runs consume the budget) ────────

let lastApiRunAt = 0;
function _resetRateLimit() { lastApiRunAt = 0; }

// ── Orchestration ───────────────────────────────────────────────────────────

// options.apiCall and options.listIngredients are injectable for tests so no
// real API request is ever made and parallel test files can't interfere.
async function runAiAnalysis({ username = null, apiCall = callAnthropic, now = Date.now,
                               listIngredients = activeIngredients, branchId = null } = {}) {
  const startedAt = now();
  const ingredients = await listIngredients();
  const stored = await latestStoredByIngredient(branchId);
  const branchName = await resolveBranchName(branchId);

  const changed = [], cached = [];
  for (const ing of ingredients) {
    const fp = await fingerprintIngredient(ing, branchId);
    const hash = computeInputHash(fp);
    const prev = stored.get(ing.id);
    if (prev && prev.input_hash === hash) {
      // Cache hit already guarantees prev.branch_id matches branchId (per
      // latestStoredByIngredient's IS NOT DISTINCT FROM filter above) — no
      // need to re-derive it from prev.
      cached.push({ ...prev.result, id: ing.id, name: ing.name, name_kh: ing.name_kh, unit: ing.unit,
                    cached: true, analyzed_at: prev.created_at,
                    ...(branchId ? { branch_id: branchId, branch_name: branchName } : {}) });
    } else {
      const stats = compactStats(await analyzeIngredient(ing, branchId));
      changed.push({ ing, hash, stats });
    }
  }

  if (!changed.length) {
    console.log(`🤖 [ai-analyze] Nothing changed — 0 API calls, ${cached.length} cached (${now() - startedAt}ms)`);
    return { changed: 0, results: [], cached, skipped: [], usage: null };
  }

  // Guardrail: at most one API-calling run per 2 minutes.
  if (startedAt - lastApiRunAt < COOLDOWN_MS) {
    const waitS = Math.ceil((COOLDOWN_MS - (startedAt - lastApiRunAt)) / 1000);
    throw new AiAnalysisError(`AI analysis was run recently — try again in ${waitS}s.`, 429);
  }

  const { selected, skipped } = selectMostUrgent(changed);

  // ONE batched request for every changed ingredient; retry once on bad JSON.
  const statsList = selected.map(c => c.stats);
  let usage = { input_tokens: 0, output_tokens: 0 };
  const addUsage = r => {
    usage.input_tokens  += r?.usage?.input_tokens  || 0;
    usage.output_tokens += r?.usage?.output_tokens || 0;
  };

  // Truncation (stop_reason max_tokens) also lands here as a parse failure —
  // log it distinctly, since the JSON-only retry can't fix a too-small budget.
  const warnIfTruncated = r => {
    if (r?.stop_reason === 'max_tokens') {
      console.warn(`🤖 [ai-analyze] response truncated at max_tokens=${buildRequestBody(statsList).max_tokens} for ${statsList.length} ingredients`);
    }
  };

  let response = await apiCall(buildRequestBody(statsList));
  addUsage(response);
  warnIfTruncated(response);
  let byId = parseAiText(response?.content?.find(b => b.type === 'text')?.text);
  if (!byId) {
    response = await apiCall(buildRequestBody(statsList, true));
    addUsage(response);
    warnIfTruncated(response);
    byId = parseAiText(response?.content?.find(b => b.type === 'text')?.text);
  }
  lastApiRunAt = now();

  const results = [], failed = [];
  for (const { ing, hash, stats } of selected) {
    const entry = byId?.get(ing.id);
    if (!entry) {
      // Not stored — stays "changed" so the next run retries it.
      failed.push({ id: ing.id, name: ing.name });
      continue;
    }
    const ins = await pool.query(`
      INSERT INTO inv_ai_analyses (ingredient_id, input_hash, stats, result, model, input_tokens, output_tokens, created_by, branch_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING created_at
    `, [ing.id, hash, JSON.stringify(stats), JSON.stringify(entry), response?.model || MODEL,
        usage.input_tokens, usage.output_tokens, username, branchId]);
    results.push({ ...entry, name: ing.name, name_kh: ing.name_kh, unit: ing.unit,
                   cached: false, analyzed_at: ins.rows[0].created_at,
                   ...(branchId ? { branch_id: branchId, branch_name: branchName } : {}) });
  }

  console.log(`🤖 [ai-analyze] changed=${selected.length} cached=${cached.length} skipped=${skipped.length} failed=${failed.length} tokens=${usage.input_tokens}in/${usage.output_tokens}out (${now() - startedAt}ms)`);

  return {
    changed: results.length,
    results,
    cached,
    skipped: skipped.map(c => ({ id: c.ing.id, name: c.ing.name })),
    failed,
    usage,
  };
}

// Latest stored analysis per active ingredient + stale flag for the page load.
async function getLatestAnalyses(branchId = null) {
  const ingredients = await activeIngredients();
  const stored = await latestStoredByIngredient(branchId);
  const branchName = await resolveBranchName(branchId);

  let lastAnalyzedAt = null;
  let changedCount = 0;
  const rows = [];
  for (const ing of ingredients) {
    const prev = stored.get(ing.id);
    const hash = computeInputHash(await fingerprintIngredient(ing, branchId));
    const stale = !prev || prev.input_hash !== hash;
    if (stale) changedCount++;
    if (prev && (!lastAnalyzedAt || prev.created_at > lastAnalyzedAt)) lastAnalyzedAt = prev.created_at;
    rows.push({
      id: ing.id, name: ing.name, name_kh: ing.name_kh, unit: ing.unit,
      analysis: prev ? prev.result : null,
      analyzed_at: prev ? prev.created_at : null,
      stale,
      ...(branchId ? { branch_id: branchId, branch_name: branchName } : {}),
    });
  }
  return { last_analyzed_at: lastAnalyzedAt, changed_count: changedCount, ingredients: rows };
}

module.exports = {
  computeInputHash, compactStats, selectMostUrgent, buildRequestBody, parseAiText,
  callAnthropic, runAiAnalysis, getLatestAnalyses,
  AiAnalysisError, _resetRateLimit,
  SYSTEM_PROMPT, MODEL,
};
