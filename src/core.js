/**
 * Victron + Octopus Flux Smart Charging Controller (Solar Optimized)
 * Author: Saad (Revised by Grok)
 * 
 * System:
 * - 3x Fogstar Energy 16.1kWh 48V batteries (48.3kWh total, 38.64kWh usable).
 * - Victron MultiPlus-II 15kVA.
 * - DNO export limit: 12kW.
 * - Single PV source, MQTT: N/<device_id>/system/0/Dc/Pv/Power.
 * - Grid export: N/<device_id>/system/0/Ac/ConsumptionOnOutput/L1/Power.
 * - Usage: 20% battery (~9.66kWh) from sunset to morning.
 * 
 * Features:
 * - Prioritizes solar charging using forecast to avoid grid imports (27.68p/kWh day).
 * - Grid charging only in Flux window (02:00–05:00, 16.61p/kWh) if needed.
 * - Maximizes export in peak window (16:00–19:00, 29.79p/kWh) within 12kW DNO limit.
 * - Monitors grid export and throttles discharge if nearing limit.
 * - Ensures 30% SOC (20% overnight + 10% safety) for battery protection.
 * - Fetches Octopus Flux rates via API, falls back to hardcoded rates.
 * - Logs to victron-flux.log.
 * - Configurable via .env.
 */

const mqtt = require("mqtt");
const fs = require("fs").promises;
const path = require("path");
const axios = require("axios");
require("dotenv").config();

// ---------------- Config ----------------
const MQTT_BROKER = process.env.MQTT_BROKER || "mqtt://192.168.9.226";
const DEVICE_ID = process.env.DEVICE_ID || "c0619ab786e2";
const REGION_CODE = "C"; // London, per rates matching[](https://mysmartenergy.uk/Flux/London)
const TOPIC_BATTERY_SOC = `N/${DEVICE_ID}/battery/0/Dc/0/Soc`;
const TOPIC_PV_POWER = `N/${DEVICE_ID}/system/0/Dc/Pv/Power`;
const TOPIC_GRID_EXPORT = `N/${DEVICE_ID}/system/0/Ac/Consumption/L1/Power`;
const TOPIC_MIN_SOC = `W/${DEVICE_ID}/settings/0/Settings/CGwacs/BatteryLife/MinimumSocLimit`;
const TOPIC_AC_SETPOINT = `W/${DEVICE_ID}/settings/0/Settings/CGwacs/AcPowerSetPoint`;
const TOPIC_ESS_MODE = `W/${DEVICE_ID}/vebus/0/Mode`;
const LOG_FILE = path.join(__dirname, "../logs/victron-flux.log");

// Hardcoded Flux rates (fallback if API fails)
const TARIFF = {
  DAY: { import: 27.68, export: 10.24, start: "05:00", end: "02:00" },
  FLUX: { import: 16.61, export: 5.05, start: "02:00", end: "05:00" },
  PEAK: { import: 38.75, export: 29.79, start: "16:00", end: "19:00" },
};

// Setpoints (percent)
const SETPOINTS = {
  CHARGE: 100, // Full charge for peak export
  DISCHARGE: 30, // Allow discharge to safety limit
  IDLE: 30, // Maintain minimum SOC
};

// Battery and system config
const BATTERY_CAPACITY_KWH = 48.3; // Total capacity
const USABLE_CAPACITY_KWH = BATTERY_CAPACITY_KWH * 0.8; // 80% DoD
const SOC_SAFETY_MIN = 30; // 20% overnight + 10% safety
const AC_POWER_SETPOINT_MIN = 50;
const AC_POWER_SETPOINT_MAX = -12000;
const TARGET_SOC_PEAK = 80; // ~38.64kWh for peak export
const MIN_PV_POWER = 500; // Minimum for solar charging
const DNO_EXPORT_LIMIT = 12000; // 12kW
const EXPORT_SAFETY_MARGIN = 1000; // 1kW buffer
const OVERNIGHT_USAGE_KWH = 9.66; // 20% of capacity
const PEAK_EXPORT_HOURS = 3; // 16:00–19:00

// Valid ESS modes
const ESS_MODES = {
  OPTIMIZED: 1, // Uses solar when available
  CHARGE: 2,   // Force grid charge
  DISCHARGE: 3, // Force discharge
};

// Solar forecast (simple cosine model, 10kWp assumed)
const PV_PEAK_POWER = 10000; // Adjust to your PV capacity
function getSolarForecast(now) {
  const hour = now.getHours() + now.getMinutes() / 60;
  const sunrise = 6, sunset = 20; // Approximate, adjust for location
  if (hour < sunrise || hour > sunset) return 0;
  const dayFraction = (hour - sunrise) / (sunset - sunrise);
  const solarPower = PV_PEAK_POWER * Math.cos(Math.PI * (dayFraction - 0.5)) ** 2;
  return Math.max(0, solarPower); // Non-negative
}

// -------------- Logging Helper --------------
async function log(message, level = "INFO") {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] [${level}] ${message}\n`;
  try {
    await fs.appendFile(LOG_FILE, entry);
    console.log(entry.trim());
  } catch (err) {
    console.error(`Failed to write log: ${err.message}`);
  }
}

// ---------------- Octopus API ----------------
let tariffData = TARIFF;

// ---------------- MQTT Client ----------------
const client = mqtt.connect(MQTT_BROKER, { reconnectPeriod: 5000 });

let currentSetpoint = null;
let currentMode = null;
let batterySoc = null;
let pvPower = null;
let gridExportPower = null;

client.on("connect", () => {
  log("Connected to MQTT broker", "INFO");
  const topics = [
    { topic: TOPIC_BATTERY_SOC, qos: 1 },
    { topic: TOPIC_PV_POWER, qos: 1 },
    { topic: TOPIC_GRID_EXPORT, qos: 1 },
  ];
  client.subscribe(topics.map(t => t.topic), (err) => {
    if (err) log(`Error subscribing to topics: ${err.message}`, "ERROR");
    else log(`Subscribed to ${topics.map(t => t.topic).join(", ")}`, "INFO");
  });
  applyStrategy();
});

client.on("reconnect", () => log("Reconnecting to MQTT broker", "WARN"));

client.on("message", (topic, message) => {
  try {
    const data = JSON.parse(message.toString());
    if (typeof data.value !== "number") {
      log(`Invalid data on ${topic}: ${message.toString()}`, "WARN");
      return;
    }
    if (topic === TOPIC_BATTERY_SOC) {
      batterySoc = data.value;
      log(`Battery SoC: ${batterySoc}%`, "INFO");
    } else if (topic === TOPIC_PV_POWER) {
      pvPower = data.value;
      // log(`PV Power: ${pvPower}W`, "INFO");
    } else if (topic === TOPIC_GRID_EXPORT) {
      gridExportPower = data.value; // Positive = export
      // log(`Grid Export Power: ${gridExportPower}W`, "INFO");
      if (gridExportPower > DNO_EXPORT_LIMIT - EXPORT_SAFETY_MARGIN) {
        log(`Grid export nearing DNO limit (${DNO_EXPORT_LIMIT}W)`, "WARN");
      }
    }
  } catch (err) {
    log(`Failed to parse data on ${topic}: ${err.message}`, "ERROR");
  }
});

client.on("error", (err) => log(`MQTT Error: ${err.message}`, "ERROR"));
client.on("offline", () => log("MQTT offline", "WARN"));

// ---------------- Core Functions ----------------
function setAcPowerSetpoint(value) {
  client.publish(
    TOPIC_AC_SETPOINT,
    JSON.stringify({ value }),
    { qos: 1 },
    (err) => {
      if (err) log(`Failed to set AC Power Setpoint: ${err.message}`, "ERROR");
      else log(`Set AC Power Setpoint = ${value} W`, "INFO");
    }
  );
}

function setMinSoc(value) {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    log(`Invalid SOC setpoint: ${value}`, "ERROR");
    return;
  }
  if (value !== currentSetpoint) {
    currentSetpoint = value;
    client.publish(TOPIC_MIN_SOC, JSON.stringify({ value }), { qos: 1 }, (err) => {
      if (err) log(`Failed to set Min SOC: ${err.message}`, "ERROR");
      else log(`Set Minimum SOC = ${value}%`, "INFO");
    });
  } else {
    log(`Min SOC unchanged: ${value}%`, "DEBUG");
  }
}

function setEssMode(mode) {
  if (!Object.values(ESS_MODES).includes(mode)) {
    log(`Invalid ESS mode: ${mode}`, "ERROR");
    return;
  }
  if (mode !== currentMode) {
    currentMode = mode;
    client.publish(TOPIC_ESS_MODE, JSON.stringify({ value: mode }), { qos: 1 }, (err) => {
      if (err) log(`Failed to set ESS mode: ${err.message}`, "ERROR");
      else log(`Set ESS Mode = ${mode} (${getEssModeName(mode)})`, "INFO");
    });
  } else {
    log(`ESS Mode unchanged: ${mode} (${getEssModeName(mode)})`, "DEBUG");
  }
}

function getEssModeName(mode) {
  return Object.keys(ESS_MODES).find((key) => ESS_MODES[key] === mode) || "Unknown";
}

// ---------------- Strategy ----------------
function isWithinTimeWindow(start, end, now) {
  const [startHour, startMin] = start.split(":").map(Number);
  const [endHour, endMin] = end.split(":").map(Number);
  const startTime = startHour * 60 + startMin;
  const endTime = endHour * 60 + endMin;
  const currentTime = now.getHours() * 60 + now.getMinutes();
  
  if (startTime <= endTime) {
    return currentTime >= startTime && currentTime < endTime;
  } else {
    return currentTime >= startTime || currentTime < endTime;
  }
}

function applyStrategy() {
  const now = new Date();
  let socSetpoint = SETPOINTS.IDLE;
  let essMode = ESS_MODES.OPTIMIZED;
  let acSetpoint = AC_POWER_SETPOINT_MIN; // default

  const forecastPower = getSolarForecast(now);
  const solarAvailable = pvPower !== null ? pvPower >= MIN_PV_POWER : forecastPower >= MIN_PV_POWER;
  log(`Solar forecast: ${forecastPower}W, actual: ${pvPower || "unknown"}W`, "DEBUG");

  // Check battery status
  const batteryLow = batterySoc !== null && batterySoc <= SOC_SAFETY_MIN;

  // --- Core Logic based on Power Sources ---

  if (isWithinTimeWindow(tariffData.PEAK.start, tariffData.PEAK.end, now)) {
    // Peak export window (16:00-19:00)
    // Discharge battery to grid for profit.
    if (gridExportPower === null || gridExportPower < DNO_EXPORT_LIMIT - EXPORT_SAFETY_MARGIN) {
      socSetpoint = SETPOINTS.DISCHARGE;
      essMode = ESS_MODES.DISCHARGE;
      acSetpoint = AC_POWER_SETPOINT_MAX; // -12kW export
      log(`Peak window, discharging battery to grid`, "INFO");
    } else {
      log("Peak window, export near limit, throttling discharge", "WARN");
      essMode = ESS_MODES.OPTIMIZED;
      acSetpoint = AC_POWER_SETPOINT_MIN;
    }

  } else if (isWithinTimeWindow(tariffData.FLUX.start, tariffData.FLUX.end, now)) {
    // Flux window (02:00-05:00) - cheap grid charging
    // Charge battery if below target.
    if (batterySoc !== null && batterySoc < TARGET_SOC_PEAK) {
      socSetpoint = SETPOINTS.CHARGE;
      essMode = ESS_MODES.CHARGE;
      log(`Flux window, charging battery to ${TARGET_SOC_PEAK}%`, "INFO");
    } else {
      log("Flux window, SOC sufficient, using optimized mode", "INFO");
      essMode = ESS_MODES.OPTIMIZED;
    }
    acSetpoint = AC_POWER_SETPOINT_MIN;

  } else {
    // Normal hours (Day/Night)
    // Prioritize solar, then battery, then grid if needed.


      socSetpoint = SETPOINTS.DISCHARGE; // Allow discharge down to 30%.
      essMode = ESS_MODES.OPTIMIZED;
      acSetpoint = AC_POWER_SETPOINT_MIN; // Ensures grid power can be drawn for loads.
      log(acSetpoint)

    // if (solarAvailable) {
    //   // Solar is available: charge battery and power loads from solar.
    //   socSetpoint = SETPOINTS.CHARGE; // Let the system charge from solar.
    //   essMode = ESS_MODES.OPTIMIZED;
    //   log(`Solar available (${pvPower || forecastPower}W), charging battery`, "INFO");

    // } else if (!solarAvailable && !batteryLow) {
    //   // No solar, but battery is not low: use battery to power loads.
    //   socSetpoint = SETPOINTS.CHARGE; // Allow discharge down to 30%.
    //   essMode = ESS_MODES.OPTIMIZED;
    //   log("No solar, battery will supply AC load as needed", "INFO");

    // } else if (batteryLow) {
    //   // No solar and battery is low: switch to grid for loads and emergency charge.
    //   socSetpoint = SOC_SAFETY_MIN;
    //   essMode = ESS_MODES.OPTIMIZED; // Optimized mode with a high SOC limit will prevent discharge.
    //   acSetpoint = AC_POWER_SETPOINT_MIN; // Ensures grid power can be drawn for loads.
    //   log(`Battery SOC ${batterySoc}% below minimum, switching to grid for loads`, "WARN");
    // }
  }

  // Final actions
  setMinSoc(socSetpoint);
  setEssMode(essMode);
  setAcPowerSetpoint(acSetpoint);
}


// Run every 5 minutes
setInterval(applyStrategy, 5 * 60 * 1000);

// Initial run
applyStrategy();