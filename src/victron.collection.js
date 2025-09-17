/**
 * Victron MQTT Data Collector
 * Pure data collection - receives MQTT messages and inserts immediately to database
 * No calculations or logic - just raw data storage
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

const LOG_FILE = path.join(__dirname, "../logs/victron-collection.log");

// ---------------- Database Setup ----------------
const dbClient = new Client(DB_CONFIG);
let mqttClient;
let isShuttingDown = false;

// MQTT Topics to monitor
const MQTT_TOPICS = {
  // Battery data
  BATTERY_SOC: `N/${DEVICE_ID}/vebus/276/Soc`,
  BATTERY_VOLTAGE: `N/${DEVICE_ID}/system/0/Dc/Battery/Voltage`,
  BATTERY_CURRENT: `N/${DEVICE_ID}/system/0/Dc/Battery/Current`,
  BATTERY_POWER: `N/${DEVICE_ID}/system/0/Dc/Battery/Power`,
  
  // PV data
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
  
  // Grid data
  GRID_POWER_L1: `N/${DEVICE_ID}/system/0/Ac/Grid/L1/Power`,
  GRID_POWER_L2: `N/${DEVICE_ID}/system/0/Ac/Grid/L2/Power`,
  GRID_POWER_L3: `N/${DEVICE_ID}/system/0/Ac/Grid/L3/Power`,
  GRID_VOLTAGE_L1: `N/${DEVICE_ID}/system/0/Ac/Grid/L1/Voltage`,
  GRID_FREQUENCY: `N/${DEVICE_ID}/system/0/Ac/Grid/L1/Frequency`,
  
  // Inverter data
  INVERTER_POWER: `N/${DEVICE_ID}/vebus/276/Ac/Out/L1/P`,
  INVERTER_VOLTAGE: `N/${DEVICE_ID}/vebus/276/Ac/Out/L1/V`,
  INVERTER_CURRENT: `N/${DEVICE_ID}/vebus/276/Ac/Out/L1/I`,
  
  // System events
  VEBUS_ERROR: `N/${DEVICE_ID}/vebus/276/VebusError`
};

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

// ---------------- Database Functions ----------------
async function insertMetric(deviceId, category, metric, value, unit, topic) {
  try {
    const query = `
      INSERT INTO victron_metrics (device_id, metric_type, metric_name, value, unit, raw_topic, timestamp)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `;
    await dbClient.query(query, [deviceId, category, metric, value, unit, topic]);
  } catch (err) {
    log(`Failed to insert metric ${category}.${metric}: ${err.message}`, "ERROR");
  }
}

// Real-time data insertion functions
async function insertBatteryDataPoint(soc, voltage, current, power, timestamp) {
  try {
    const query = `
      INSERT INTO victron_battery_data (timestamp, device_id, soc, voltage, current, power)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (timestamp, device_id) DO UPDATE SET
        soc = COALESCE(EXCLUDED.soc, victron_battery_data.soc),
        voltage = COALESCE(EXCLUDED.voltage, victron_battery_data.voltage),
        current = COALESCE(EXCLUDED.current, victron_battery_data.current),
        power = COALESCE(EXCLUDED.power, victron_battery_data.power)
    `;
    await dbClient.query(query, [timestamp, DEVICE_ID, soc, voltage, current, power]);
  } catch (err) {
    log(`Error inserting battery data: ${err.message}`, "ERROR");
  }
}

async function insertPvDataPoint(power, voltage, current, timestamp) {
  try {
    const query = `
      INSERT INTO victron_pv_data (timestamp, device_id, power, voltage, current)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (timestamp, device_id) DO UPDATE SET
        power = EXCLUDED.power,
        voltage = EXCLUDED.voltage,
        current = EXCLUDED.current
    `;
    await dbClient.query(query, [timestamp, DEVICE_ID, power, voltage, current]);
  } catch (err) {
    log(`Error inserting PV data: ${err.message}`, "ERROR");
  }
}

async function insertPvArrayDataPoint(arrayId, power, voltage, timestamp) {
  try {
    const query = `
      INSERT INTO victron_pv_arrays (timestamp, device_id, array_id, power_watts, voltage_volts)
      VALUES ($1, $2, $3, $4, $5)
    `;
    await dbClient.query(query, [timestamp, DEVICE_ID, arrayId, power, voltage]);
  } catch (err) {
    log(`Error inserting PV array data: ${err.message}`, "ERROR");
  }
}

async function insertGridDataPoint(power_l1, power_l2, power_l3, voltage_l1, voltage_l2, voltage_l3, timestamp) {
  try {
    // Only insert columns that exist in the current schema
    const query = `
      INSERT INTO victron_grid_data (timestamp, device_id, power_l1, power_l2, power_l3, voltage_l1, frequency)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;
    await dbClient.query(query, [timestamp, DEVICE_ID, power_l1, power_l2, power_l3, voltage_l1, null]);
  } catch (err) {
    log(`Error inserting grid data: ${err.message}`, "ERROR");
  }
}

async function insertInverterDataPoint(power, voltage, current, timestamp) {
  try {
    const query = `
      INSERT INTO victron_inverter_data (timestamp, device_id, power, voltage, current)
      VALUES ($1, $2, $3, $4, $5)
    `;
    await dbClient.query(query, [timestamp, DEVICE_ID, power, voltage, current]);
  } catch (err) {
    log(`Error inserting inverter data: ${err.message}`, "ERROR");
  }
}

async function insertSystemEvent(event, value, timestamp) {
  try {
    const query = `
      INSERT INTO victron_system_events (timestamp, device_id, event_type, event_value, description)
      VALUES ($1, $2, $3, $4, $5)
    `;
    const description = `${event} = ${value}`;
    await dbClient.query(query, [timestamp, DEVICE_ID, event, value, description]);
    // log(`Inserted system event: ${description}`, "DEBUG");
  } catch (err) {
    log(`Error inserting system event: ${err.message}`, "ERROR");
  }
}

// ---------------- MQTT Setup ----------------
async function connectDatabase() {
  try {
    await dbClient.connect();
    log("Connected to PostgreSQL database");
  } catch (err) {
    log(`Failed to connect to database: ${err.message}`, "ERROR");
    process.exit(1);
  }
}

function setupMQTT() {
  mqttClient = mqtt.connect(MQTT_BROKER);

  mqttClient.on("connect", () => {
    log("Connected to MQTT broker");
    
    // Subscribe to all topics
    Object.values(MQTT_TOPICS).forEach(topic => {
      mqttClient.subscribe(topic, (err) => {
        if (err) {
          log(`Failed to subscribe to ${topic}: ${err.message}`, "ERROR");
        } else {
          // log(`Subscribed to ${topic}`, "DEBUG");
        }
      });
    });
  });

  mqttClient.on("reconnect", () => log("Reconnecting to MQTT broker", "WARN"));

  mqttClient.on("message", async (topic, message) => {
    if (isShuttingDown) return;
    
    try {
      // log(`Received message on ${topic}: ${message.toString()}`, "DEBUG");
      const data = JSON.parse(message.toString());
      
      if (typeof data.value !== "number" || data.value === null || isNaN(data.value)) {
        // log(`Invalid data on ${topic}: ${message.toString()}`, "WARN");
        return;
      }

      const value = data.value;
      const timestamp = new Date();
      // log(`Processing ${topic}: ${value}`, "DEBUG");

      // Process different metric types - insert immediately to database
      switch (topic) {
        // Battery metrics
        case MQTT_TOPICS.BATTERY_SOC:
          await insertMetric(DEVICE_ID, "battery", "soc", value, "%", topic);
          await insertBatteryDataPoint(value, null, null, null, timestamp);
          break;
        case MQTT_TOPICS.BATTERY_VOLTAGE:
          await insertMetric(DEVICE_ID, "battery", "voltage", value, "V", topic);
          await insertBatteryDataPoint(null, value, null, null, timestamp);
          break;
        case MQTT_TOPICS.BATTERY_CURRENT:
          await insertMetric(DEVICE_ID, "battery", "current", value, "A", topic);
          await insertBatteryDataPoint(null, null, value, null, timestamp);
          break;
        case MQTT_TOPICS.BATTERY_POWER:
          await insertMetric(DEVICE_ID, "battery", "power", value, "W", topic);
          await insertBatteryDataPoint(null, null, null, value, timestamp);
          break;

        // PV metrics
        case MQTT_TOPICS.PV_POWER:
          await insertMetric(DEVICE_ID, "pv", "power", value, "W", topic);
          await insertPvDataPoint(value, null, null, timestamp);
          break;
        case MQTT_TOPICS.PV_VOLTAGE:
          await insertMetric(DEVICE_ID, "pv", "voltage", value, "V", topic);
          await insertPvDataPoint(null, value, null, timestamp);
          break;
        case MQTT_TOPICS.PV_CURRENT:
          await insertMetric(DEVICE_ID, "pv", "current", value, "A", topic);
          await insertPvDataPoint(null, null, value, timestamp);
          break;

        // PV Array power readings
        case MQTT_TOPICS.PV_ARRAY_0_POWER:
          await insertPvArrayDataPoint(0, value, null, timestamp);
          break;
        case MQTT_TOPICS.PV_ARRAY_0_VOLTAGE:
          await insertPvArrayDataPoint(0, null, value, timestamp);
          break;
        case MQTT_TOPICS.PV_ARRAY_1_POWER:
          await insertPvArrayDataPoint(1, value, null, timestamp);
          break;
        case MQTT_TOPICS.PV_ARRAY_1_VOLTAGE:
          await insertPvArrayDataPoint(1, null, value, timestamp);
          break;
        case MQTT_TOPICS.PV_ARRAY_2_POWER:
          await insertPvArrayDataPoint(2, value, null, timestamp);
          break;
        case MQTT_TOPICS.PV_ARRAY_2_VOLTAGE:
          await insertPvArrayDataPoint(2, null, value, timestamp);
          break;
        case MQTT_TOPICS.PV_ARRAY_3_POWER:
          await insertPvArrayDataPoint(3, value, null, timestamp);
          break;
        case MQTT_TOPICS.PV_ARRAY_3_VOLTAGE:
          await insertPvArrayDataPoint(3, null, value, timestamp);
          break;

        // Grid metrics
        case MQTT_TOPICS.GRID_POWER_L1:
          await insertMetric(DEVICE_ID, "grid", "power_l1", value, "W", topic);
          await insertGridDataPoint(value, null, null, null, null, null, timestamp);
          break;
        case MQTT_TOPICS.GRID_POWER_L2:
          await insertMetric(DEVICE_ID, "grid", "power_l2", value, "W", topic);
          await insertGridDataPoint(null, value, null, null, null, null, timestamp);
          break;
        case MQTT_TOPICS.GRID_POWER_L3:
          await insertMetric(DEVICE_ID, "grid", "power_l3", value, "W", topic);
          await insertGridDataPoint(null, null, value, null, null, null, timestamp);
          break;
        case MQTT_TOPICS.GRID_VOLTAGE_L1:
          await insertMetric(DEVICE_ID, "grid", "voltage_l1", value, "V", topic);
          await insertGridDataPoint(null, null, null, value, null, null, timestamp);
          break;
        case MQTT_TOPICS.GRID_FREQUENCY:
          await insertMetric(DEVICE_ID, "grid", "frequency", value, "Hz", topic);
          break;

        // Inverter metrics
        case MQTT_TOPICS.INVERTER_POWER:
          await insertMetric(DEVICE_ID, "inverter", "power", value, "W", topic);
          await insertInverterDataPoint(value, null, null, timestamp);
          break;
        case MQTT_TOPICS.INVERTER_VOLTAGE:
          await insertMetric(DEVICE_ID, "inverter", "voltage", value, "V", topic);
          await insertInverterDataPoint(null, value, null, timestamp);
          break;
        case MQTT_TOPICS.INVERTER_CURRENT:
          await insertMetric(DEVICE_ID, "inverter", "current", value, "A", topic);
          await insertInverterDataPoint(null, null, value, timestamp);
          break;

        // System events
        case MQTT_TOPICS.VEBUS_ERROR:
          await insertMetric(DEVICE_ID, "system", "vebus_error", value, "", topic);
          await insertSystemEvent("vebus_error", value, timestamp);
          break;

        // default:
          // log(`Unhandled topic: ${topic}`, "DEBUG");
      }

    } catch (err) {
      log(`Failed to process message on ${topic}: ${err.message}`, "ERROR");
    }
  });

  mqttClient.on("error", (err) => log(`MQTT Error: ${err.message}`, "ERROR"));
  mqttClient.on("offline", () => log("MQTT offline", "WARN"));
}

// ---------------- Shutdown Handler ----------------
async function gracefulShutdown() {
  log("Shutting down data collector...");
  isShuttingDown = true;
  
  if (mqttClient) {
    mqttClient.end();
  }
  
  if (dbClient) {
    await dbClient.end();
  }
  
  log("Data collector shutdown complete");
  process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// ---------------- Startup ----------------
async function startup() {
  log("Starting Victron MQTT Data Collector");
  await connectDatabase();
  setupMQTT();
  log("Data collector ready - collecting all MQTT messages in real-time");
}

startup().catch(err => {
  log(`Failed to start data collector: ${err.message}`, "ERROR");
  process.exit(1);
});
