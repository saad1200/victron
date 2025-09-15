/**
 * Victron Database Data Deletion Utility
 * Deletes all data from all Victron tables
 * Usage: node delete-all-data.js
 * 
 * WARNING: This will permanently delete all data from the database!
 */

const { Pool } = require("pg");
const readline = require("readline");
require("dotenv").config();

// Database configuration
const DB_CONFIG = {
  user: process.env.DB_USER || "admin",
  host: process.env.DB_HOST || "192.168.9.185",
  database: process.env.DB_NAME || "victron",
  password: process.env.DB_PASSWORD || "password",
  port: process.env.DB_PORT || 5433,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
};

// List of data tables (excluding configuration tables used by controller)
const VICTRON_TABLES = [
  'victron_battery_data',
  'victron_battery_snapshots',
  'victron_charge_events',
  'victron_charge_sessions',
  'victron_energy_tracking',
  'victron_grid_data',
  'victron_inverter_data',
  'victron_metrics',
  'victron_pv_data',
  'victron_system_events',
  'victron_tariff_events'
];

// Configuration tables excluded (used by controller for input/configuration):
// - victron_charge_config
// - victron_grid_setpoints  
// - victron_tariff_periods

// Logging function
function log(message, level = "INFO") {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}] ${message}`);
}

// Create readline interface for user confirmation
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function confirmDeletion() {
  return new Promise((resolve) => {
    rl.question('⚠️  WARNING: This will DELETE ALL DATA from all Victron tables. Are you sure? (yes/no): ', (answer) => {
      resolve(answer.toLowerCase() === 'yes');
    });
  });
}

async function getTableCounts(pool) {
  const counts = {};
  
  for (const table of VICTRON_TABLES) {
    try {
      const result = await pool.query(`SELECT COUNT(*) as count FROM ${table}`);
      counts[table] = parseInt(result.rows[0].count);
    } catch (err) {
      counts[table] = `Error: ${err.message}`;
    }
  }
  
  return counts;
}

async function deleteAllData() {
  const pool = new Pool(DB_CONFIG);
  
  try {
    log("Connecting to PostgreSQL database...");
    log(`Database: ${DB_CONFIG.database}@${DB_CONFIG.host}:${DB_CONFIG.port} as ${DB_CONFIG.user}`);
    
    // Test connection
    const client = await pool.connect();
    client.release();
    log("Database connection successful");
    
    // Get current record counts
    log("Getting current record counts...");
    const beforeCounts = await getTableCounts(pool);
    
    log("Current record counts:");
    let totalRecords = 0;
    for (const [table, count] of Object.entries(beforeCounts)) {
      log(`  - ${table}: ${count} records`);
      if (typeof count === 'number') {
        totalRecords += count;
      }
    }
    
    if (totalRecords === 0) {
      log("No data found in any tables. Nothing to delete.");
      return;
    }
    
    log(`Total records across all tables: ${totalRecords}`);
    
    // Ask for confirmation
    const confirmed = await confirmDeletion();
    
    if (!confirmed) {
      log("Operation cancelled by user.");
      return;
    }
    
    log("Starting data deletion...");
    
    // Delete data from all tables
    let deletedTables = 0;
    let totalDeleted = 0;
    
    for (const table of VICTRON_TABLES) {
      try {
        log(`Deleting data from ${table}...`);
        const result = await pool.query(`DELETE FROM ${table}`);
        const deletedCount = result.rowCount;
        log(`Deleted ${deletedCount} records from ${table}`);
        totalDeleted += deletedCount;
        deletedTables++;
      } catch (err) {
        log(`Failed to delete data from ${table}: ${err.message}`, "ERROR");
      }
    }
    
    log(`Data deletion completed!`);
    log(`Successfully deleted data from ${deletedTables}/${VICTRON_TABLES.length} tables`);
    log(`Total records deleted: ${totalDeleted}`);
    
    // Verify deletion
    log("Verifying deletion...");
    const afterCounts = await getTableCounts(pool);
    
    log("Record counts after deletion:");
    for (const [table, count] of Object.entries(afterCounts)) {
      log(`  - ${table}: ${count} records`);
    }
    
    // Optional: Reset sequences (auto-increment IDs)
    log("Resetting auto-increment sequences...");
    for (const table of VICTRON_TABLES) {
      try {
        await pool.query(`ALTER SEQUENCE ${table}_id_seq RESTART WITH 1`);
        log(`Reset sequence for ${table}`);
      } catch (err) {
        log(`Failed to reset sequence for ${table}: ${err.message}`, "WARN");
      }
    }
    
    log("All operations completed successfully!");
    
  } catch (error) {
    log(`Error during deletion: ${error.message}`, "ERROR");
    
    if (error.code === 'ECONNREFUSED') {
      log("Connection refused. Check if PostgreSQL is running.", "ERROR");
    } else if (error.code === '3D000') {
      log(`Database '${DB_CONFIG.database}' does not exist.`, "ERROR");
    } else if (error.code === '28P01') {
      log("Authentication failed. Check database credentials in .env file.", "ERROR");
    }
    
    process.exit(1);
  } finally {
    await pool.end();
    rl.close();
    log("Database connection closed.");
  }
}

// Command line execution
if (require.main === module) {
  log("Starting Victron Database Data Deletion Utility");
  
  deleteAllData()
    .then(() => {
      log("Data deletion utility completed!");
      process.exit(0);
    })
    .catch((error) => {
      log(`Data deletion utility failed: ${error.message}`, "ERROR");
      process.exit(1);
    });
}

// Export for use in other modules
module.exports = {
  deleteAllData,
  getTableCounts,
  VICTRON_TABLES,
  DB_CONFIG
};
