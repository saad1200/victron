const express = require('express');
const path = require('path');
const { Pool } = require('pg');

// Database connection
const dbClient = new Pool({
  host: process.env.DB_HOST || '192.168.9.185',
  port: process.env.DB_PORT || 5433,
  database: process.env.DB_NAME || 'victron',
  user: process.env.DB_USER || 'admin',
  password: process.env.DB_PASSWORD || 'password',
});

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3001;

// Serve static files from dashboard directory
app.use(express.static(path.join(__dirname, '../dashboard')));

// API endpoint for dashboard data
app.get('/api/dashboard-data', async (req, res) => {
  try {
    const { start, end, period = 'day' } = req.query;
    
    if (!start || !end) {
      return res.status(400).json({ error: 'Start and end dates are required' });
    }

    const data = await getDashboardData(start, end, period);
    res.json(data);
    
  } catch (error) {
    console.error('Dashboard API error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function getDashboardData(startDate, endDate, period) {
  const data = {
    summary: await getSummaryData(startDate, endDate),
    timeSeries: await getTimeSeriesData(startDate, endDate, period),
    financial: await getFinancialData(startDate, endDate),
    battery: await getBatteryData(startDate, endDate),
    tariffBreakdown: await getTariffBreakdown(startDate, endDate)
  };
  
  return data;
}

async function getSummaryData(startDate, endDate) {
  // First check if table exists and has data
  try {
    const tableCheck = await dbClient.query(`
      SELECT COUNT(*) as count FROM victron_energy_tracking
    `);
    console.log(`victron_energy_tracking table has ${tableCheck.rows[0].count} total rows`);
    
    const dateRangeCheck = await dbClient.query(`
      SELECT COUNT(*) as count FROM victron_energy_tracking 
      WHERE tracking_timestamp >= $1 AND tracking_timestamp <= $2
    `, [startDate, endDate]);
    console.log(`Found ${dateRangeCheck.rows[0].count} rows for date range ${startDate} to ${endDate}`);
    
  } catch (err) {
    console.log('Table check error:', err.message);
    // Try alternative table names that might exist
    try {
      const altCheck = await dbClient.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE '%energy%' OR table_name LIKE '%victron%'`);
      console.log('Available tables:', altCheck.rows.map(r => r.table_name));
    } catch (e) {
      console.log('Could not list tables:', e.message);
    }
  }

  const query = `
    SELECT 
      COALESCE(SUM(grid_import_kwh), 0) as total_import,
      COALESCE(SUM(grid_export_kwh), 0) as total_export,
      COALESCE(SUM(solar_generation_kwh), 0) as total_solar,
      COALESCE(SUM(battery_charge_kwh), 0) as total_battery_charge,
      COALESCE(SUM(battery_discharge_kwh), 0) as total_battery_discharge,
      COALESCE(SUM(load_consumption_kwh), 0) as total_load,
      COALESCE(SUM(import_cost_pence), 0) as import_cost,
      COALESCE(SUM(export_earnings_pence), 0) as export_earnings
    FROM victron_energy_tracking 
    WHERE DATE(tracking_timestamp) >= $1::date AND DATE(tracking_timestamp) <= $2::date
  `;
  
  const result = await dbClient.query(query, [startDate, endDate]);
  const row = result.rows[0];
  console.log('Query result:', row);
  
  // Calculate derived metrics
  const batteryEfficiency = row.total_battery_charge > 0 
    ? (row.total_battery_discharge / row.total_battery_charge) * 100 
    : 0;
    
  const selfConsumption = row.total_solar > 0 
    ? ((row.total_solar - row.total_export) / row.total_solar) * 100 
    : 0;
  
  return {
    totalImport: parseFloat(row.total_import) || 0,
    totalExport: parseFloat(row.total_export) || 0,
    totalSolar: parseFloat(row.total_solar) || 0,
    totalBatteryCharge: parseFloat(row.total_battery_charge) || 0,
    totalBatteryDischarge: parseFloat(row.total_battery_discharge) || 0,
    totalLoad: parseFloat(row.total_load) || 0,
    importCost: parseFloat(row.import_cost) || 0,
    exportEarnings: parseFloat(row.export_earnings) || 0,
    batteryEfficiency: batteryEfficiency,
    selfConsumption: selfConsumption
  };
}

async function getTimeSeriesData(startDate, endDate, period) {
  let groupBy, dateFormat;
  
  switch (period) {
    case 'hour':
      groupBy = "DATE_TRUNC('hour', tracking_timestamp)";
      dateFormat = 'YYYY-MM-DD HH24:00:00';
      break;
    case 'tariff':
      groupBy = "tariff_period, DATE_TRUNC('day', tracking_timestamp)";
      dateFormat = 'YYYY-MM-DD';
      break;
    default: // day
      groupBy = "DATE_TRUNC('day', tracking_timestamp)";
      dateFormat = 'YYYY-MM-DD';
  }
  
  const query = `
    SELECT 
      ${groupBy} as timestamp,
      ${period === 'tariff' ? 'tariff_period,' : ''}
      SUM(grid_import_kwh) as import,
      SUM(grid_export_kwh) as export,
      SUM(solar_generation_kwh) as solar,
      SUM(load_consumption_kwh) as load,
      SUM(battery_charge_kwh) as battery_charge,
      SUM(battery_discharge_kwh) as battery_discharge
    FROM victron_energy_tracking 
    WHERE DATE(tracking_timestamp) >= $1::date AND DATE(tracking_timestamp) <= $2::date
    GROUP BY ${groupBy}
    ORDER BY timestamp
  `;
  
  const result = await dbClient.query(query, [startDate, endDate]);
  
  return result.rows.map(row => ({
    timestamp: row.timestamp,
    tariffPeriod: row.tariff_period || null,
    import: parseFloat(row.import || 0),
    export: parseFloat(row.export || 0),
    solar: parseFloat(row.solar || 0),
    load: parseFloat(row.load || 0),
    batteryCharge: parseFloat(row.battery_charge || 0),
    batteryDischarge: parseFloat(row.battery_discharge || 0)
  }));
}

async function getFinancialData(startDate, endDate) {
  const query = `
    SELECT 
      DATE_TRUNC('day', tracking_timestamp) as date,
      SUM(import_cost_pence) as import_cost,
      SUM(export_earnings_pence) as export_earnings,
      SUM(export_earnings_pence) - SUM(import_cost_pence) as net_profit
    FROM victron_energy_tracking 
    WHERE DATE(tracking_timestamp) >= $1::date AND DATE(tracking_timestamp) <= $2::date
    GROUP BY DATE_TRUNC('day', tracking_timestamp)
    ORDER BY date
  `;
  
  const result = await dbClient.query(query, [startDate, endDate]);
  
  return result.rows.map(row => ({
    date: row.date,
    importCost: parseFloat(row.import_cost || 0),
    exportEarnings: parseFloat(row.export_earnings || 0),
    netProfit: parseFloat(row.net_profit || 0)
  }));
}

async function getBatteryData(startDate, endDate) {
  const query = `
    SELECT 
      timestamp,
      soc,
      power
    FROM victron_battery_data 
    WHERE timestamp >= $1 AND timestamp <= $2
    ORDER BY timestamp
    LIMIT 1000
  `;
  
  const result = await dbClient.query(query, [startDate, endDate]);
  
  return result.rows.map(row => ({
    timestamp: row.timestamp,
    soc: parseFloat(row.soc || 0),
    power: parseFloat(row.power || 0)
  }));
}

async function getTariffBreakdown(startDate, endDate) {
  const query = `
    SELECT 
      tariff_period,
      SUM(grid_import_kwh) as total_import,
      SUM(grid_export_kwh) as total_export,
      SUM(import_cost_pence) as import_cost,
      SUM(export_earnings_pence) as export_earnings,
      SUM(export_earnings_pence) - SUM(import_cost_pence) as profit
    FROM victron_energy_tracking 
    WHERE DATE(tracking_timestamp) >= $1::date AND DATE(tracking_timestamp) <= $2::date
    GROUP BY tariff_period
  `;
  
  const result = await dbClient.query(query, [startDate, endDate]);
  
  const breakdown = {};
  result.rows.forEach(row => {
    breakdown[row.tariff_period] = {
      totalImport: parseFloat(row.total_import || 0),
      totalExport: parseFloat(row.total_export || 0),
      importCost: parseFloat(row.import_cost || 0),
      exportEarnings: parseFloat(row.export_earnings || 0),
      profit: parseFloat(row.profit || 0)
    };
  });
  
  return breakdown;
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  console.log(`Dashboard server running on http://localhost:${PORT}`);
});

module.exports = app;
