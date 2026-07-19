const axios = require('axios');

const client = axios.create({
  baseURL: 'https://api.loyverse.com/v1.0',
  timeout: 30000,
  headers: { Authorization: `Bearer ${process.env.LOYVERSE_TOKEN}` },
});

async function fetchReceipts(startDate, endDate) {
  const startUtc = startDate.utc().format('YYYY-MM-DDTHH:mm:ss[Z]');
  const endUtc   = endDate.utc().format('YYYY-MM-DDTHH:mm:ss[Z]');
  console.log(`Fetching receipts from Loyverse between ${startUtc} and ${endUtc} (UTC)`);

  let all    = [];
  let cursor = null;

  do {
    const res = await client.get('/receipts', {
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

module.exports = { fetchReceipts, fetchItems, fetchCategories, fetchPosDevices };
