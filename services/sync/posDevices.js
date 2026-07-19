const dayjs  = require('dayjs');
const utc    = require('dayjs/plugin/utc');
const tzPlug = require('dayjs/plugin/timezone');
const pool   = require('../../db');
const { fetchPosDevices } = require('../loyverse');
const { writeSyncLog } = require('./log');
const { tz } = require('../../config');

dayjs.extend(utc);
dayjs.extend(tzPlug);

// Applies fetched devices to the DB. Writes ONLY Loyverse-owned columns —
// branch_id is dashboard-owned and never touched, so assignments survive re-syncs.
async function upsertPosDevices(devices, triggeredBy = 'manual') {
  const syncDate = dayjs().tz(tz).format('YYYY-MM-DD');

  if (!devices.length) {
    console.log('⚠️  [pos-devices-sync] Empty device list from Loyverse — skipping');
    await writeSyncLog({ syncType: 'pos_devices', syncDate, status: 'skipped', triggeredBy, inserted: 0 });
    return { status: 'skipped', inserted: 0 };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let inserted = 0;
    for (const d of devices) {
      const res = await client.query(`
        INSERT INTO pos_devices (id, name, store_id, activated, deleted_at, synced_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (id) DO UPDATE
          SET name = $2, store_id = $3, activated = $4, deleted_at = $5, synced_at = NOW()
      `, [d.id, d.name, d.store_id || null, d.activated ?? true, d.deleted_at || null]);
      inserted += res.rowCount;
    }
    await client.query(`
      UPDATE pos_devices SET deleted_at = NOW()
      WHERE deleted_at IS NULL AND NOT (id = ANY($1::uuid[]))
    `, [devices.map(d => d.id)]);

    await client.query('COMMIT');
    console.log(`✅ [pos-devices-sync] Complete — ${inserted} devices upserted`);
    await writeSyncLog({ syncType: 'pos_devices', syncDate, status: 'success', triggeredBy, inserted });
    return { status: 'success', inserted };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ [pos-devices-sync] DB apply failed:', err.message);
    await writeSyncLog({ syncType: 'pos_devices', syncDate, status: 'failed', triggeredBy, inserted: 0, error: err.message });
    return { status: 'failed', inserted: 0, error: err.message };
  } finally {
    client.release();
  }
}

async function syncPosDevices(triggeredBy = 'manual') {
  const syncDate = dayjs().tz(tz).format('YYYY-MM-DD');
  let devices;
  try {
    devices = await fetchPosDevices();
  } catch (err) {
    console.error('❌ [pos-devices-sync] Loyverse fetch failed:', err.message);
    await writeSyncLog({ syncType: 'pos_devices', syncDate, status: 'failed', triggeredBy, inserted: 0, error: err.message });
    return { status: 'failed', inserted: 0, error: err.message };
  }
  return upsertPosDevices(devices, triggeredBy);
}

module.exports = { syncPosDevices, upsertPosDevices };
