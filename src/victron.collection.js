/**
 * Victron MQTT Data Collector
 *
 * Collects MQTT messages and buffers them in memory. Every FLUSH_INTERVAL_MS
 * (default 30 s) it writes averaged values to the database — one row per table
 * per interval. This reduces DB inserts from millions/day to ~2,880/day per table.
 *
 * Previous design:  every MQTT message → immediate DB insert → ~4-5M rows/day
 * New design:       buffer in memory → flush averages every 30s → ~90K rows/day
 *
 * victron_metrics table is NO LONGER written to (it duplicated the specific tables).
 * System events (vebus_error) are still written immediately.
 */

const mqtt = require("mqtt");
const { Client } = require("pg");
const fs = require("fs").promises;
const path = require("path");
require("dotenv").config();

// ---------------- Config ----------------
const MQTT_BROKER = process.env.MQTT_BROKER || "mqtt://192.168.9.226";
const DEVICE_ID = process.env.DEVICE_ID || "c0619ab786e2";
const EV_CHARGER_INSTANCE = process.env.EV_CHARGER_INSTANCE || '0';
const FLUSH_INTERVAL_MS = parseInt(process.env.COLLECTION_INTERVAL_MS) || 30000; // 30 seconds

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
  VEBUS_ERROR: `N/${DEVICE_ID}/vebus/276/VebusError`,

  // EV Charger (Victron EVCS)
  EV_STATUS: `N/${DEVICE_ID}/evcharger/${EV_CHARGER_INSTANCE}/Status`,
  EV_MODE: `N/${DEVICE_ID}/evcharger/${EV_CHARGER_INSTANCE}/Mode`,
  EV_POWER: `N/${DEVICE_ID}/evcharger/${EV_CHARGER_INSTANCE}/Ac/Power`,
  EV_POWER_L1: `N/${DEVICE_ID}/evcharger/${EV_CHARGER_INSTANCE}/Ac/L1/Power`,
  EV_POWER_L2: `N/${DEVICE_ID}/evcharger/${EV_CHARGER_INSTANCE}/Ac/L2/Power`,
  EV_POWER_L3: `N/${DEVICE_ID}/evcharger/${EV_CHARGER_INSTANCE}/Ac/L3/Power`,
  EV_CURRENT: `N/${DEVICE_ID}/evcharger/${EV_CHARGER_INSTANCE}/Current`,
  EV_MAX_CURRENT: `N/${DEVICE_ID}/evcharger/${EV_CHARGER_INSTANCE}/MaxCurrent`,
  EV_SET_CURRENT: `N/${DEVICE_ID}/evcharger/${EV_CHARGER_INSTANCE}/SetCurrent`,
  EV_ENERGY: `N/${DEVICE_ID}/evcharger/${EV_CHARGER_INSTANCE}/Ac/Energy/Forward`,
  EV_CHARGING_TIME: `N/${DEVICE_ID}/evcharger/${EV_CHARGER_INSTANCE}/ChargingTime`,
  EV_START_STOP: `N/${DEVICE_ID}/evcharger/${EV_CHARGER_INSTANCE}/StartStop`
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

// ---------------- Buffer ----------------
// Accumulate readings; flush() computes average and writes one row per table.

const buffer = {
  battery: { soc: [], voltage: [], current: [], power: [] },
  pv:      { power: [], voltage: [], current: [] },
  pvArrays: {}, // keyed by arrayId: { power: [], voltage: [] }
  grid:    { power_l1: [], power_l2: [], power_l3: [], voltage_l1: [], frequency: [] },
  inverter:{ power: [], voltage: [], current: [] },
  ev:      { power: [], current: [], energy: [], status: [] },
};

let msgCount = 0; // messages received since last flush

function bufferValue(arr, value) {
  if (value !== null && value !== undefined && !isNaN(value)) {
    arr.push(value);
  }
}

function avg(arr) {
  if (!arr || arr.length === 0) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function last(arr) {
  if (!arr || arr.length === 0) return null;
  return arr[arr.length - 1];
}

function resetBuffer() {
  buffer.battery = { soc: [], voltage: [], current: [], power: [] };
  buffer.pv      = { power: [], voltage: [], current: [] };
  buffer.pvArrays = {};
  buffer.grid    = { power_l1: [], power_l2: [], power_l3: [], voltage_l1: [], frequency: [] };
  buffer.inverter = { power: [], voltage: [], current: [] };
  buffer.ev      = { power: [], current: [], energy: [], status: [] };
  msgCount = 0;
}

// ---------------- Flush (write averages to DB) ----------------

async function flushBuffer() {
  if (isShuttingDown) return;
  if (msgCount === 0) return; // nothing received

  const timestamp = new Date();
  const flushed = msgCount;
  let inserts = 0;

  try {
    // Battery
    const batSoc = avg(buffer.battery.soc);
    const batVolt = avg(buffer.battery.voltage);
    const batCur = avg(buffer.battery.current);
    const batPow = avg(buffer.battery.power);
    if (batSoc !== null || batVolt !== null || batCur !== null || batPow !== null) {
      await dbClient.query(`
        INSERT INTO victron_battery_data (timestamp, device_id, soc, voltage, current, power)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (timestamp, device_id) DO UPDATE SET
          soc = COALESCE(EXCLUDED.soc, victron_battery_data.soc),
          voltage = COALESCE(EXCLUDED.voltage, victron_battery_data.voltage),
          current = COALESCE(EXCLUDED.current, victron_battery_data.current),
          power = COALESCE(EXCLUDED.power, victron_battery_data.power)
      `, [timestamp, DEVICE_ID, batSoc, batVolt, batCur, batPow]);
      inserts++;
    }

    // PV total
    const pvPow = avg(buffer.pv.power);
    const pvVolt = avg(buffer.pv.voltage);
    const pvCur = avg(buffer.pv.current);
    if (pvPow !== null || pvVolt !== null || pvCur !== null) {
      await dbClient.query(`
        INSERT INTO victron_pv_data (timestamp, device_id, power, voltage, current)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (timestamp, device_id) DO UPDATE SET
          power = COALESCE(EXCLUDED.power, victron_pv_data.power),
          voltage = COALESCE(EXCLUDED.voltage, victron_pv_data.voltage),
          current = COALESCE(EXCLUDED.current, victron_pv_data.current)
      `, [timestamp, DEVICE_ID, pvPow, pvVolt, pvCur]);
      inserts++;
    }

    // PV arrays
    for (const [arrayId, data] of Object.entries(buffer.pvArrays)) {
      const arrPow = avg(data.power);
      const arrVolt = avg(data.voltage);
      if (arrPow !== null || arrVolt !== null) {
        await dbClient.query(`
          INSERT INTO victron_pv_arrays (timestamp, device_id, array_id, power_watts, voltage_volts)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT DO NOTHING
        `, [timestamp, DEVICE_ID, parseInt(arrayId), arrPow, arrVolt]);
        inserts++;
      }
    }

    // Grid
    const gL1 = avg(buffer.grid.power_l1);
    const gL2 = avg(buffer.grid.power_l2);
    const gL3 = avg(buffer.grid.power_l3);
    const gV1 = avg(buffer.grid.voltage_l1);
    const gFreq = avg(buffer.grid.frequency);
    if (gL1 !== null || gL2 !== null || gL3 !== null) {
      await dbClient.query(`
        INSERT INTO victron_grid_data (timestamp, device_id, power_l1, power_l2, power_l3, voltage_l1, frequency)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [timestamp, DEVICE_ID, gL1, gL2, gL3, gV1, gFreq]);
      inserts++;
    }

    // Inverter
    const invPow = avg(buffer.inverter.power);
    const invVolt = avg(buffer.inverter.voltage);
    const invCur = avg(buffer.inverter.current);
    if (invPow !== null || invVolt !== null || invCur !== null) {
      await dbClient.query(`
        INSERT INTO victron_inverter_data (timestamp, device_id, power, voltage, current)
        VALUES ($1, $2, $3, $4, $5)
      `, [timestamp, DEVICE_ID, invPow, invVolt, invCur]);
      inserts++;
    }

    // EV charger
    const evPow = avg(buffer.ev.power);
    const evCur = avg(buffer.ev.current);
    const evEnergy = last(buffer.ev.energy);   // cumulative — use last, not avg
    const evStatus = last(buffer.ev.status);
    if (evPow !== null || evCur !== null || evEnergy !== null) {
      try {
        await dbClient.query(`
          INSERT INTO victron_ev_data (timestamp, device_id, power_watts, current_amps, energy_kwh, status)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [timestamp, DEVICE_ID, evPow, evCur, evEnergy, evStatus]);
        inserts++;
      } catch (err) {
        if (!err.message.includes('does not exist')) {
          log(`Error flushing EV data: ${err.message}`, "ERROR");
        }
      }
    }

  } catch (err) {
    log(`Error flushing buffer: ${err.message}`, "ERROR");
  }

  if (inserts > 0) {
    log(`Flushed ${inserts} rows (${flushed} msgs buffered in ${FLUSH_INTERVAL_MS/1000}s)`, "DEBUG");
  }

  resetBuffer();
}

// ---------------- Immediate inserts (rare events only) ----------------

async function insertSystemEvent(event, value, timestamp) {
  try {
    await dbClient.query(`
      INSERT INTO victron_system_events (timestamp, device_id, event_type, event_value, description)
      VALUES ($1, $2, $3, $4, $5)
    `, [timestamp, DEVICE_ID, event, value, `${event} = ${value}`]);
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
        }
      });
    });
  });

  mqttClient.on("reconnect", () => log("Reconnecting to MQTT broker", "WARN"));

  mqttClient.on("message", async (topic, message) => {
    if (isShuttingDown) return;
    
    try {
      const data = JSON.parse(message.toString());
      
      if (typeof data.value !== "number" || data.value === null || isNaN(data.value)) {
        return;
      }

      const value = data.value;
      msgCount++;

      // Buffer values — no DB writes here (except system events)
      switch (topic) {
        // Battery
        case MQTT_TOPICS.BATTERY_SOC:     bufferValue(buffer.battery.soc, value); break;
        case MQTT_TOPICS.BATTERY_VOLTAGE: bufferValue(buffer.battery.voltage, value); break;
        case MQTT_TOPICS.BATTERY_CURRENT: bufferValue(buffer.battery.current, value); break;
        case MQTT_TOPICS.BATTERY_POWER:   bufferValue(buffer.battery.power, value); break;

        // PV total
        case MQTT_TOPICS.PV_POWER:   bufferValue(buffer.pv.power, value); break;
        case MQTT_TOPICS.PV_VOLTAGE: bufferValue(buffer.pv.voltage, value); break;
        case MQTT_TOPICS.PV_CURRENT: bufferValue(buffer.pv.current, value); break;

        // PV arrays
        case MQTT_TOPICS.PV_ARRAY_0_POWER:   buffer.pvArrays[0] = buffer.pvArrays[0] || { power: [], voltage: [] }; bufferValue(buffer.pvArrays[0].power, value); break;
        case MQTT_TOPICS.PV_ARRAY_0_VOLTAGE: buffer.pvArrays[0] = buffer.pvArrays[0] || { power: [], voltage: [] }; bufferValue(buffer.pvArrays[0].voltage, value); break;
        case MQTT_TOPICS.PV_ARRAY_1_POWER:   buffer.pvArrays[1] = buffer.pvArrays[1] || { power: [], voltage: [] }; bufferValue(buffer.pvArrays[1].power, value); break;
        case MQTT_TOPICS.PV_ARRAY_1_VOLTAGE: buffer.pvArrays[1] = buffer.pvArrays[1] || { power: [], voltage: [] }; bufferValue(buffer.pvArrays[1].voltage, value); break;
        case MQTT_TOPICS.PV_ARRAY_2_POWER:   buffer.pvArrays[2] = buffer.pvArrays[2] || { power: [], voltage: [] }; bufferValue(buffer.pvArrays[2].power, value); break;
        case MQTT_TOPICS.PV_ARRAY_2_VOLTAGE: buffer.pvArrays[2] = buffer.pvArrays[2] || { power: [], voltage: [] }; bufferValue(buffer.pvArrays[2].voltage, value); break;
        case MQTT_TOPICS.PV_ARRAY_3_POWER:   buffer.pvArrays[3] = buffer.pvArrays[3] || { power: [], voltage: [] }; bufferValue(buffer.pvArrays[3].power, value); break;
        case MQTT_TOPICS.PV_ARRAY_3_VOLTAGE: buffer.pvArrays[3] = buffer.pvArrays[3] || { power: [], voltage: [] }; bufferValue(buffer.pvArrays[3].voltage, value); break;

        // Grid
        case MQTT_TOPICS.GRID_POWER_L1:  bufferValue(buffer.grid.power_l1, value); break;
        case MQTT_TOPICS.GRID_POWER_L2:  bufferValue(buffer.grid.power_l2, value); break;
        case MQTT_TOPICS.GRID_POWER_L3:  bufferValue(buffer.grid.power_l3, value); break;
        case MQTT_TOPICS.GRID_VOLTAGE_L1:bufferValue(buffer.grid.voltage_l1, value); break;
        case MQTT_TOPICS.GRID_FREQUENCY: bufferValue(buffer.grid.frequency, value); break;

        // Inverter
        case MQTT_TOPICS.INVERTER_POWER:  bufferValue(buffer.inverter.power, value); break;
        case MQTT_TOPICS.INVERTER_VOLTAGE:bufferValue(buffer.inverter.voltage, value); break;
        case MQTT_TOPICS.INVERTER_CURRENT:bufferValue(buffer.inverter.current, value); break;

        // System events — immediate insert (rare)
        case MQTT_TOPICS.VEBUS_ERROR:
          await insertSystemEvent("vebus_error", value, new Date());
          break;

        // EV Charger
        case MQTT_TOPICS.EV_POWER:   bufferValue(buffer.ev.power, value); break;
        case MQTT_TOPICS.EV_CURRENT: bufferValue(buffer.ev.current, value); break;
        case MQTT_TOPICS.EV_ENERGY:  bufferValue(buffer.ev.energy, value); break;
        case MQTT_TOPICS.EV_STATUS:  bufferValue(buffer.ev.status, value); break;
        case MQTT_TOPICS.EV_POWER_L1: break; // covered by EV_POWER total
        case MQTT_TOPICS.EV_POWER_L2: break;
        case MQTT_TOPICS.EV_POWER_L3: break;
        case MQTT_TOPICS.EV_MODE:           break; // metadata, not needed in time-series
        case MQTT_TOPICS.EV_MAX_CURRENT:    break;
        case MQTT_TOPICS.EV_SET_CURRENT:    break;
        case MQTT_TOPICS.EV_CHARGING_TIME:  break;
        case MQTT_TOPICS.EV_START_STOP:     break;
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
  
  // Flush any remaining buffered data
  await flushBuffer();
  
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
  log("Starting Victron MQTT Data Collector (buffered)");
  log(`Flush interval: ${FLUSH_INTERVAL_MS/1000}s`);
  await connectDatabase();
  setupMQTT();

  // Periodic flush
  setInterval(() => {
    flushBuffer().catch(err => log(`Flush error: ${err.message}`, "ERROR"));
  }, FLUSH_INTERVAL_MS);

  log("Data collector ready — buffering MQTT, flushing averages to DB");
}

startup().catch(err => {
  log(`Failed to start data collector: ${err.message}`, "ERROR");
  process.exit(1);
});
