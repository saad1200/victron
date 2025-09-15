/**
 * Victron MQTT Data Logger to PostgreSQL
 * Captures Victron energy system metrics via MQTT and stores them in PostgreSQL with timestamps
 */

const mqtt = require("mqtt");
const { Client } = require("pg");
const fs = require("fs").promises;
const path = require("path");
require("dotenv").config();

// ---------------- Config ----------------
const MQTT_BROKER = process.env.MQTT_BROKER || "mqtt://192.168.9.226";
const DEVICE_ID = process.env.DEVICE_ID || "c0619ab786e2";

// Database configuration
const DB_CONFIG = {
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
};

const LOG_FILE = path.join(__dirname, "../logs/victron-collection22.log");

// ---------------- Database Setup ----------------
const dbClient = new Client(DB_CONFIG);

// MQTT Topics to monitor (updated based on actual available topics)
const MQTT_TOPICS = {
  // Battery data from VE.Bus (actual available topics)
  BATTERY_SOC: `N/${DEVICE_ID}/vebus/276/Soc`,
  BATTERY_VOLTAGE: `N/${DEVICE_ID}/system/0/Dc/Battery/Voltage`,
  BATTERY_CURRENT: `N/${DEVICE_ID}/system/0/Dc/Battery/Current`,
  BATTERY_POWER: `N/${DEVICE_ID}/system/0/Dc/Battery/Power`,
  
  // PV data (keeping existing as they may be correct)
  PV_POWER: `N/${DEVICE_ID}/system/0/Dc/Pv/Power`,
  PV_VOLTAGE: `N/${DEVICE_ID}/system/0/Dc/Pv/Voltage`,
  PV_CURRENT: `N/${DEVICE_ID}/system/0/Dc/Pv/Current`,
  
  // Grid data (keeping existing as they are working)
  GRID_POWER_L1: `N/${DEVICE_ID}/system/0/Ac/Consumption/L1/Power`,
  GRID_POWER_L2: `N/${DEVICE_ID}/system/0/Ac/Consumption/L2/Power`,
  GRID_POWER_L3: `N/${DEVICE_ID}/system/0/Ac/Consumption/L3/Power`,
  GRID_VOLTAGE_L1: `N/${DEVICE_ID}/system/0/Ac/ConsumptionOnOutput/L1/Voltage`,
  GRID_FREQUENCY: `N/${DEVICE_ID}/system/0/Ac/ConsumptionOnOutput/L1/Frequency`,
  
  // Inverter data (updated to use VE.Bus paths)
  INVERTER_POWER: `N/${DEVICE_ID}/vebus/276/Ac/Out/L1/P`,
  INVERTER_VOLTAGE: `N/${DEVICE_ID}/vebus/276/Ac/Out/L1/V`,
  INVERTER_CURRENT: `N/${DEVICE_ID}/vebus/276/Ac/Out/L1/I`,
  
  // System events (updated to use actual available topics)
  SYSTEM_STATE: `N/${DEVICE_ID}/vebus/276/State`,
  ESS_MODE: `N/${DEVICE_ID}/vebus/276/Mode`,
  VEBUS_ERROR: `N/${DEVICE_ID}/vebus/276/VebusError`,
};


// ---------------- Database Setup ----------------

// Note: Database schema must be created first by running: node db-schema.js

// ---------------- Logging Helper ----------------
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
  try {
    await fs.appendFile(LOG_FILE, entry);
    console.log(entry.trim());
  } catch (err) {
    console.error(`Failed to write log: ${err.message}`);
  }
}

// ---------------- Database Functions ----------------
async function getTableCounts() {
  const tables = ['victron_metrics', 'victron_battery_data', 'victron_pv_data', 'victron_grid_data', 'victron_inverter_data', 'victron_system_events'];
  const counts = {};
  
  // Check if client is connected
  if (!dbClient || dbClient._ending) {
    log("Database client is not available or has been ended", "WARN");
    tables.forEach(table => counts[table] = 'UNAVAILABLE');
    return counts;
  }
  
  for (const table of tables) {
    try {
      const result = await dbClient.query(`SELECT COUNT(*) FROM ${table}`);
      counts[table] = parseInt(result.rows[0].count);
    } catch (err) {
      log(`Failed to get count for ${table}: ${err.message}`, "ERROR");
      counts[table] = 'ERROR';
    }
  }
  
  return counts;
}

async function logTableCounts(prefix = "") {
  const counts = await getTableCounts();
  const countString = Object.entries(counts)
    .map(([table, count]) => `${table.replace('victron_', '')}=${count}`)
    .join(', ');
  log(`${prefix}Table counts: ${countString}`, "INFO");
  return counts;
}

async function testDatabaseConnection() {
  try {
    log(`Attempting to connect to database: ${DB_CONFIG.database}@${DB_CONFIG.host}:${DB_CONFIG.port} as ${DB_CONFIG.user}`, "INFO");
    await dbClient.connect();
    await dbClient.query('SELECT NOW()');
    log("Database connection successful", "INFO");
    
    // Check if tables exist
    const result = await dbClient.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name LIKE 'victron_%'
      ORDER BY table_name;
    `);
    
    if (result.rows.length === 0) {
      log("No Victron tables found. Please run the SQL schema file first:", "WARN");
      log("psql -d victron -f victron-schema.sql", "WARN");
    } else {
      log(`Found ${result.rows.length} Victron tables: ${result.rows.map(r => r.table_name).join(', ')}`, "INFO");
    }
    
    // Log initial table counts
    await logTableCounts("STARTUP - ");
    
  } catch (err) {
    log(`Failed to connect to database: ${err.message}`, "ERROR");
    log(`Connection details: ${DB_CONFIG.user}@${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}`, "ERROR");
    
    if (err.code === 'ECONNREFUSED') {
      log("Connection refused. Check if PostgreSQL is running on the specified port.", "ERROR");
    } else if (err.code === '3D000') {
      log(`Database '${DB_CONFIG.database}' does not exist. Create it first.`, "ERROR");
    } else if (err.code === '28P01') {
      log("Authentication failed. Check username/password in .env file.", "ERROR");
    }
    
    throw err;
  }
}

async function insertMetric(deviceId, metricType, metricName, value, unit, rawTopic) {
  // Skip if shutting down or client is closed
  if (isShuttingDown || !dbClient || dbClient._ending) {
    return;
  }
  
  const query = `
    INSERT INTO victron_metrics (device_id, metric_type, metric_name, value, unit, raw_topic)
    VALUES ($1, $2, $3, $4, $5, $6)
  `;
  
  try {
    await dbClient.query(query, [deviceId, metricType, metricName, value, unit, rawTopic]);
    log(`Inserted metric: ${metricType}.${metricName} = ${value} ${unit || ''}`, "DEBUG");
  } catch (err) {
    log(`Failed to insert metric: ${err.message}`, "ERROR");
  }
}

// System events insertion function
async function insertSystemEvent(eventType, eventValue, mqttTopic) {
  // Skip if shutting down or client is closed
  if (isShuttingDown || !dbClient || dbClient._ending) {
    return;
  }
  
  const query = `
    INSERT INTO victron_system_events (device_id, event_type, event_value, mqtt_topic)
    VALUES ($1, $2, $3, $4)
  `;
  
  try {
    await dbClient.query(query, [DEVICE_ID, eventType, eventValue, mqttTopic]);
    log(`Inserted system event: ${eventType} = ${eventValue}`, "DEBUG");
  } catch (err) {
    log(`Failed to insert system event: ${err.message}`, "ERROR");
  }
}

// Specialized insert functions for structured data
const batteryData = { soc: null, voltage: null, current: null, power: null };
const pvData = { power: null, voltage: null, current: null };
const gridData = { power_l1: null, power_l2: null, power_l3: null, voltage_l1: null, frequency: null };
const inverterData = { power: null, voltage: null, current: null };

async function insertBatteryData() {
  if (Object.values(batteryData).some(v => v !== null)) {
    const query = `
      INSERT INTO victron_battery_data (device_id, soc, voltage, current, power)
      VALUES ($1, $2, $3, $4, $5)
    `;
    
    try {
      await dbClient.query(query, [DEVICE_ID, batteryData.soc, batteryData.voltage, batteryData.current, batteryData.power]);
      log(`Inserted battery data: SOC=${batteryData.soc}%, V=${batteryData.voltage}V, I=${batteryData.current}A, P=${batteryData.power}W`, "DEBUG");
    } catch (err) {
      log(`Failed to insert battery data: ${err.message}`, "ERROR");
    }
  }
}

async function insertPvData() {
  if (Object.values(pvData).some(v => v !== null)) {
    const query = `
      INSERT INTO victron_pv_data (device_id, power, voltage, current)
      VALUES ($1, $2, $3, $4)
    `;
    
    try {
      await dbClient.query(query, [DEVICE_ID, pvData.power, pvData.voltage, pvData.current]);
      log(`Inserted PV data: P=${pvData.power}W, V=${pvData.voltage}V, I=${pvData.current}A`, "DEBUG");
    } catch (err) {
      log(`Failed to insert PV data: ${err.message}`, "ERROR");
    }
  }
}

async function insertGridData() {
  if (Object.values(gridData).some(v => v !== null)) {
    const query = `
      INSERT INTO victron_grid_data (device_id, power_l1, power_l2, power_l3, voltage_l1, frequency)
      VALUES ($1, $2, $3, $4, $5, $6)
    `;
    
    try {
      await dbClient.query(query, [DEVICE_ID, gridData.power_l1, gridData.power_l2, gridData.power_l3, gridData.voltage_l1, gridData.frequency]);
      log(`Inserted grid data: P_L1=${gridData.power_l1}W, V_L1=${gridData.voltage_l1}V, F=${gridData.frequency}Hz`, "DEBUG");
    } catch (err) {
      log(`Failed to insert grid data: ${err.message}`, "ERROR");
    }
  }
}

async function insertInverterData() {
  if (Object.values(inverterData).some(v => v !== null)) {
    const query = `
      INSERT INTO victron_inverter_data (device_id, power, voltage, current)
      VALUES ($1, $2, $3, $4)
    `;
    
    try {
      await dbClient.query(query, [DEVICE_ID, inverterData.power, inverterData.voltage, inverterData.current]);
      log(`Inserted inverter data: P=${inverterData.power}W, V=${inverterData.voltage}V, I=${inverterData.current}A`, "DEBUG");
    } catch (err) {
      log(`Failed to insert inverter data: ${err.message}`, "ERROR");
    }
  }
}

// ---------------- MQTT Client ----------------
const mqttClient = mqtt.connect(MQTT_BROKER, { 
  reconnectPeriod: 5000,
  clientId: `victron-logger-${Math.random().toString(16).substr(2, 8)}`
});

mqttClient.on("connect", () => {
  log("Connected to MQTT broker for data logging", "INFO");
  
  // Subscribe to all topics
  const topics = Object.values(MQTT_TOPICS);
  mqttClient.subscribe(topics, (err) => {
    if (err) {
      log(`Error subscribing to topics: ${err.message}`, "ERROR");
    } else {
      log(`Subscribed to ${topics.length} MQTT topics for data logging`, "INFO");
      log(`Topics: ${topics.join(', ')}`, "DEBUG");
    }
  });
});

mqttClient.on("reconnect", () => log("Reconnecting to MQTT broker", "WARN"));

mqttClient.on("message", async (topic, message) => {
  // Skip processing if shutting down
  if (isShuttingDown) {
    return;
  }
  
  try {
    log(`Received message on ${topic}: ${message.toString()}`, "DEBUG");
    const data = JSON.parse(message.toString());
    
    if (typeof data.value !== "number") {
      log(`Invalid data on ${topic}: ${message.toString()}`, "WARN");
      return;
    }

    const value = data.value;
    const timestamp = new Date();
    log(`Processing ${topic}: ${value}`, "DEBUG");

    // Process different metric types
    switch (topic) {
      // Battery metrics
      case MQTT_TOPICS.BATTERY_SOC:
        batteryData.soc = value;
        await insertMetric(DEVICE_ID, "battery", "soc", value, "%", topic);
        break;
      case MQTT_TOPICS.BATTERY_VOLTAGE:
        batteryData.voltage = value;
        await insertMetric(DEVICE_ID, "battery", "voltage", value, "V", topic);
        break;
      case MQTT_TOPICS.BATTERY_CURRENT:
        batteryData.current = value;
        await insertMetric(DEVICE_ID, "battery", "current", value, "A", topic);
        break;
      case MQTT_TOPICS.BATTERY_POWER:
        batteryData.power = value;
        await insertMetric(DEVICE_ID, "battery", "power", value, "W", topic);
        break;

      // PV metrics
      case MQTT_TOPICS.PV_POWER:
        pvData.power = value;
        await insertMetric(DEVICE_ID, "pv", "power", value, "W", topic);
        break;
      case MQTT_TOPICS.PV_VOLTAGE:
        pvData.voltage = value;
        await insertMetric(DEVICE_ID, "pv", "voltage", value, "V", topic);
        break;
      case MQTT_TOPICS.PV_CURRENT:
        pvData.current = value;
        await insertMetric(DEVICE_ID, "pv", "current", value, "A", topic);
        break;

      // Grid metrics
      case MQTT_TOPICS.GRID_POWER_L1:
        gridData.power_l1 = value;
        await insertMetric(DEVICE_ID, "grid", "power_l1", value, "W", topic);
        break;
      case MQTT_TOPICS.GRID_POWER_L2:
        gridData.power_l2 = value;
        await insertMetric(DEVICE_ID, "grid", "power_l2", value, "W", topic);
        break;
      case MQTT_TOPICS.GRID_POWER_L3:
        gridData.power_l3 = value;
        await insertMetric(DEVICE_ID, "grid", "power_l3", value, "W", topic);
        break;
      case MQTT_TOPICS.GRID_VOLTAGE_L1:
        gridData.voltage_l1 = value;
        await insertMetric(DEVICE_ID, "grid", "voltage_l1", value, "V", topic);
        break;
      case MQTT_TOPICS.GRID_FREQUENCY:
        gridData.frequency = value;
        await insertMetric(DEVICE_ID, "grid", "frequency", value, "Hz", topic);
        break;

      // Inverter metrics
      case MQTT_TOPICS.INVERTER_POWER:
        inverterData.power = value;
        await insertMetric(DEVICE_ID, "inverter", "power", value, "W", topic);
        break;
      case MQTT_TOPICS.INVERTER_VOLTAGE:
        inverterData.voltage = value;
        await insertMetric(DEVICE_ID, "inverter", "voltage", value, "V", topic);
        break;
      case MQTT_TOPICS.INVERTER_CURRENT:
        inverterData.current = value;
        await insertMetric(DEVICE_ID, "inverter", "current", value, "A", topic);
        break;

      // System metrics
      case MQTT_TOPICS.SYSTEM_STATE:
        await insertMetric(DEVICE_ID, "system", "state", value, null, topic);
        await insertSystemEvent("state_change", value, topic);
        break;
      case MQTT_TOPICS.ESS_MODE:
        await insertMetric(DEVICE_ID, "system", "ess_mode", value, null, topic);
        await insertSystemEvent("mode_change", value, topic);
        break;
      case MQTT_TOPICS.VEBUS_ERROR:
        await insertMetric(DEVICE_ID, "system", "vebus_error", value, null, topic);
        await insertSystemEvent("vebus_error", value, topic);
        break;

      default:
        log(`Unknown topic: ${topic}`, "WARN");
    }

  } catch (err) {
    log(`Failed to process message on ${topic}: ${err.message}`, "ERROR");
  }
});

mqttClient.on("error", (err) => log(`MQTT Error: ${err.message}`, "ERROR"));
mqttClient.on("offline", () => log("MQTT offline", "WARN"));

// ---------------- Periodic Data Insertion ----------------
// Insert structured data every 30 seconds
setInterval(async () => {
  try {
    log("=== PERIODIC INSERTION STARTING ===", "INFO");
    const beforeCounts = await logTableCounts("BEFORE - ");
    
    await insertBatteryData();
    await insertPvData();
    await insertGridData();
    await insertInverterData();
    
    const afterCounts = await logTableCounts("AFTER - ");
    
    // Log changes
    const changes = [];
    Object.keys(beforeCounts).forEach(table => {
      const before = beforeCounts[table];
      const after = afterCounts[table];
      if (before !== 'ERROR' && after !== 'ERROR' && after > before) {
        changes.push(`${table.replace('victron_', '')}:+${after - before}`);
      }
    });
    
    if (changes.length > 0) {
      log(`Changes: ${changes.join(', ')}`, "INFO");
    } else {
      log("No data inserted this cycle", "WARN");
    }
    
    // Reset data objects
    Object.keys(batteryData).forEach(key => batteryData[key] = null);
    Object.keys(pvData).forEach(key => pvData[key] = null);
    Object.keys(gridData).forEach(key => gridData[key] = null);
    Object.keys(inverterData).forEach(key => inverterData[key] = null);
    
    log("=== PERIODIC INSERTION COMPLETE ===", "INFO");
  } catch (err) {
    log(`Error in periodic data insertion: ${err.message}`, "ERROR");
  }
}, 30000);

// ---------------- Cleanup ----------------
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    log(`Already shutting down, ignoring ${signal}`, "WARN");
    return;
  }
  isShuttingDown = true;
  
  log(`Shutting down Victron data logger (${signal})...`, "INFO");
  
  try {
    // Log table counts before closing database connection
    await logTableCounts("SHUTDOWN - ");
  } catch (err) {
    log(`Error logging shutdown table counts: ${err.message}`, "ERROR");
  }
  
  try {
    // Close MQTT connection
    if (mqttClient) {
      mqttClient.end();
    }
  } catch (err) {
    log(`Error closing MQTT connection: ${err.message}`, "ERROR");
  }
  
  try {
    // Close database client
    if (dbClient && !dbClient._ending) {
      await dbClient.end();
    }
  } catch (err) {
    log(`Error closing database client: ${err.message}`, "ERROR");
  }
  
  log("Shutdown complete", "INFO");
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// ---------------- Startup ----------------
async function startup() {
  try {
    log("Starting Victron MQTT Data Logger", "INFO");
    await testDatabaseConnection();
    log("Database initialization complete", "INFO");
    log("Connecting to MQTT broker...", "INFO");
    log("Victron data logger initialized successfully", "INFO");
  } catch (err) {
    log(`Failed to start data logger: ${err.message}`, "ERROR");
    log(`Error stack: ${err.stack}`, "ERROR");
    process.exit(1);
  }
}

// Add unhandled error catching
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  log(`Uncaught Exception: ${err.message}`, "ERROR");
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  log(`Unhandled Rejection: ${reason}`, "ERROR");
});

startup();
