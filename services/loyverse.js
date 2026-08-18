const axios = require('axios');

const client = axios.create({
  baseURL: 'https://api.loyverse.com/v1.0',
  timeout: 30000,
  headers: { Authorization: `Bearer ${process.env.LOYVERSE_TOKEN}` },
});

// Used by both the primary singleton client (fetchReceipts below) and the
// manual backup sync (services/sync/backupReceipts.js), which builds its own
// client from a different account's token via createClient().
async function fetchReceiptsWithClient(httpClient, startDate, endDate) {
  const startUtc = startDate.utc().format('YYYY-MM-DDTHH:mm:ss[Z]');
  const endUtc   = endDate.utc().format('YYYY-MM-DDTHH:mm:ss[Z]');
  console.log(`Fetching receipts from Loyverse between ${startUtc} and ${endUtc} (UTC)`);

  let all    = [];
  let cursor = null;

  do {
    const res = await httpClient.get('/receipts', {
      params: { created_at_min: startUtc, created_at_max: endUtc, limit: 250, cursor },
    });
    const receipts = res.data.receipts || [];
    all.push(...receipts);
    cursor = res.data.cursor;
    console.log(`📦 Batch fetched: ${receipts.length}`);
  } while (cursor);

  console.log(`📊 Total fetched: ${all.length}`);
  return all;
}

function fetchReceipts(startDate, endDate) {
  return fetchReceiptsWithClient(client, startDate, endDate);
}

// Builds a client for a different Loyverse account's token -- used only by
// the manual backup sync, never by the automatic cron path.
function createClient(token) {
  return axios.create({
    baseURL: 'https://api.loyverse.com/v1.0',
    timeout: 30000,
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function fetchAllPages(path, key) {
  let all    = [];
  let cursor = null;

  do {
    const res = await client.get(path, { params: { limit: 250, cursor } });
    all.push(...(res.data[key] || []));
    cursor = res.data.cursor;
  } while (cursor);

  console.log(`📊 Total ${key} fetched: ${all.length}`);
  return all;
}

function fetchItems()      { return fetchAllPages('/items', 'items'); }
function fetchCategories() { return fetchAllPages('/categories', 'categories'); }
function fetchPosDevices() { return fetchAllPages('/pos_devices', 'pos_devices'); }

module.exports = { fetchReceipts, fetchItems, fetchCategories, fetchPosDevices, fetchReceiptsWithClient, createClient };
