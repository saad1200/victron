/**
 * Check Battery SOC vs MinSOC Settings
 * Investigates why inverter thinks minSOC has been reached when in optimized battery mode
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

async function checkSOCStatus() {
  try {
    await client.connect();
    console.log('=== Battery SOC Analysis ===\n');
    
    // Get latest battery SOC readings
    const socQuery = `
      SELECT 
        soc,
        timestamp,
        power
      FROM victron_battery_data 
      WHERE soc IS NOT NULL 
      ORDER BY timestamp DESC 
      LIMIT 10
    `;
    
    const socResult = await client.query(socQuery);
    console.log('📊 Latest Battery SOC Readings:');
    socResult.rows.forEach((row, index) => {
      const timestamp = new Date(row.timestamp).toLocaleString();
      console.log(`${index + 1}. ${timestamp}: ${row.soc}% SOC | Battery Power: ${row.power}W`);
    });
    
    // Get current period settings
    const currentTime = new Date().toTimeString().slice(0, 5);
    const settingsQuery = `
      SELECT 
        vtp.period_name,
        vgs.min_soc_percent,
        vgs.max_soc_percent,
        vgs.ess_mode,
        vgs.inverter_mode,
        vgs.grid_setpoint_watts,
        vgs.description,
        vtp.start_time,
        vtp.end_time
      FROM victron_tariff_periods vtp 
      JOIN victron_grid_setpoints vgs ON vtp.period_name = vgs.tariff_period 
      WHERE vtp.is_active = true AND vgs.is_active = true
        AND (
          (vtp.start_time > vtp.end_time AND ($1::time >= vtp.start_time OR $1::time < vtp.end_time))
          OR
          (vtp.start_time <= vtp.end_time AND $1::time >= vtp.start_time AND $1::time < vtp.end_time)
        )
      LIMIT 1
    `;
    
    const settingsResult = await client.query(settingsQuery, [currentTime]);
    
    if (settingsResult.rows.length > 0) {
      const settings = settingsResult.rows[0];
      console.log('\n⚙️ Current Period Configuration:');
      console.log(`Period: ${settings.period_name} (${settings.start_time}-${settings.end_time})`);
      console.log(`Min SOC: ${settings.min_soc_percent}%`);
      console.log(`Max SOC: ${settings.max_soc_percent}%`);
      console.log(`ESS Mode: ${settings.ess_mode}`);
      console.log(`Inverter Mode: ${settings.inverter_mode}`);
      console.log(`Grid Setpoint: ${settings.grid_setpoint_watts}W`);
      console.log(`Description: ${settings.description}`);
      
      // Compare with latest SOC
      if (socResult.rows.length > 0) {
        const latestSOC = parseFloat(socResult.rows[0].soc);
        const minSOC = parseFloat(settings.min_soc_percent);
        
        console.log('\n🔋 SOC Analysis:');
        console.log(`Current SOC: ${latestSOC}%`);
        console.log(`Min SOC Setting: ${minSOC}%`);
        
        const socDifference = latestSOC - minSOC;
        console.log(`SOC Above Minimum: ${latestSOC > minSOC ? '✅ YES' : '❌ NO'} (difference: ${socDifference.toFixed(1)}%)`);
        
        if (latestSOC <= minSOC) {
          console.log('\n⚠️  WARNING: Battery SOC is at or below minimum threshold!');
          console.log('   This explains why the inverter thinks minSOC has been reached.');
        } else if (socDifference < 5) {
          console.log('\n⚠️  CAUTION: Battery SOC is close to minimum threshold.');
          console.log('   Inverter may be preparing for minSOC protection mode.');
        } else {
          console.log('\n✅ Battery SOC is well above minimum threshold.');
          console.log('   Issue may be related to ESS mode or inverter configuration.');
        }
        
        // Check ESS mode implications
        console.log('\n🔧 ESS Mode Analysis:');
        switch (settings.ess_mode) {
          case 1:
            console.log('ESS Mode 1: Optimized (with BatteryLife)');
            console.log('- Battery discharge limited by minSOC setting');
            console.log('- May stop discharging early to preserve battery life');
            break;
          case 2:
            console.log('ESS Mode 2: Optimized (without BatteryLife)');
            console.log('- More aggressive battery usage');
            console.log('- Should discharge closer to actual minSOC');
            break;
          case 3:
            console.log('ESS Mode 3: Keep batteries charged');
            console.log('- Minimal battery discharge');
            console.log('- Prioritizes keeping batteries full');
            break;
          default:
            console.log(`ESS Mode ${settings.ess_mode}: Unknown mode`);
        }
        
        // Check inverter mode
        console.log('\n🔌 Inverter Mode Analysis:');
        switch (settings.inverter_mode) {
          case 1:
            console.log('Inverter Mode 1: Charger Only');
            console.log('- Inverter disabled, only charging allowed');
            break;
          case 2:
            console.log('Inverter Mode 2: Inverter Only');
            console.log('- No charging, only discharging/inverting');
            break;
          case 3:
            console.log('Inverter Mode 3: ON');
            console.log('- Full operation: charging and inverting allowed');
            break;
          case 4:
            console.log('Inverter Mode 4: OFF');
            console.log('- Inverter completely disabled');
            break;
          default:
            console.log(`Inverter Mode ${settings.inverter_mode}: Unknown mode`);
        }
      }
    } else {
      console.log('\n❌ No active tariff period found for current time');
    }
    
    // Show all period minSOC settings for reference
    const allPeriodsQuery = `
      SELECT 
        vtp.period_name,
        vgs.min_soc_percent,
        vgs.ess_mode,
        vtp.start_time,
        vtp.end_time
      FROM victron_tariff_periods vtp 
      JOIN victron_grid_setpoints vgs ON vtp.period_name = vgs.tariff_period 
      WHERE vtp.is_active = true AND vgs.is_active = true
      ORDER BY vtp.start_time
    `;
    
    const allPeriodsResult = await client.query(allPeriodsQuery);
    console.log('\n📅 All Tariff Periods Min SOC Settings:');
    allPeriodsResult.rows.forEach(row => {
      console.log(`${row.period_name} (${row.start_time}-${row.end_time}): ${row.min_soc_percent}% min SOC, ESS mode ${row.ess_mode}`);
    });
    
    await client.end();
    
  } catch (err) {
    console.error('❌ Error:', err.message);
  }
}

// Run the analysis
checkSOCStatus()
