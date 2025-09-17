const { Client } = require('pg');
require('dotenv').config();

const DB_CONFIG = {
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
};

async function checkDataCounts() {
  const client = new Client(DB_CONFIG);
  
  try {
    await client.connect();
    console.log('Connected to database');
    
    const queries = [
      'SELECT COUNT(*) as grid_count FROM victron_grid_data',
      'SELECT COUNT(*) as pv_count FROM victron_pv_data', 
      'SELECT COUNT(*) as battery_count FROM victron_battery_data',
      'SELECT COUNT(*) as energy_tracking_count FROM victron_energy_tracking',
      'SELECT MIN(timestamp) as earliest_data, MAX(timestamp) as latest_data FROM victron_grid_data',
      'SELECT MIN(timestamp) as earliest_battery, MAX(timestamp) as latest_battery FROM victron_battery_data'
    ];
    
    for (const query of queries) {
      const result = await client.query(query);
      console.log(`${query}:`);
      console.log(result.rows[0]);
      console.log('---');
    }
    
  } catch (error) {
    console.error('Database error:', error.message);
  } finally {
    await client.end();
  }
}

checkDataCounts();
