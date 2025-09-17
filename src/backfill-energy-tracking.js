const { Client } = require('pg');
require('dotenv').config();

// Database configuration
const dbConfig = {
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
};

const dbClient = new Client(dbConfig);

// Logging function
function log(message, level = "INFO") {
  const timestamp = new Date().toLocaleString('en-GB', { 
    timeZone: 'Europe/London',
    day: '2-digit',
    month: '2-digit', 
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
  });
  console.log(`[${timestamp}] [${level}] ${message}`);
}

// Get tariff period for a given timestamp
async function getTariffPeriod(timestamp) {
  // First try to get the current period from tariff events
  const eventQuery = `
    SELECT to_period
    FROM victron_tariff_events
    WHERE event_timestamp <= $1
    ORDER BY event_timestamp DESC
    LIMIT 1
  `;
  
  const eventResult = await dbClient.query(eventQuery, [timestamp]);
  let periodName = 'Day'; // Default fallback
  
  if (eventResult.rows.length > 0 && eventResult.rows[0].to_period) {
    periodName = eventResult.rows[0].to_period;
  }
  
  // Get the tariff rates for this period
  const rateQuery = `
    SELECT period_name, import_rate_pence, export_rate_pence
    FROM victron_tariff_periods 
    WHERE period_name = $1 AND is_active = true
    LIMIT 1
  `;
  
  const rateResult = await dbClient.query(rateQuery, [periodName]);
  
  if (rateResult.rows.length === 0) {
    // Fallback to Day rate if period not found
    const fallbackResult = await dbClient.query(rateQuery, ['Day']);
    return fallbackResult.rows[0] || null;
  }
  
  return rateResult.rows[0];
}

// Get power data for a specific timestamp range
async function getPowerData(startTime, endTime) {
  const query = `
    WITH power_data AS (
      SELECT 
        t.timestamp,
        COALESCE(g.power_l1, 0) as grid_power,
        COALESCE(p.power, 0) as solar_power,
        COALESCE(b.power, 0) as battery_power,
        COALESCE(i.power, 0) as inverter_power
      FROM (
        SELECT DISTINCT timestamp 
        FROM victron_grid_data 
        WHERE timestamp BETWEEN $1 AND $2
        UNION
        SELECT DISTINCT timestamp 
        FROM victron_pv_data 
        WHERE timestamp BETWEEN $1 AND $2
        UNION
        SELECT DISTINCT timestamp 
        FROM victron_battery_data 
        WHERE timestamp BETWEEN $1 AND $2
        UNION
        SELECT DISTINCT timestamp 
        FROM victron_inverter_data 
        WHERE timestamp BETWEEN $1 AND $2
      ) t
      LEFT JOIN victron_grid_data g ON g.timestamp = t.timestamp
      LEFT JOIN victron_pv_data p ON p.timestamp = t.timestamp
      LEFT JOIN victron_battery_data b ON b.timestamp = t.timestamp
      LEFT JOIN victron_inverter_data i ON i.timestamp = t.timestamp
      ORDER BY t.timestamp
    )
    SELECT 
      timestamp,
      AVG(grid_power) as avg_grid_power,
      AVG(solar_power) as avg_solar_power,
      AVG(battery_power) as avg_battery_power,
      AVG(inverter_power) as avg_inverter_power
    FROM power_data
    GROUP BY timestamp
    ORDER BY timestamp
  `;
  
  const result = await dbClient.query(query, [startTime, endTime]);
  return result.rows;
}

// Calculate energy tracking for a time period
async function calculateEnergyTracking(startTime, endTime, tariffPeriod) {
  const powerData = await getPowerData(startTime, endTime);
  
  if (powerData.length < 2) {
    return null; // Need at least 2 data points
  }
  
  let totalGridImportKwh = 0;
  let totalGridExportKwh = 0;
  let totalSolarKwh = 0;
  let totalBatteryChargeKwh = 0;
  let totalBatteryDischargeKwh = 0;
  let totalLoadKwh = 0;
  
  // Calculate energy deltas between consecutive readings
  for (let i = 1; i < powerData.length; i++) {
    const prev = powerData[i - 1];
    const curr = powerData[i];
    
    const timeDiffHours = (new Date(curr.timestamp) - new Date(prev.timestamp)) / (1000 * 60 * 60);
    
    if (timeDiffHours > 0 && timeDiffHours < 1) { // Only process reasonable time differences
      const avgGridPower = (parseFloat(prev.avg_grid_power) + parseFloat(curr.avg_grid_power)) / 2;
      const avgSolarPower = (parseFloat(prev.avg_solar_power) + parseFloat(curr.avg_solar_power)) / 2;
      const avgBatteryPower = (parseFloat(prev.avg_battery_power) + parseFloat(curr.avg_battery_power)) / 2;
      const avgInverterPower = (parseFloat(prev.avg_inverter_power) + parseFloat(curr.avg_inverter_power)) / 2;
      
      // Calculate load power (grid + battery discharge - battery charge)
      const avgLoadPower = avgGridPower + Math.max(0, -avgBatteryPower);
      
      // Calculate energy deltas (kWh)
      totalGridImportKwh += Math.max(0, avgGridPower) * timeDiffHours / 1000;
      totalGridExportKwh += Math.max(0, -avgGridPower) * timeDiffHours / 1000;
      totalSolarKwh += Math.max(0, avgSolarPower) * timeDiffHours / 1000;
      totalBatteryChargeKwh += Math.max(0, avgBatteryPower) * timeDiffHours / 1000;
      totalBatteryDischargeKwh += Math.max(0, -avgBatteryPower) * timeDiffHours / 1000;
      totalLoadKwh += Math.max(0, avgLoadPower) * timeDiffHours / 1000;
    }
  }
  
  // Calculate costs and earnings (pence)
  const importCostPence = totalGridImportKwh * tariffPeriod.import_rate_pence;
  const exportEarningsPence = totalGridExportKwh * tariffPeriod.export_rate_pence;
  const netCostPence = importCostPence - exportEarningsPence;
  
  return {
    grid_import_kwh: totalGridImportKwh,
    grid_export_kwh: totalGridExportKwh,
    solar_kwh: totalSolarKwh,
    battery_charge_kwh: totalBatteryChargeKwh,
    battery_discharge_kwh: totalBatteryDischargeKwh,
    load_kwh: totalLoadKwh,
    import_cost_pence: importCostPence,
    export_earnings_pence: exportEarningsPence,
    net_cost_pence: netCostPence,
    tariff_period: tariffPeriod.period_name
  };
}

// Main backfill function
async function backfillEnergyTracking(startDate, endDate, intervalMinutes = 5) {
  try {
    await dbClient.connect();
    log('Connected to database');
    
    const start = new Date(startDate);
    const end = new Date(endDate);
    const intervalMs = intervalMinutes * 60 * 1000;
    
    log(`Starting backfill from ${start.toISOString()} to ${end.toISOString()}`);
    log(`Using ${intervalMinutes} minute intervals`);
    
    let currentTime = new Date(start);
    let recordsInserted = 0;
    
    while (currentTime < end) {
      const nextTime = new Date(currentTime.getTime() + intervalMs);
      
      // Get tariff period for this time
      const tariffPeriod = await getTariffPeriod(currentTime);
      
      if (!tariffPeriod) {
        log(`No tariff period found for ${currentTime.toISOString()}, skipping`, "WARN");
        currentTime = nextTime;
        continue;
      }
      
      // Calculate energy tracking for this interval
      const energyData = await calculateEnergyTracking(currentTime, nextTime, tariffPeriod);
      
      if (energyData) {
        // Insert into database with ON CONFLICT handling
        const insertQuery = `
          INSERT INTO victron_energy_tracking (
            device_id,
            tracking_timestamp,
            tariff_period,
            import_rate_pence,
            export_rate_pence,
            grid_import_kwh,
            grid_export_kwh,
            solar_generation_kwh,
            battery_charge_kwh,
            battery_discharge_kwh,
            load_consumption_kwh,
            import_cost_pence,
            export_earnings_pence,
            net_cost_pence
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          ON CONFLICT (tracking_timestamp, device_id) DO UPDATE SET
            tariff_period = EXCLUDED.tariff_period,
            import_rate_pence = EXCLUDED.import_rate_pence,
            export_rate_pence = EXCLUDED.export_rate_pence,
            grid_import_kwh = EXCLUDED.grid_import_kwh,
            grid_export_kwh = EXCLUDED.grid_export_kwh,
            solar_generation_kwh = EXCLUDED.solar_generation_kwh,
            battery_charge_kwh = EXCLUDED.battery_charge_kwh,
            battery_discharge_kwh = EXCLUDED.battery_discharge_kwh,
            load_consumption_kwh = EXCLUDED.load_consumption_kwh,
            import_cost_pence = EXCLUDED.import_cost_pence,
            export_earnings_pence = EXCLUDED.export_earnings_pence,
            net_cost_pence = EXCLUDED.net_cost_pence
        `;
        
        await dbClient.query(insertQuery, [
          'c0619ab786e2', // Default device ID
          nextTime,
          energyData.tariff_period,
          tariffPeriod.import_rate_pence,
          tariffPeriod.export_rate_pence,
          energyData.grid_import_kwh,
          energyData.grid_export_kwh,
          energyData.solar_kwh,
          energyData.battery_charge_kwh,
          energyData.battery_discharge_kwh,
          energyData.load_kwh,
          energyData.import_cost_pence,
          energyData.export_earnings_pence,
          energyData.net_cost_pence
        ]);
        
        recordsInserted++;
        
        if (recordsInserted % 100 === 0) {
          log(`Inserted ${recordsInserted} records...`);
        }
      }
      
      currentTime = nextTime;
    }
    
    log(`Backfill complete! Inserted ${recordsInserted} energy tracking records`);
    
  } catch (error) {
    log(`Error during backfill: ${error.message}`, "ERROR");
    throw error;
  } finally {
    await dbClient.end();
  }
}

// Command line interface
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.log('Usage: node backfill-energy-tracking.js <start_date> <end_date> [interval_minutes]');
    console.log('Example: node backfill-energy-tracking.js "2025-09-13" "2025-09-16" 5');
    process.exit(1);
  }
  
  const startDate = args[0];
  const endDate = args[1];
  const intervalMinutes = args[2] ? parseInt(args[2]) : 5;
  
  backfillEnergyTracking(startDate, endDate, intervalMinutes)
    .then(() => {
      log('Backfill completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      log(`Backfill failed: ${error.message}`, "ERROR");
      process.exit(1);
    });
}

module.exports = { backfillEnergyTracking };
