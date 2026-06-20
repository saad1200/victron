/**
 * Flux Rate Sync
 *
 * Fetches current Octopus Flux tariff rates from the API and updates
 * the victron_tariff_periods table in the database.
 *
 * Runs once immediately on start, then daily at 00:30 UK time.
 * Assumes we are always on Octopus Flux.
 *
 * Usage:
 *   node src/victron.flux.sync.js          # run once and keep alive (cron)
 *   node src/victron.flux.sync.js --once   # run once and exit
 */

const cron = require('node-cron');
const { Client } = require('pg');
const OctopusAPI = require('./octopus-api');
require('dotenv').config();

const DB_CONFIG = {
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'victron',
  password: process.env.DB_PASSWORD || 'password',
  port: process.env.DB_PORT || 5433,
};

// Flux period definitions (UK local time)
const FLUX_PERIODS = [
  { name: 'Night',   startTime: '02:00', endTime: '05:00', sampleHourUK: 3  },
  { name: 'Day',     startTime: '05:00', endTime: '16:00', sampleHourUK: 10 },
  { name: 'PEAK',    startTime: '16:00', endTime: '19:00', sampleHourUK: 17 },
  { name: 'Evening', startTime: '19:00', endTime: '02:00', sampleHourUK: 21 },
];

function timestamp() {
  return new Date().toLocaleString('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function log(msg, level = 'INFO') {
  console.log(`[${timestamp()}] [FLUX-SYNC] [${level}] ${msg}`);
}

/**
 * Get the current UTC offset for Europe/London (0 for GMT, 1 for BST).
 */
function getUKOffsetHours() {
  const now = new Date();
  const londonStr = now.toLocaleString('en-US', { timeZone: 'Europe/London' });
  const utcStr = now.toLocaleString('en-US', { timeZone: 'UTC' });
  return Math.round((new Date(londonStr) - new Date(utcStr)) / (3600 * 1000));
}

/**
 * Main sync: fetch Flux rates from API and update the database.
 */
async function syncFluxRates() {
  log('Starting Flux rate sync...');
  const api = new OctopusAPI();
  const db = new Client(DB_CONFIG);

  try {
    await db.connect();

    // ── 1. Detect current tariffs from account ──
    const tariffs = await api.getCurrentTariffs();
    if (!tariffs.importTariff) {
      throw new Error('Could not detect import tariff from Octopus account');
    }
    const detectedProduct = api.extractProductName(tariffs.importTariff);
    log(`Import tariff: ${tariffs.importTariff} (${detectedProduct})`);
    log(`Export tariff: ${tariffs.exportTariff || 'none'}`);

    // ── 2. Ensure product row exists ──
    const productId = await ensureProduct(db, 'Octopus Flux');

    // ── 3. Fetch today's rates ──
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(startOfDay);
    endOfDay.setDate(endOfDay.getDate() + 1);

    const importRates = api.createRateLookup(
      await api.getTariffRates(tariffs.importTariff, startOfDay.toISOString(), endOfDay.toISOString())
    );
    log(`Fetched ${importRates.length} import rate slots`);

    let exportRates = [];
    if (tariffs.exportTariff) {
      exportRates = api.createRateLookup(
        await api.getTariffRates(tariffs.exportTariff, startOfDay.toISOString(), endOfDay.toISOString())
      );
      log(`Fetched ${exportRates.length} export rate slots`);
    }

    // ── 4. For each Flux period, find the rate at a representative time ──
    const ukOffset = getUKOffsetHours();
    let updatedCount = 0;

    for (const period of FLUX_PERIODS) {
      // Create a sample UTC time for the middle of this UK period
      const sampleUTC = new Date(now);
      sampleUTC.setUTCHours(period.sampleHourUK - ukOffset, 30, 0, 0);

      const importMatch = importRates.find(r => sampleUTC >= r.valid_from && sampleUTC < r.valid_to);
      const exportMatch = exportRates.find(r => sampleUTC >= r.valid_from && sampleUTC < r.valid_to);

      const importRate = importMatch ? importMatch.value_inc_vat : 0;
      const exportRate = exportMatch ? exportMatch.value_inc_vat : 0;

      log(`  ${period.name} (${period.startTime}–${period.endTime}): import=${importRate.toFixed(2)}p, export=${exportRate.toFixed(2)}p`);

      // ── 5. Upsert into victron_tariff_periods ──
      const updated = await upsertTariffPeriod(db, productId, period, importRate, exportRate);
      if (updated) updatedCount++;
    }

    log(`Sync complete: ${updatedCount}/${FLUX_PERIODS.length} periods updated`);

    // ── 6. Log the sync event ──
    try {
      await db.query(`
        INSERT INTO victron_tariff_events (device_id, event_type, reason)
        VALUES ($1, 'flux_rate_sync', $2)
      `, [
        process.env.DEVICE_ID || 'unknown',
        `Synced ${updatedCount} Flux periods from API (${detectedProduct})`,
      ]);
    } catch (e) {
      // Non-critical
    }

  } catch (error) {
    log(`Sync failed: ${error.message}`, 'ERROR');
  } finally {
    try { await db.end(); } catch (e) { /* ignore */ }
  }
}

/**
 * Ensure the product exists in the products table and return its id.
 */
async function ensureProduct(db, name) {
  // Try to find existing
  const existing = await db.query('SELECT id FROM products WHERE name = $1', [name]);
  if (existing.rows.length > 0) return existing.rows[0].id;

  // Insert new
  const result = await db.query(
    'INSERT INTO products (name, active) VALUES ($1, true) ON CONFLICT (name) DO UPDATE SET updated_at = NOW() RETURNING id',
    [name]
  );
  log(`Created product: ${name} (id=${result.rows[0].id})`);
  return result.rows[0].id;
}

/**
 * Update or insert a tariff period row.
 * Returns true if the rate actually changed.
 */
async function upsertTariffPeriod(db, productId, period, importRate, exportRate) {
  // Try UPDATE first
  const update = await db.query(`
    UPDATE victron_tariff_periods
    SET import_rate_pence = $1, export_rate_pence = $2,
        start_time = $3, end_time = $4, updated_at = NOW()
    WHERE period_name = $5 AND product_id = $6 AND is_active = true
    RETURNING id, import_rate_pence AS old_import, export_rate_pence AS old_export
  `, [importRate, exportRate, period.startTime, period.endTime, period.name, productId]);

  if (update.rowCount > 0) {
    const row = update.rows[0];
    const changed = parseFloat(row.old_import) !== importRate || parseFloat(row.old_export) !== exportRate;
    if (changed) log(`    ↳ ${period.name} rate changed`);
    return changed;
  }

  // No existing row — INSERT
  await db.query(`
    INSERT INTO victron_tariff_periods
      (period_name, import_rate_pence, export_rate_pence, start_time, end_time, is_active, product_id)
    VALUES ($1, $2, $3, $4, $5, true, $6)
  `, [period.name, importRate, exportRate, period.startTime, period.endTime, productId]);

  log(`    ↳ ${period.name} inserted (new)`);
  return true;
}

// ─────────────────────────── Main ────────────────────────────────────

const runOnce = process.argv.includes('--once');

syncFluxRates().then(() => {
  if (runOnce) {
    log('Single run complete, exiting');
    process.exit(0);
  }

  // Schedule daily at 00:30 UK time
  log('Scheduling daily sync at 00:30 Europe/London');
  cron.schedule('30 0 * * *', () => {
    syncFluxRates().catch(err => log(`Scheduled sync error: ${err.message}`, 'ERROR'));
  }, { timezone: 'Europe/London' });

}).catch(err => {
  log(`Fatal: ${err.message}`, 'ERROR');
  process.exit(1);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
