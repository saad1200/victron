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
  
  // Individual PV array topics
  PV_ARRAY_0_POWER: `N/${DEVICE_ID}/solarcharger/0/Pv/0/P`,
  PV_ARRAY_0_VOLTAGE: `N/${DEVICE_ID}/solarcharger/0/Pv/0/V`,
  PV_ARRAY_1_POWER: `N/${DEVICE_ID}/solarcharger/0/Pv/1/P`,
  PV_ARRAY_1_VOLTAGE: `N/${DEVICE_ID}/solarcharger/0/Pv/1/V`,
  PV_ARRAY_2_POWER: `N/${DEVICE_ID}/solarcharger/0/Pv/2/P`,
  PV_ARRAY_2_VOLTAGE: `N/${DEVICE_ID}/solarcharger/0/Pv/2/V`,
  PV_ARRAY_3_POWER: `N/${DEVICE_ID}/solarcharger/0/Pv/3/P`,
  PV_ARRAY_3_VOLTAGE: `N/${DEVICE_ID}/solarcharger/0/Pv/3/V`,
  
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

// PV array state variables
const pvArrays = {
  0: { power: 0, voltage: 0 },
  1: { power: 0, voltage: 0 },
  2: { power: 0, voltage: 0 },
  3: { power: 0, voltage: 0 }
};

// Energy tracking variables
let lastEnergyReading = {
  timestamp: Date.now(),
  gridImport: 0,
  gridExport: 0,
  solarGeneration: 0,
  batteryCharge: 0,
  batteryDischarge: 0,
  loadConsumption: 0
};

// Current system state for energy tracking
let currentSOC = 0;
let gridPower = 0;
let solarPower = 0;
let loadPower = 0;
let currentPower = 0;
let currentTariffPeriod = null;

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

// Collect PV array data and store in database
async function collectPvArrayData() {
  try {
    // Only collect if we have valid data
    const totalPower = Object.values(pvArrays).reduce((sum, array) => sum + array.power, 0);
    if (totalPower === 0) return; // Skip if no solar generation
    
    for (let arrayId = 0; arrayId < 4; arrayId++) {
      const array = pvArrays[arrayId];
      if (array.power > 0) { // Only store arrays with active generation
        const query = `
          INSERT INTO victron_pv_arrays (
            device_id, array_id, power_watts, voltage_volts
          ) VALUES ($1, $2, $3, $4)
        `;
        
        await dbClient.query(query, [
          DEVICE_ID,
          arrayId,
          array.power,
          array.voltage
        ]);
      }
    }
    
    log(`PV arrays data collected: Array0=${pvArrays[0].power}W, Array1=${pvArrays[1].power}W, Array2=${pvArrays[2].power}W, Array3=${pvArrays[3].power}W`);
    
  } catch (error) {
    log(`PV array data collection error: ${error.message}`, "ERROR");
  }
}

// Energy tracking function moved from controller
async function trackEnergyUsage() {
  try {
    if (!currentTariffPeriod) return; // Skip if no tariff period loaded
    
    const now = Date.now();
    const timeDiffHours = (now - lastEnergyReading.timestamp) / (1000 * 60 * 60);
    
    if (timeDiffHours < 0.01) return; // Skip if less than 36 seconds
    
    // Get current tariff config (simplified - would need to load from DB)
    const tariffRates = {
      'Day': { importRate: 31.488, exportRate: 10.2 },
      'Evening': { importRate: 31.488, exportRate: 10.2 },
      'Night': { importRate: 14.877, exportRate: 10.2 },
      'PEAK': { importRate: 31.488, exportRate: 10.2 }
    };
    
    const tariffConfig = tariffRates[currentTariffPeriod] || tariffRates['Day'];
    
    // Calculate energy deltas (kWh)
    const gridImportKwh = Math.max(0, gridPower) * timeDiffHours / 1000;
    const gridExportKwh = Math.max(0, -gridPower) * timeDiffHours / 1000;
    const solarKwh = Math.max(0, solarPower) * timeDiffHours / 1000;
    const batteryChargeKwh = Math.max(0, currentPower) * timeDiffHours / 1000;
    const batteryDischargeKwh = Math.max(0, -currentPower) * timeDiffHours / 1000;
    const loadKwh = Math.max(0, loadPower) * timeDiffHours / 1000;
    
    // Calculate costs and earnings (pence)
    const importCost = gridImportKwh * tariffConfig.importRate;
    const exportEarnings = gridExportKwh * tariffConfig.exportRate;
    const netCost = importCost - exportEarnings;
    
    const query = `
      INSERT INTO victron_energy_tracking (
        device_id, tariff_period, import_rate_pence, export_rate_pence,
        grid_import_kwh, grid_export_kwh, solar_generation_kwh,
        battery_charge_kwh, battery_discharge_kwh, load_consumption_kwh,
        import_cost_pence, export_earnings_pence, net_cost_pence,
        battery_soc_start, battery_soc_end
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    `;
    
    await dbClient.query(query, [
      DEVICE_ID, currentTariffPeriod, tariffConfig.importRate, tariffConfig.exportRate,
      gridImportKwh, gridExportKwh, solarKwh,
      batteryChargeKwh, batteryDischargeKwh, loadKwh,
      importCost, exportEarnings, netCost,
      lastEnergyReading.soc || currentSOC, currentSOC
    ]);
    
    // Update last reading
    lastEnergyReading = {
      timestamp: now,
      soc: currentSOC,
      gridImport: gridImportKwh,
      gridExport: gridExportKwh,
      solarGeneration: solarKwh
    };
    
    log(`Energy tracked: Import ${gridImportKwh.toFixed(3)}kWh (${importCost.toFixed(2)}p), Export ${gridExportKwh.toFixed(3)}kWh (${exportEarnings.toFixed(2)}p), Net: ${netCost.toFixed(2)}p`);
    
  } catch (error) {
    log(`Energy tracking error: ${error.message}`, "ERROR");
  }
}

// Initialize data collection
async function initializeDataCollection() {
  try {
    await dbClient.connect();
    log('Database connected successfully');
    
    // Get initial tariff period
    await getCurrentTariffPeriod();
    
    // Initialize MQTT client
    mqttClient = mqtt.connect(MQTT_BROKER);
    
    mqttClient.on('connect', () => {
      log('Connected to MQTT broker');
      
      // Subscribe to all topics
      Object.values(MQTT_TOPICS).forEach(topic => {
        mqttClient.subscribe(topic, (err) => {
          if (err) {
            log(`Failed to subscribe to ${topic}: ${err.message}`, "ERROR");
          }
        });
      });
      
      log(`Subscribed to ${Object.keys(MQTT_TOPICS).length} monitoring topics`);
    });
  } catch (error) {
    log(`Failed to initialize data collection: ${error.message}`, "ERROR");
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
        solarPower = value; // Update for energy tracking
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

      // PV Array power readings
      case MQTT_TOPICS.PV_ARRAY_0_POWER:
        pvArrays[0].power = value;
        break;
      case MQTT_TOPICS.PV_ARRAY_0_VOLTAGE:
        pvArrays[0].voltage = value;
        break;
      case MQTT_TOPICS.PV_ARRAY_1_POWER:
        pvArrays[1].power = value;
        break;
      case MQTT_TOPICS.PV_ARRAY_1_VOLTAGE:
        pvArrays[1].voltage = value;
        break;
      case MQTT_TOPICS.PV_ARRAY_2_POWER:
        pvArrays[2].power = value;
        break;
      case MQTT_TOPICS.PV_ARRAY_2_VOLTAGE:
        pvArrays[2].voltage = value;
        break;
      case MQTT_TOPICS.PV_ARRAY_3_POWER:
        pvArrays[3].power = value;
        break;
      case MQTT_TOPICS.PV_ARRAY_3_VOLTAGE:
        pvArrays[3].voltage = value;
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

// Periodic PV array data collection (every 30 seconds)
setInterval(async () => {
  await collectPvArrayData();
}, 30000);

// Periodic energy tracking (every 5 minutes)
setInterval(async () => {
  await trackEnergyUsage();
}, 300000);

// Get current tariff period and configuration from database
async function getCurrentTariffPeriod() {
  try {
    const now = new Date();
    const currentTime = now.toTimeString().slice(0, 5); // HH:MM format
    
    const query = `
      SELECT 
        vtp.period_name,
        vtp.import_rate_pence,
        vtp.export_rate_pence,
        vtp.start_time,
        vtp.end_time
      FROM victron_tariff_periods vtp 
      WHERE vtp.is_active = true
        AND (
          -- Handle overnight periods (start_time > end_time)
          (vtp.start_time > vtp.end_time AND ($1::time >= vtp.start_time OR $1::time < vtp.end_time))
          OR
          -- Handle normal periods (start_time <= end_time)  
          (vtp.start_time <= vtp.end_time AND $1::time >= vtp.start_time AND $1::time < vtp.end_time)
        )
      ORDER BY 
        CASE 
          WHEN vtp.start_time > vtp.end_time THEN 1 
          ELSE 0 
        END,
        vtp.start_time
      LIMIT 1
    `;
    
    const result = await dbClient.query(query, [currentTime]);
    
    if (result.rows.length > 0) {
      const period = result.rows[0];
      currentTariffPeriod = period.period_name;
      log(`Current tariff period: ${currentTariffPeriod} (${period.start_time}-${period.end_time})`, "INFO");
      return currentTariffPeriod;
    } else {
      log(`No active tariff period found for time ${currentTime}`, "WARN");
      currentTariffPeriod = 'Day'; // Default fallback
      return currentTariffPeriod;
    }
  } catch (err) {
    log(`Error getting current tariff period: ${err.message}`, "ERROR");
    currentTariffPeriod = 'Day'; // Default fallback
    return currentTariffPeriod;
  }
}

// Periodic tariff period check (every minute)
setInterval(async () => {
  await getCurrentTariffPeriod();
}, 60000);

// ---------------- Shutdown Handler ----------------
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
