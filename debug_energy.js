const { Client } = require('pg');

const client = new Client({
  host: '192.168.9.185',
  database: 'victron',
  user: 'admin',
  password: 'password',
  port: 5433,
});

async function debugEnergyCalculation() {
  try {
    await client.connect();
    
    console.log('=== DEBUGGING 15.06 kWh SOLAR IN 10 MINUTES ===\n');
    
    // 1. Check the specific records in that time range
    console.log('1. Records in the problematic time period:');
    const records = await client.query(`
      SELECT 
        tracking_timestamp,
        solar_generation_kwh,
        grid_export_kwh,
        grid_import_kwh,
        load_consumption_kwh
      FROM victron_energy_tracking 
      WHERE tracking_timestamp BETWEEN '2025-09-16 11:21:52' AND '2025-09-16 11:31:54'
      ORDER BY tracking_timestamp
    `);
    
    let totalSolar = 0;
    records.rows.forEach((row, i) => {
      const solar = parseFloat(row.solar_generation_kwh || 0);
      totalSolar += solar;
      console.log(`${i+1}. ${row.tracking_timestamp}: Solar=${solar.toFixed(4)} kWh`);
    });
    
    console.log(`\nTotal Solar Generation: ${totalSolar.toFixed(4)} kWh`);
    console.log(`Record count: ${records.rows.length}`);
    console.log(`Time span: ~10 minutes`);
    
    // 2. Calculate what this means in terms of power
    const timeHours = 10 / 60; // 10 minutes in hours
    const avgPowerKw = totalSolar / timeHours;
    const avgPowerW = avgPowerKw * 1000;
    
    console.log(`\n2. Power Analysis:`);
    console.log(`Average power required: ${avgPowerKw.toFixed(1)} kW = ${avgPowerW.toFixed(0)} W`);
    console.log(`This is ${avgPowerW > 15000 ? 'IMPOSSIBLE' : 'possible'} for residential solar`);
    
    // 3. Check raw power data for the same period
    console.log(`\n3. Raw PV power data for same period:`);
    const pvData = await client.query(`
      SELECT 
        timestamp,
        power,
        voltage,
        current
      FROM victron_pv_data 
      WHERE timestamp BETWEEN '2025-09-16 11:21:52' AND '2025-09-16 11:31:54'
      ORDER BY timestamp
      LIMIT 10
    `);
    
    if (pvData.rows.length > 0) {
      pvData.rows.forEach(row => {
        console.log(`${row.timestamp}: Power=${row.power}W, V=${row.voltage}V, I=${row.current}A`);
      });
      
      const avgRawPower = pvData.rows.reduce((sum, row) => sum + parseFloat(row.power || 0), 0) / pvData.rows.length;
      console.log(`Average raw PV power: ${avgRawPower.toFixed(1)}W`);
      
      // What this should generate in 10 minutes
      const expectedKwh = (avgRawPower * timeHours) / 1000;
      console.log(`Expected energy in 10 min: ${expectedKwh.toFixed(4)} kWh`);
    } else {
      console.log('No PV data found for this period');
    }
    
    // 4. Check if there's a unit conversion issue
    console.log(`\n4. Checking for unit conversion issues:`);
    if (totalSolar > 1 && avgPowerW > 50000) {
      console.log('LIKELY ISSUE: Power values may already be in kW, not W');
      console.log('The /1000 conversion in energy calculation may be incorrect');
    }
    
    // 5. Check the averaging query that's used in trackEnergyUsage
    console.log(`\n5. Testing the averaging query used in trackEnergyUsage:`);
    const avgQuery = await client.query(`
      SELECT 
        AVG(p.power) as avg_solar_power,
        COUNT(p.power) as power_readings,
        MIN(p.power) as min_power,
        MAX(p.power) as max_power
      FROM victron_pv_data p
      WHERE p.timestamp BETWEEN '2025-09-16 11:21:52' AND '2025-09-16 11:31:54'
    `);
    
    if (avgQuery.rows[0]) {
      const row = avgQuery.rows[0];
      console.log(`Average solar power: ${parseFloat(row.avg_solar_power || 0).toFixed(1)}W`);
      console.log(`Power readings: ${row.power_readings}`);
      console.log(`Min power: ${row.min_power}W, Max power: ${row.max_power}W`);
      
      // Simulate the energy calculation
      const simAvgPower = parseFloat(row.avg_solar_power || 0);
      const simEnergyKwh = simAvgPower * timeHours / 1000;
      console.log(`Simulated energy calc: ${simAvgPower}W * ${timeHours.toFixed(4)}h / 1000 = ${simEnergyKwh.toFixed(4)} kWh`);
    }
    
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await client.end();
  }
}

debugEnergyCalculation();
