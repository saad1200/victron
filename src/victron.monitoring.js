/**
 * Victron Energy Monitoring and Calculations
 * Handles energy calculations, tariff tracking, and monitoring logic
 * Runs at reasonable intervals to process raw data collected by victron.collection.js
 */

const { Client } = require('pg');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

// Database configuration
const DB_CONFIG = {
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
};

const LOG_FILE = path.join(__dirname, "../logs/victron-monitoring.log");
const dbClient = new Client(DB_CONFIG);

// Monitoring state
let currentTariffPeriod = null;
let lastEnergyReading = { timestamp: Date.now() - (6 * 60 * 1000) }; // Start 6 minutes ago to allow first calculation

// ---------------- Logging ----------------
async function log(message, level = "INFO") {
  const timestamp = new Date().toLocaleString('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit', 
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
  });
  const entry = `[${timestamp}] [${level}] ${message}\n`;
  console.log(entry.trim());
  
  try {
    await fs.appendFile(LOG_FILE, entry);
  } catch (err) {
    // Silently ignore log file errors
  }
}

// ---------------- Database Connection ----------------
async function connectDatabase() {
  try {
    await dbClient.connect();
    log("Connected to PostgreSQL database for monitoring");
  } catch (err) {
    log(`Failed to connect to database: ${err.message}`, "ERROR");
    process.exit(1);
  }
}

// ---------------- Energy Calculations ----------------
async function calculateEnergyMetrics() {
  try {
    log('Calculating energy metrics from raw data');
    
    if (!currentTariffPeriod) {
      log('Skipping energy calculation - no tariff period loaded', 'WARN');
      return;
    }
    
    const now = Date.now();
    const timeDiffHours = (now - lastEnergyReading.timestamp) / (1000 * 60 * 60);
    
    log(`Time since last energy reading: ${timeDiffHours.toFixed(4)} hours`);
    
    if (timeDiffHours < 0.08) {
      log(`Skipping energy calculation - too soon (${timeDiffHours.toFixed(4)}h < 0.08h)`, 'DEBUG');
      return; // Skip if less than 5 minutes
    }
    
    // Get tariff configuration
    const tariffQuery = `
      SELECT 
        import_rate_pence,
        export_rate_pence
      FROM victron_tariff_periods 
      WHERE period_name = $1 AND is_active = true
      LIMIT 1
    `;
    
    const tariffResult = await dbClient.query(tariffQuery, [currentTariffPeriod]);
    
    if (tariffResult.rows.length === 0) {
      log(`No tariff config found for period ${currentTariffPeriod}`, "WARN");
      return;
    }
    
    const tariffConfig = {
      importRate: parseFloat(tariffResult.rows[0].import_rate_pence),
      exportRate: parseFloat(tariffResult.rows[0].export_rate_pence)
    };
    
    // Calculate average power from raw data over the time period
    const startTime = new Date(lastEnergyReading.timestamp);
    const endTime = new Date(now);
    
    const powerQuery = `
      SELECT 
        (SELECT AVG(CASE WHEN power_l1 > 0 THEN power_l1 ELSE 0 END) FROM victron_grid_data WHERE timestamp >= $1 AND timestamp <= $2) as avg_grid_import,
        (SELECT AVG(CASE WHEN power_l1 < 0 THEN ABS(power_l1) ELSE 0 END) FROM victron_grid_data WHERE timestamp >= $1 AND timestamp <= $2) as avg_grid_export,
        (SELECT AVG(power) FROM victron_pv_data WHERE timestamp >= $1 AND timestamp <= $2) as avg_solar_power,
        (SELECT AVG(CASE WHEN power > 0 THEN power ELSE 0 END) FROM victron_battery_data WHERE timestamp >= $1 AND timestamp <= $2) as avg_battery_charge,
        (SELECT AVG(CASE WHEN power < 0 THEN ABS(power) ELSE 0 END) FROM victron_battery_data WHERE timestamp >= $1 AND timestamp <= $2) as avg_battery_discharge,
        (SELECT AVG(soc) FROM victron_battery_data WHERE timestamp >= $1 AND timestamp <= $2) as avg_soc
    `;
    
    const powerResult = await dbClient.query(powerQuery, [startTime, endTime]);
    
    if (powerResult.rows.length === 0) {
      log('No power data available for energy calculation', 'WARN');
      return;
    }
    
    const avgPower = powerResult.rows[0];
    
    // Check if we have any data at all
    if (!avgPower.avg_grid_import && !avgPower.avg_solar_power && !avgPower.avg_battery_charge && !avgPower.avg_battery_discharge) {
      log(`No power data in time range ${startTime.toISOString()} to ${endTime.toISOString()}`, 'WARN');
      return;
    }
    const avgGridImport = parseFloat(avgPower.avg_grid_import) || 0;
    const avgGridExport = parseFloat(avgPower.avg_grid_export) || 0;
    const avgSolar = parseFloat(avgPower.avg_solar_power) || 0;
    const avgBattCharge = parseFloat(avgPower.avg_battery_charge) || 0;
    const avgBattDischarge = parseFloat(avgPower.avg_battery_discharge) || 0;
    const avgSoc = parseFloat(avgPower.avg_soc) || 0;
    
    // Calculate energy deltas (kWh)
    const gridImportKwh = avgGridImport * timeDiffHours / 1000;
    const gridExportKwh = avgGridExport * timeDiffHours / 1000;
    const solarKwh = avgSolar * timeDiffHours / 1000;
    const batteryChargeKwh = avgBattCharge * timeDiffHours / 1000;
    const batteryDischargeKwh = avgBattDischarge * timeDiffHours / 1000;
    const loadKwh = (avgGridImport + avgBattDischarge) * timeDiffHours / 1000;
    
    // Calculate costs and earnings (pence)
    const importCost = gridImportKwh * tariffConfig.importRate;
    const exportEarnings = gridExportKwh * tariffConfig.exportRate;
    
    log(`Energy calculation: Solar=${solarKwh.toFixed(4)}kWh, Import=${gridImportKwh.toFixed(4)}kWh, Export=${gridExportKwh.toFixed(4)}kWh, TimeDiff=${timeDiffHours.toFixed(4)}h`);
    
    // Insert energy tracking record with ON CONFLICT handling
    const insertQuery = `
      INSERT INTO victron_energy_tracking (
        device_id,
        tracking_timestamp,
        tariff_period,
        grid_import_kwh,
        grid_export_kwh,
        solar_generation_kwh,
        battery_charge_kwh,
        battery_discharge_kwh,
        load_consumption_kwh,
        battery_soc_start,
        battery_soc_end,
        import_cost_pence,
        export_earnings_pence,
        total_cost_pence
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (tracking_timestamp, device_id) DO UPDATE SET
        tariff_period = EXCLUDED.tariff_period,
        grid_import_kwh = EXCLUDED.grid_import_kwh,
        grid_export_kwh = EXCLUDED.grid_export_kwh,
        solar_generation_kwh = EXCLUDED.solar_generation_kwh,
        battery_charge_kwh = EXCLUDED.battery_charge_kwh,
        battery_discharge_kwh = EXCLUDED.battery_discharge_kwh,
        load_consumption_kwh = EXCLUDED.load_consumption_kwh,
        battery_soc_start = EXCLUDED.battery_soc_start,
        battery_soc_end = EXCLUDED.battery_soc_end,
        import_cost_pence = EXCLUDED.import_cost_pence,
        export_earnings_pence = EXCLUDED.export_earnings_pence,
        total_cost_pence = EXCLUDED.total_cost_pence
    `;
    
    const DEVICE_ID = process.env.DEVICE_ID || "c0619ab786e2";
    
    await dbClient.query(insertQuery, [
      DEVICE_ID,
      endTime,
      currentTariffPeriod,
      gridImportKwh,
      gridExportKwh,
      solarKwh,
      batteryChargeKwh,
      batteryDischargeKwh,
      loadKwh,
      lastEnergyReading.soc || avgSoc,
      avgSoc,
      importCost,
      exportEarnings,
      importCost - exportEarnings
    ]);
    
    log(`Successfully inserted energy tracking record: ${solarKwh.toFixed(4)}kWh solar, ${gridImportKwh.toFixed(4)}kWh import, ${gridExportKwh.toFixed(4)}kWh export`);
    
    // Update last reading timestamp
    lastEnergyReading.timestamp = now;
    lastEnergyReading.soc = avgSoc;
    
  } catch (error) {
    log(`Error calculating energy metrics: ${error.message}`, "ERROR");
  }
}

// ---------------- Tariff Period Management ----------------
async function getCurrentTariffPeriod() {
  try {
    const now = new Date();
    const currentTime = now.toTimeString().slice(0, 5); // HH:MM format
    
    const query = `
      SELECT 
        period_name,
        import_rate_pence,
        export_rate_pence,
        start_time,
        end_time
      FROM victron_tariff_periods
      WHERE is_active = true 
        AND (
          (start_time <= end_time AND $1 >= start_time AND $1 <= end_time)
          OR
          (start_time > end_time AND ($1 >= start_time OR $1 <= end_time))
        )
      ORDER BY 
        CASE 
          WHEN start_time > end_time THEN 1 
          ELSE 0 
        END,
        start_time
      LIMIT 1
    `;
    
    const result = await dbClient.query(query, [currentTime]);
    
    if (result.rows.length > 0) {
      const newPeriod = result.rows[0].period_name;
      if (newPeriod !== currentTariffPeriod) {
        log(`Tariff period changed: ${currentTariffPeriod} -> ${newPeriod}`);
        currentTariffPeriod = newPeriod;
      }
      // log(`Current tariff period: ${newPeriod} (${result.rows[0].start_time}-${result.rows[0].end_time})`, "DEBUG");
    } else {
      log("No active tariff period found", "WARN");
    }
  } catch (error) {
    log(`Error getting tariff period: ${error.message}`, "ERROR");
  }
}

// ---------------- System Monitoring ----------------
async function monitorSystemHealth() {
  try {
    // Check data freshness
    const freshnessQuery = `
      SELECT 
        'battery' as source, MAX(timestamp) as last_update FROM victron_battery_data
        WHERE timestamp > NOW() - INTERVAL '5 minutes'
      UNION ALL
      SELECT 
        'pv' as source, MAX(timestamp) as last_update FROM victron_pv_data
        WHERE timestamp > NOW() - INTERVAL '5 minutes'
      UNION ALL
      SELECT 
        'grid' as source, MAX(timestamp) as last_update FROM victron_grid_data
        WHERE timestamp > NOW() - INTERVAL '5 minutes'
    `;
    
    const result = await dbClient.query(freshnessQuery);
    
    result.rows.forEach(row => {
      if (!row.last_update) {
        log(`WARNING: No recent ${row.source} data (last 5 minutes)`, "WARN");
      }
    });
    
    // log("System health check completed", "DEBUG");
    
  } catch (error) {
    log(`Error monitoring system health: ${error.message}`, "ERROR");
  }
}

// ---------------- Startup and Intervals ----------------
async function startup() {
  log("Starting Victron Monitoring Service");
  await connectDatabase();
  await getCurrentTariffPeriod();
  log("Monitoring service ready");
}

// Energy calculations every 5 minutes
setInterval(async () => {
  await calculateEnergyMetrics();
}, 300000);

// Tariff period check every minute
setInterval(async () => {
  await getCurrentTariffPeriod();
}, 60000);

// System health monitoring every 10 minutes
setInterval(async () => {
  await monitorSystemHealth();
}, 600000);

// Graceful shutdown
process.on('SIGINT', async () => {
  log("Shutting down monitoring service...");
  await dbClient.end();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  log("Shutting down monitoring service...");
  await dbClient.end();
  process.exit(0);
});

// Start the service
startup().catch(err => {
  log(`Failed to start monitoring service: ${err.message}`, "ERROR");
  process.exit(1);
});
