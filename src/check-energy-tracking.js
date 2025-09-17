/**
 * Check Energy Tracking Status
 * Diagnoses why trackEnergyUsage hasn't updated in 5+ minutes
 */

const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  user: process.env.DB_USER || "postgres",
  host: process.env.DB_HOST || "localhost",
  database: process.env.DB_NAME || "victron",
  password: process.env.DB_PASSWORD || "password",
  port: process.env.DB_PORT || 5433,
});

async function checkEnergyTrackingStatus() {
  try {
    await client.connect();
    console.log('=== Energy Tracking Diagnostics ===\n');
    
    // Check last energy tracking entry
    const lastEntryQuery = `
      SELECT 
        tracking_timestamp,
        tariff_period,
        grid_import_kwh,
        grid_export_kwh,
        net_cost_pence,
        EXTRACT(EPOCH FROM (NOW() - tracking_timestamp)) / 60 as minutes_ago
      FROM victron_energy_tracking 
      WHERE device_id = 'c0619ab786e2'
      ORDER BY tracking_timestamp DESC 
      LIMIT 5
    `;
    
    const lastEntries = await client.query(lastEntryQuery);
    
    if (lastEntries.rows.length === 0) {
      console.log('❌ No energy tracking entries found in database');
      console.log('   This indicates trackEnergyUsage() has never run successfully');
    } else {
      console.log('📊 Last 5 Energy Tracking Entries:');
      lastEntries.rows.forEach((row, index) => {
        const minutesAgo = Math.round(row.minutes_ago);
        console.log(`${index + 1}. ${row.tracking_timestamp} (${minutesAgo} min ago)`);
        console.log(`   Period: ${row.tariff_period}, Import: ${row.grid_import_kwh}kWh, Export: ${row.grid_export_kwh}kWh, Net: ${row.net_cost_pence}p`);
      });
      
      const lastMinutesAgo = Math.round(lastEntries.rows[0].minutes_ago);
      if (lastMinutesAgo > 5) {
        console.log(`\n⚠️  ISSUE: Last entry was ${lastMinutesAgo} minutes ago (should be ≤5 minutes)`);
      } else {
        console.log(`\n✅ Energy tracking is current (last entry ${lastMinutesAgo} minutes ago)`);
      }
    }
    
    // Check current tariff period
    const currentTime = new Date().toTimeString().slice(0, 5);
    const currentPeriodQuery = `
      SELECT 
        vtp.period_name,
        vtp.import_rate_pence,
        vtp.export_rate_pence,
        vtp.start_time,
        vtp.end_time
      FROM victron_tariff_periods vtp 
      WHERE vtp.is_active = true
        AND (
          (vtp.start_time > vtp.end_time AND ($1::time >= vtp.start_time OR $1::time < vtp.end_time))
          OR
          (vtp.start_time <= vtp.end_time AND $1::time >= vtp.start_time AND $1::time < vtp.end_time)
        )
      LIMIT 1
    `;
    
    const currentResult = await client.query(currentPeriodQuery, [currentTime]);
    
    if (currentResult.rows.length > 0) {
      const current = currentResult.rows[0];
      console.log(`\n🕐 Current Tariff Period (${currentTime}):`);
      console.log(`Period: ${current.period_name} (${current.start_time}-${current.end_time})`);
      console.log(`Rates: Import ${current.import_rate_pence}p/kWh, Export ${current.export_rate_pence}p/kWh`);
    } else {
      console.log(`\n❌ No active tariff period found for current time: ${currentTime}`);
      console.log('   This would cause trackEnergyUsage() to return early');
    }
    
    // Check recent battery data to see if collection is working
    const batteryDataQuery = `
      SELECT 
        timestamp,
        soc,
        power,
        EXTRACT(EPOCH FROM (NOW() - timestamp)) / 60 as minutes_ago
      FROM victron_battery_data 
      WHERE device_id = 'c0619ab786e2'
      ORDER BY timestamp DESC 
      LIMIT 3
    `;
    
    const batteryData = await client.query(batteryDataQuery);
    
    if (batteryData.rows.length === 0) {
      console.log('\n❌ No battery data found - victron.collection.js may not be running');
    } else {
      console.log('\n🔋 Recent Battery Data:');
      batteryData.rows.forEach((row, index) => {
        const minutesAgo = Math.round(row.minutes_ago);
        console.log(`${index + 1}. ${row.timestamp} (${minutesAgo} min ago) - SOC: ${row.soc}%, Power: ${row.power}W`);
      });
      
      const lastBatteryMinutesAgo = Math.round(batteryData.rows[0].minutes_ago);
      if (lastBatteryMinutesAgo > 2) {
        console.log(`\n⚠️  Battery data is stale (${lastBatteryMinutesAgo} min ago) - collection may be stopped`);
      }
    }
    
    console.log('\n🔍 Troubleshooting Steps:');
    console.log('1. Check if victron.collection.js is running: pm2 status');
    console.log('2. Check collection logs: pm2 logs victron-collection');
    console.log('3. Restart collection if needed: pm2 restart victron-collection');
    console.log('4. Verify MQTT connection and data flow');
    console.log('5. Check if currentTariffPeriod variable is being set correctly');
    
    await client.end();
    
  } catch (err) {
    console.error('❌ Error:', err.message);
  }
}

// Run the diagnostics
checkEnergyTrackingStatus().catch(console.error);
