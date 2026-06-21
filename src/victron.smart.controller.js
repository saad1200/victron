/**
 * Victron Smart ESS Controller
 * 
 * Replaces DESS (Dynamic ESS) with tariff-aware battery scheduling,
 * anti-export logic, and Victron EVCS integration.
 * 
 * IMPORTANT: Disable DESS in VRM before running this controller.
 * VRM can still be used for monitoring/analytics — this controller
 * takes over ESS scheduling via direct MQTT control.
 * 
 * Key features:
 *  - Tariff-period-aware charge/discharge scheduling
 *  - Anti-export: prevents battery export during non-peak hours
 *  - EV charger (Victron EVCS) coordination
 *  - Solar surplus diversion to EV
 *  - Real-time feedback loop for grid setpoint adjustment
 */

const mqtt = require('mqtt');
const { Client } = require('pg');
const { toISODateUK } = require('./report-utils');
const OctopusAPI = require('./octopus-api');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

// ─────────────────────────── Configuration ───────────────────────────

const MQTT_BROKER = process.env.MQTT_BROKER;
const DEVICE_ID = process.env.DEVICE_ID;
const EV_CHARGER_INSTANCE = process.env.EV_CHARGER_INSTANCE || '0';

const DB_CONFIG = {
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'victron',
  password: process.env.DB_PASSWORD || 'password',
  port: process.env.DB_PORT || 5433,
};

const LOG_FILE = path.join(__dirname, '../logs/victron-smart-controller.log');

// Tunable thresholds (override via .env)
const CONFIG = {
  // Anti-export: minimum export (W) before we intervene (-ve grid = export)
  ANTI_EXPORT_THRESHOLD: parseInt(process.env.ANTI_EXPORT_THRESHOLD) || -100,
  // Buffer watts added to setpoint to ensure slight import bias
  IMPORT_BIAS_WATTS: parseInt(process.env.IMPORT_BIAS_WATTS) || 50,
  // SOC below which we aggressively charge even during day
  LOW_SOC_THRESHOLD: parseInt(process.env.LOW_SOC_THRESHOLD) || 20,
  // SOC above which we allow export during day (battery nearly full)
  FULL_SOC_THRESHOLD: parseInt(process.env.FULL_SOC_THRESHOLD) || 95,
  // Minimum solar surplus (W) before diverting to EV
  EV_SOLAR_SURPLUS_MIN: parseInt(process.env.EV_SOLAR_SURPLUS_MIN) || 1400,
  // Minimum EV charging current (A) — below this the EVCS won't charge
  EV_MIN_CURRENT: parseInt(process.env.EV_MIN_CURRENT) || 6,
  // Maximum EV charging current (A)
  EV_MAX_CURRENT: parseInt(process.env.EV_MAX_CURRENT) || 32,
  // Grid voltage for power ↔ current conversion (single phase)
  GRID_VOLTAGE: parseInt(process.env.GRID_VOLTAGE) || 230,
  // Max battery charge rate from grid (W)
  MAX_GRID_CHARGE_WATTS: parseInt(process.env.MAX_GRID_CHARGE_WATTS) || 12000,
  // Max battery discharge/export rate (W, as positive number)
  MAX_EXPORT_WATTS: parseInt(process.env.MAX_EXPORT_WATTS) || 12000,
  // Strategy loop interval (ms)
  STRATEGY_INTERVAL: parseInt(process.env.STRATEGY_INTERVAL) || 30000,
  // Feedback loop interval (ms) — faster than strategy for responsive anti-export
  FEEDBACK_INTERVAL: parseInt(process.env.FEEDBACK_INTERVAL) || 15000,
  // SOC target for night charging
  NIGHT_TARGET_SOC: parseInt(process.env.NIGHT_TARGET_SOC) || 100,
  // Min SOC to preserve during peak discharge
  PEAK_MIN_SOC: parseInt(process.env.PEAK_MIN_SOC) || 10,
  // Evening: min SOC before we stop using battery for self-consumption
  EVENING_MIN_SOC: parseInt(process.env.EVENING_MIN_SOC) || 15,
  // EV charging SOC threshold — only charge EV from battery if SOC above this
  EV_BATTERY_SOC_THRESHOLD: parseInt(process.env.EV_BATTERY_SOC_THRESHOLD) || 50,
  // Rate classification thresholds (p/kWh). 0 = auto-calculate from daily spread
  CHEAP_RATE_PENCE: parseFloat(process.env.CHEAP_RATE_PENCE) || 0,
  EXPENSIVE_RATE_PENCE: parseFloat(process.env.EXPENSIVE_RATE_PENCE) || 0,
  // How often to refresh rates from Octopus API (ms). Default: 1 hour
  RATE_REFRESH_INTERVAL: parseInt(process.env.RATE_REFRESH_INTERVAL) || 3600000,
  // Solar power (W) threshold to distinguish day-like from evening-like strategy
  SOLAR_AVAILABLE_THRESHOLD: parseInt(process.env.SOLAR_AVAILABLE_THRESHOLD) || 500,
};

// ─────────────────────────── ESS & Inverter Modes ───────────────────

const ESS_MODES = {
  OPTIMIZE_WITH_BATTERYLIFE: 1,
  KEEP_BATTERIES_CHARGED: 9,
  OPTIMIZE_WITHOUT_BATTERYLIFE: 10,
};

const INVERTER_MODES = {
  CHARGER_ONLY: 1,
  INVERTER_ONLY: 2,
  ON: 3,
  OFF: 4,
};

const EV_STATUS = {
  DISCONNECTED: 0,
  CONNECTED: 1,
  CHARGING: 2,
  CHARGED: 3,
  WAITING_SUN: 4,
  WAITING_RFID: 5,
  WAITING_START: 6,
  LOW_SOC: 7,
};

// ─────────────────────────── MQTT Topics ────────────────────────────

const MQTT_TOPICS = {
  // ── Control (write) ──
  ESS_MODE_WRITE:       `W/${DEVICE_ID}/settings/0/Settings/CGwacs/BatteryLife/State`,
  INVERTER_MODE_WRITE:  `W/${DEVICE_ID}/vebus/276/Mode`,
  GRID_SETPOINT_WRITE:  `W/${DEVICE_ID}/settings/0/Settings/CGwacs/AcPowerSetPoint`,
  MIN_SOC_WRITE:        `W/${DEVICE_ID}/settings/0/Settings/CGwacs/BatteryLife/MinimumSocLimit`,
  ACTIVE_SOC_WRITE:     `W/${DEVICE_ID}/settings/0/Settings/CGwacs/BatteryLife/SocLimit`,

  // ── Monitor (read) ──
  BATTERY_SOC:      `N/${DEVICE_ID}/vebus/276/Soc`,
  BATTERY_VOLTAGE:  `N/${DEVICE_ID}/system/0/Dc/Battery/Voltage`,
  BATTERY_CURRENT:  `N/${DEVICE_ID}/system/0/Dc/Battery/Current`,
  BATTERY_POWER:    `N/${DEVICE_ID}/system/0/Dc/Battery/Power`,
  GRID_POWER:       `N/${DEVICE_ID}/system/0/Ac/Grid/L1/Power`,
  SOLAR_POWER:      `N/${DEVICE_ID}/system/0/Dc/Pv/Power`,
  LOAD_POWER:       `N/${DEVICE_ID}/system/0/Ac/Consumption/L1/Power`,
  ESS_MODE_READ:    `N/${DEVICE_ID}/settings/0/Settings/CGwacs/BatteryLife/State`,
  INVERTER_MODE_READ: `N/${DEVICE_ID}/vebus/276/Mode`,
  MIN_SOC_READ:     `N/${DEVICE_ID}/settings/0/Settings/CGwacs/BatteryLife/MinimumSocLimit`,
  ACTIVE_SOC_READ:  `N/${DEVICE_ID}/settings/0/Settings/CGwacs/BatteryLife/SocLimit`,

  // ── EV Charger (Victron EVCS) ──
  EV_STATUS:        `N/${DEVICE_ID}/evcharger/${EV_CHARGER_INSTANCE}/Status`,
  EV_MODE:          `N/${DEVICE_ID}/evcharger/${EV_CHARGER_INSTANCE}/Mode`,
  EV_POWER:         `N/${DEVICE_ID}/evcharger/${EV_CHARGER_INSTANCE}/Ac/Power`,
  EV_CURRENT:       `N/${DEVICE_ID}/evcharger/${EV_CHARGER_INSTANCE}/Current`,
  EV_MAX_CURRENT:   `N/${DEVICE_ID}/evcharger/${EV_CHARGER_INSTANCE}/MaxCurrent`,
  EV_SET_CURRENT:   `N/${DEVICE_ID}/evcharger/${EV_CHARGER_INSTANCE}/SetCurrent`,
  EV_ENERGY:        `N/${DEVICE_ID}/evcharger/${EV_CHARGER_INSTANCE}/Ac/Energy/Forward`,
  EV_START_STOP:    `N/${DEVICE_ID}/evcharger/${EV_CHARGER_INSTANCE}/StartStop`,
  EV_POSITION:      `N/${DEVICE_ID}/evcharger/${EV_CHARGER_INSTANCE}/Position`,

  // ── EV Charger control (write) ──
  EV_SET_CURRENT_WRITE:  `W/${DEVICE_ID}/evcharger/${EV_CHARGER_INSTANCE}/SetCurrent`,
  EV_START_STOP_WRITE:   `W/${DEVICE_ID}/evcharger/${EV_CHARGER_INSTANCE}/StartStop`,
  EV_MODE_WRITE:         `W/${DEVICE_ID}/evcharger/${EV_CHARGER_INSTANCE}/Mode`,
};

// ─────────────────────────── State Variables ────────────────────────

let currentSOC = 0;
let currentVoltage = 0;
let currentCurrent = 0;
let batteryPower = 0;       // +ve = charging, -ve = discharging
let gridPower = 0;          // +ve = importing, -ve = exporting
let solarPower = 0;
let loadPower = 0;
let currentESSMode = 0;
let currentInverterMode = 0;
let currentMinSOC = 0;
let currentActiveSOC = 0;
let currentGridSetpoint = 0;

// EV state
let evStatus = EV_STATUS.DISCONNECTED;
let evMode = 0;
let evPower = 0;
let evCurrent = 0;
let evMaxCurrent = 0;
let evSetCurrent = 0;
let evEnergy = 0;
let evStartStop = 0;

// Controller state
let currentRateClass = null;    // 'CHEAP', 'NORMAL', 'EXPENSIVE'
let previousRateClass = null;
let currentImportRate = 0;      // current import rate p/kWh
let currentExportRate = 0;      // current export rate p/kWh
let importRates = [];           // today's + tomorrow's import rates from API
let exportRates = [];           // today's + tomorrow's export rates from API
let cheapThreshold = 0;         // auto-calculated or from CONFIG
let expensiveThreshold = 0;     // auto-calculated or from CONFIG
let productName = 'Unknown';
let importTariffCode = null;
let exportTariffCode = null;
let octopusApi = null;
let rateRefreshTimer = null;
let mqttClient = null;
let dbClient = null;
let isRunning = false;
let strategyTimer = null;
let feedbackTimer = null;
let lastStrategy = 'unknown';
let lastEvAction = 'none';
let advisorDecision = null;       // latest strategy advisor decision
let advisorDecisionLoaded = false;

// ─────────────────────────── Logging ────────────────────────────────

async function log(message, level = 'INFO') {
  const timestamp = new Date().toLocaleString('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    fractionalSecondDigits: 3,
  });
  const entry = `[${timestamp}] [SMART-CTRL] [${level}] ${message}\n`;
  try {
    await fs.appendFile(LOG_FILE, entry);
    console.log(entry.trim());
  } catch (err) {
    console.error(`Log write failed: ${err.message}`);
  }
}

// ─────────────────────────── Database ───────────────────────────────

async function initializeDatabase(retries = 10) {
  for (let i = 1; i <= retries; i++) {
    dbClient = new Client(DB_CONFIG);
    try {
      await dbClient.connect();
      await dbClient.query('SELECT NOW()');
      log('Database connection successful');
      return true;
    } catch (error) {
      log(`DB connection attempt ${i}/${retries} failed: ${error.message}`, 'WARN');
      try { await dbClient.end(); } catch (_) {}
      if (i < retries) {
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }
  log('Database connection failed after all retries', 'ERROR');
  return false;
}

// ─────────────────────── Strategy Advisor ─────────────────────────────

/**
 * Load the latest strategy advisor decision from the database.
 * The advisor runs daily at 20:00 and writes to victron_strategy_decisions.
 * This function reads today's or tomorrow's decision depending on the time.
 */
async function loadAdvisorDecision() {
  try {
    // During cheap rate (02:00-05:00), the relevant decision is for today's date
    // The advisor runs at 20:00 the night before and writes decision_date = tomorrow
    const today = toISODateUK();

    const result = await dbClient.query(`
      SELECT action, target_soc, confidence, reasoning, solar_forecast_kwh,
             created_at
      FROM victron_strategy_decisions
      WHERE decision_date = $1
      ORDER BY created_at DESC LIMIT 1
    `, [today]);

    if (result.rows.length > 0) {
      const row = result.rows[0];
      advisorDecision = {
        action: row.action,
        target_soc: row.target_soc ? parseInt(row.target_soc) : null,
        confidence: row.confidence,
        reasoning: row.reasoning,
        solarForecast: row.solar_forecast_kwh ? parseFloat(row.solar_forecast_kwh) : null,
      };
      log(`Advisor decision loaded: ${advisorDecision.action}${advisorDecision.target_soc ? ' (target=' + advisorDecision.target_soc + '%)' : ''} [${advisorDecision.confidence}] — forecast=${advisorDecision.solarForecast} kWh`);
    } else {
      // No AI decision available — default to skip night charge, export during peak
      advisorDecision = { action: 'skip_night_charge', confidence: 'low', reasoning: 'No advisor decision available — defaulting to skip night charge' };
      if (!advisorDecisionLoaded) {
        log('No advisor decision found for today — defaulting to skip night charge');
      }
    }
    advisorDecisionLoaded = true;
  } catch (err) {
    // Table may not exist yet — non-critical
    if (!err.message.includes('does not exist')) {
      log(`Advisor decision load failed: ${err.message}`, 'WARN');
    }
    advisorDecision = { action: 'skip_night_charge', confidence: 'low', reasoning: 'DB error — defaulting to skip night charge' };
    advisorDecisionLoaded = true;
  }
}

// ─────────────────────── Octopus API Rate Management ─────────────────

/**
 * Load current tariff info and rates from the Octopus Energy API.
 * Auto-detects product (Flux, Agile, Go, etc.) from account number.
 */
async function loadRatesFromAPI() {
  try {
    octopusApi = new OctopusAPI();

    const tariffs = await octopusApi.getCurrentTariffs();
    importTariffCode = tariffs.importTariff;
    exportTariffCode = tariffs.exportTariff;
    productName = octopusApi.extractProductName(importTariffCode);

    log(`Detected product: ${productName}`);
    log(`Import tariff: ${importTariffCode}`);
    log(`Export tariff: ${exportTariffCode || 'none'}`);

    await refreshRates();
    return true;
  } catch (error) {
    log(`Failed to load rates from Octopus API: ${error.message}`, 'ERROR');
    return false;
  }
}

/**
 * Fetch today's + tomorrow's rates from the API and calculate thresholds.
 * Called on startup and periodically via RATE_REFRESH_INTERVAL.
 */
async function refreshRates() {
  try {
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfTomorrow = new Date(now);
    endOfTomorrow.setDate(endOfTomorrow.getDate() + 2);
    endOfTomorrow.setHours(0, 0, 0, 0);

    if (importTariffCode) {
      const raw = await octopusApi.getTariffRates(
        importTariffCode, startOfDay.toISOString(), endOfTomorrow.toISOString()
      );
      importRates = octopusApi.createRateLookup(raw);
      log(`Fetched ${importRates.length} import rates`);
    }

    if (exportTariffCode) {
      const raw = await octopusApi.getTariffRates(
        exportTariffCode, startOfDay.toISOString(), endOfTomorrow.toISOString()
      );
      exportRates = octopusApi.createRateLookup(raw);
      log(`Fetched ${exportRates.length} export rates`);
    }

    // Calculate rate classification thresholds from spread
    if (importRates.length > 0) {
      const values = importRates.map(r => r.value_inc_vat);
      const minRate = Math.min(...values);
      const maxRate = Math.max(...values);
      const spread = maxRate - minRate;

      cheapThreshold = CONFIG.CHEAP_RATE_PENCE || (minRate + spread * 0.3);
      expensiveThreshold = CONFIG.EXPENSIVE_RATE_PENCE || (maxRate - spread * 0.3);

      log(`Rate spread: ${minRate.toFixed(1)}p – ${maxRate.toFixed(1)}p (${productName})`);
      log(`Thresholds: CHEAP < ${cheapThreshold.toFixed(1)}p, EXPENSIVE > ${expensiveThreshold.toFixed(1)}p`);
    }
  } catch (error) {
    log(`Failed to refresh rates: ${error.message}`, 'ERROR');
  }
}

/**
 * Get the current import/export rate and classify as CHEAP, NORMAL, or EXPENSIVE.
 */
function classifyCurrentRate() {
  const now = new Date();

  const importMatch = importRates.find(r => now >= r.valid_from && now < r.valid_to);
  const exportMatch = exportRates.find(r => now >= r.valid_from && now < r.valid_to);

  currentImportRate = importMatch ? importMatch.value_inc_vat : 0;
  currentExportRate = exportMatch ? exportMatch.value_inc_vat : 0;

  if (currentImportRate <= 0 || importRates.length === 0) {
    return 'NORMAL'; // Fallback if no rates available
  }

  if (currentImportRate <= cheapThreshold) return 'CHEAP';
  if (currentImportRate >= expensiveThreshold) return 'EXPENSIVE';
  return 'NORMAL';
}

// ─────────────────────────── MQTT Setters ────────────────────────────

function mqttPublish(topic, value) {
  if (!mqttClient || !mqttClient.connected) return false;
  mqttClient.publish(topic, JSON.stringify({ value }), (err) => {
    if (err) log(`MQTT publish failed on ${topic}: ${err.message}`, 'ERROR');
  });
  return true;
}

function setESSMode(mode) {
  if (currentESSMode === mode) return;
  const names = { 1: 'Optimize+BatteryLife', 9: 'Keep Charged', 10: 'Optimize-BatteryLife' };
  log(`ESS mode: ${currentESSMode} → ${mode} (${names[mode] || 'unknown'})`);
  mqttPublish(MQTT_TOPICS.ESS_MODE_WRITE, mode);
  currentESSMode = mode;
}

function setInverterMode(mode) {
  if (!mode || currentInverterMode === mode) return;
  const names = { 1: 'Charger Only', 2: 'Inverter Only', 3: 'ON', 4: 'OFF' };
  log(`Inverter mode: ${currentInverterMode} → ${mode} (${names[mode] || 'unknown'})`);
  mqttPublish(MQTT_TOPICS.INVERTER_MODE_WRITE, mode);
  currentInverterMode = mode;
}

function setGridSetpoint(watts) {
  if (currentGridSetpoint === watts) return;
  mqttPublish(MQTT_TOPICS.GRID_SETPOINT_WRITE, watts);
  currentGridSetpoint = watts;
}

function setMinSOC(soc) {
  if (currentMinSOC === soc) return;
  log(`Min SOC: ${currentMinSOC}% → ${soc}%`);
  mqttPublish(MQTT_TOPICS.MIN_SOC_WRITE, soc);
  currentMinSOC = soc;
}

function setActiveSOC(soc) {
  if (currentActiveSOC === soc) return;
  log(`Active SOC: ${currentActiveSOC}% → ${soc}%`);
  mqttPublish(MQTT_TOPICS.ACTIVE_SOC_WRITE, soc);
  currentActiveSOC = soc;
}

// ─────────────────────────── EV Charger Control ─────────────────────

function evIsConnected() {
  return evStatus >= EV_STATUS.CONNECTED && evStatus <= EV_STATUS.WAITING_START;
}

function evIsCharging() {
  return evStatus === EV_STATUS.CHARGING;
}

function evSetChargingCurrent(amps) {
  const clamped = Math.max(CONFIG.EV_MIN_CURRENT, Math.min(CONFIG.EV_MAX_CURRENT, Math.round(amps)));
  if (evSetCurrent === clamped) return;
  log(`EV current: ${evSetCurrent}A → ${clamped}A`);
  mqttPublish(MQTT_TOPICS.EV_SET_CURRENT_WRITE, clamped);
  evSetCurrent = clamped;
}

function evStart() {
  if (evStartStop === 1) return;
  log('EV: Starting charge');
  mqttPublish(MQTT_TOPICS.EV_START_STOP_WRITE, 1);
  // Set to Manual mode so we control the current
  mqttPublish(MQTT_TOPICS.EV_MODE_WRITE, 0);
  evStartStop = 1;
}

function evStop() {
  if (evStartStop === 0) return;
  log('EV: Stopping charge');
  mqttPublish(MQTT_TOPICS.EV_START_STOP_WRITE, 0);
  evStartStop = 0;
}

// ─────────────────────────── Event Logging ──────────────────────────

async function logSmartEvent(eventType, description, extra = {}) {
  try {
    const query = `
      INSERT INTO victron_tariff_events (
        device_id, event_type, from_period, to_period,
        from_setpoint, to_setpoint, from_ess_mode, to_ess_mode,
        battery_soc, reason
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;

    await dbClient.query(query, [
      DEVICE_ID, eventType,
      extra.fromPeriod || previousRateClass,
      extra.toPeriod || currentRateClass,
      extra.fromSetpoint || currentGridSetpoint,
      extra.toSetpoint || currentGridSetpoint,
      extra.fromESS || currentESSMode,
      extra.toESS || currentESSMode,
      currentSOC, description,
    ]);
  } catch (err) {
    log(`Event log failed: ${err.message}`, 'ERROR');
  }
}

async function logEVEvent(action, description) {
  try {
    const query = `
      INSERT INTO victron_ev_events (
        device_id, event_type, ev_status, ev_power_watts,
        ev_current_amps, battery_soc, solar_power_watts,
        grid_power_watts, description
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;

    await dbClient.query(query, [
      DEVICE_ID, action, evStatus, evPower,
      evCurrent, currentSOC, solarPower,
      gridPower, description,
    ]);
  } catch (err) {
    // Table may not exist yet — non-critical
    if (!err.message.includes('does not exist')) {
      log(`EV event log failed: ${err.message}`, 'ERROR');
    }
  }
}

// ─────────────────────────── Strategy Engine ────────────────────────

/**
 * Determine and apply the optimal strategy based on current Octopus rate.
 * Called every STRATEGY_INTERVAL ms.
 */
async function applyStrategy() {
  if (!isRunning) return;

  const rateClass = classifyCurrentRate();

  // Reload advisor decision on rate transitions or first run
  if (rateClass !== currentRateClass || !advisorDecisionLoaded) {
    await loadAdvisorDecision();
  }

  // Detect rate class transition
  if (rateClass !== currentRateClass) {
    previousRateClass = currentRateClass;
    currentRateClass = rateClass;
    log(`═══ RATE CHANGE: ${previousRateClass} → ${rateClass} (import=${currentImportRate.toFixed(1)}p, export=${currentExportRate.toFixed(1)}p) ═══`);
    await logSmartEvent('rate_change', `${previousRateClass}→${rateClass} @${currentImportRate.toFixed(1)}p`, {
      fromPeriod: previousRateClass,
      toPeriod: rateClass,
    });
  }

  let strategy, evAction;

  switch (rateClass) {
    case 'CHEAP':
      ({ strategy, evAction } = cheapRateStrategy());
      break;
    case 'EXPENSIVE':
      ({ strategy, evAction } = expensiveRateStrategy());
      break;
    case 'NORMAL':
    default:
      // Use solar availability to pick day-like vs evening-like behaviour
      if (solarPower > CONFIG.SOLAR_AVAILABLE_THRESHOLD) {
        ({ strategy, evAction } = normalSolarStrategy());
      } else {
        ({ strategy, evAction } = normalNoSolarStrategy());
      }
      break;
  }

  // Log strategy change
  if (strategy !== lastStrategy) {
    log(`Strategy: ${strategy} | SOC=${currentSOC}% Grid=${gridPower}W Solar=${solarPower}W Load=${loadPower}W Batt=${batteryPower}W`);
    log(`  Rate: ${currentImportRate.toFixed(1)}p import, ${currentExportRate.toFixed(1)}p export | EV: status=${evStatus} power=${evPower}W action=${evAction}`);
    await logSmartEvent('strategy_change', `${strategy} (EV: ${evAction})`);
    lastStrategy = strategy;
  }

  if (evAction !== lastEvAction && evIsConnected()) {
    await logEVEvent(evAction, `Strategy=${strategy}, SOC=${currentSOC}%, Solar=${solarPower}W, Rate=${currentImportRate.toFixed(1)}p`);
    lastEvAction = evAction;
  }
}

// ─── CHEAP rate: charge battery + EV from grid ───
// Respects strategy advisor decision (skip/partial/full charge)

function cheapRateStrategy() {
  let strategy = 'cheap_charging';
  let evAction = 'none';
  const decision = advisorDecision;

  // Check if advisor says to skip night charging
  if (decision && decision.action === 'skip_night_charge') {
    // Don't charge battery from grid — solar will handle it tomorrow
    setESSMode(ESS_MODES.OPTIMIZE_WITH_BATTERYLIFE);
    setInverterMode(INVERTER_MODES.ON);
    setMinSOC(10);
    setGridSetpoint(CONFIG.IMPORT_BIAS_WATTS);
    strategy = 'cheap_skip_charge_solar_expected';
    log(`Advisor: skipping night charge (${decision.confidence} confidence) — ${decision.reasoning}`);

  } else if (decision && decision.action === 'partial_charge' && decision.target_soc) {
    // Partial charge — charge to target SOC then stop
    setESSMode(ESS_MODES.KEEP_BATTERIES_CHARGED);
    setInverterMode(INVERTER_MODES.ON);
    setMinSOC(10);

    if (currentSOC < decision.target_soc) {
      setGridSetpoint(CONFIG.MAX_GRID_CHARGE_WATTS);
      strategy = `cheap_partial_charge_to_${decision.target_soc}`;
    } else {
      // Target reached — stop grid charging
      setESSMode(ESS_MODES.OPTIMIZE_WITH_BATTERYLIFE);
      setGridSetpoint(CONFIG.IMPORT_BIAS_WATTS);
      strategy = `cheap_partial_target_reached_${decision.target_soc}`;
    }

  } else {
    // Default: full charge from grid
    setESSMode(ESS_MODES.KEEP_BATTERIES_CHARGED);
    setInverterMode(INVERTER_MODES.ON);
    setMinSOC(10);

    if (currentSOC < CONFIG.NIGHT_TARGET_SOC) {
      setGridSetpoint(CONFIG.MAX_GRID_CHARGE_WATTS);
      strategy = 'cheap_full_charge_battery';
    } else {
      setGridSetpoint(CONFIG.IMPORT_BIAS_WATTS);
      strategy = 'cheap_battery_full';
    }
  }

  // EV: always charge at max during cheap rate regardless of advisor
  if (evIsConnected()) {
    evStart();
    evSetChargingCurrent(CONFIG.EV_MAX_CURRENT);
    evAction = 'charge_max';
    strategy += '+ev_max';
  }

  return { strategy, evAction };
}

// ─── NORMAL rate + solar: self-consumption + anti-export ───

function normalSolarStrategy() {
  let strategy = 'normal_solar_self_consumption';
  let evAction = 'none';

  setESSMode(ESS_MODES.OPTIMIZE_WITHOUT_BATTERYLIFE);
  setInverterMode(INVERTER_MODES.ON);
  setMinSOC(10);

  if (currentSOC < CONFIG.LOW_SOC_THRESHOLD) {
    // Low battery — charge from grid regardless of rate
    setGridSetpoint(CONFIG.MAX_GRID_CHARGE_WATTS);
    strategy = 'normal_emergency_charge';
  } else if (currentSOC >= CONFIG.FULL_SOC_THRESHOLD) {
    // Battery full — hold for peak export, do not export now
    setGridSetpoint(CONFIG.IMPORT_BIAS_WATTS);
    strategy = 'normal_battery_full_hold_for_peak';
  } else {
    // Slight import bias to prevent export, battery absorbs solar surplus
    setGridSetpoint(CONFIG.IMPORT_BIAS_WATTS);
    strategy = 'normal_solar_anti_export';
  }

  // EV: solar surplus diversion
  if (evIsConnected()) {
    const solarSurplus = solarPower - loadPower;
    if (solarSurplus >= CONFIG.EV_SOLAR_SURPLUS_MIN) {
      // Enough solar surplus — divert to EV
      const surplusAmps = Math.floor(solarSurplus / CONFIG.GRID_VOLTAGE);
      evStart();
      evSetChargingCurrent(surplusAmps);
      evAction = `charge_solar_${surplusAmps}A`;
      strategy += '+ev_solar';
    } else if (currentSOC >= CONFIG.EV_BATTERY_SOC_THRESHOLD && solarPower > 500) {
      // Some solar + good battery — EV at minimum
      evStart();
      evSetChargingCurrent(CONFIG.EV_MIN_CURRENT);
      evAction = 'charge_min';
      strategy += '+ev_min';
    } else {
      // Insufficient surplus — pause EV to preserve battery
      evStop();
      evAction = 'paused_no_surplus';
    }
  }

  return { strategy, evAction };
}

// ─── EXPENSIVE rate: maximum export from battery ───

function expensiveRateStrategy() {
  let strategy = 'expensive_export';
  let evAction = 'none';

  setInverterMode(INVERTER_MODES.ON);
  setMinSOC(CONFIG.PEAK_MIN_SOC);

  // Always export at max during peak — MinSOC protects the battery
  setESSMode(ESS_MODES.OPTIMIZE_WITHOUT_BATTERYLIFE);
  setGridSetpoint(-CONFIG.MAX_EXPORT_WATTS);
  strategy = 'expensive_max_export';

  // EV: NEVER charge from grid during peak (expensive!)
  if (evIsConnected() && evIsCharging()) {
    // Only continue EV if solar is covering it
    if (solarPower > evPower + loadPower) {
      evAction = 'charge_solar_only';
      // Let it continue — solar is covering EV
    } else {
      evStop();
      evAction = 'paused_expensive';
    }
  }

  return { strategy, evAction };
}

// ─── NORMAL rate + no solar: self-consumption, preserve battery ───

function normalNoSolarStrategy() {
  let strategy = 'normal_nosolar_self_consumption';
  let evAction = 'none';

  setESSMode(ESS_MODES.OPTIMIZE_WITH_BATTERYLIFE);
  setInverterMode(INVERTER_MODES.ON);
  setMinSOC(CONFIG.EVENING_MIN_SOC);

  // Anti-export: keep grid setpoint at slight import
  setGridSetpoint(CONFIG.IMPORT_BIAS_WATTS);

  if (currentSOC <= CONFIG.EVENING_MIN_SOC) {
    // Battery critical — keep import bias, ESS BatteryLife will handle grid import
    strategy = 'evening_low_soc';
  }

  // EV: charge at low rate if battery is healthy
  if (evIsConnected()) {
    if (currentSOC > CONFIG.EV_BATTERY_SOC_THRESHOLD) {
      evStart();
      evSetChargingCurrent(CONFIG.EV_MIN_CURRENT);
      evAction = 'charge_min_evening';
      strategy += '+ev_min';
    } else {
      evStop();
      evAction = 'paused_preserve_battery';
    }
  }

  return { strategy, evAction };
}

// ─────────────────────── Anti-Export Feedback Loop ───────────────────

/**
 * Fast feedback loop that dynamically adjusts grid setpoint
 * to prevent unwanted exports during non-peak periods.
 * Runs every FEEDBACK_INTERVAL ms.
 */
function antiExportFeedback() {
  if (!isRunning || !currentRateClass) return;

  // Only intervene when rate is not expensive (we WANT to export then)
  if (currentRateClass === 'EXPENSIVE') return;

  // If we're exporting (grid power is negative)
  if (gridPower < CONFIG.ANTI_EXPORT_THRESHOLD) {
    const exportWatts = Math.abs(gridPower);

    if (currentSOC < CONFIG.FULL_SOC_THRESHOLD) {
      // Battery not full — absorb export into battery
      const newSetpoint = Math.round(exportWatts + CONFIG.IMPORT_BIAS_WATTS);
      const clampedSetpoint = Math.min(newSetpoint, CONFIG.MAX_GRID_CHARGE_WATTS);

      if (clampedSetpoint > currentGridSetpoint) {
        log(`Anti-export: grid=${gridPower}W, raising setpoint ${currentGridSetpoint}→${clampedSetpoint}W to charge battery`);
        setGridSetpoint(clampedSetpoint);
      }
    } else if (evIsConnected() && !evIsCharging()) {
      // Battery full but EV connected — divert to EV
      const surplusAmps = Math.floor(exportWatts / CONFIG.GRID_VOLTAGE);
      if (surplusAmps >= CONFIG.EV_MIN_CURRENT) {
        log(`Anti-export: battery full, diverting ${exportWatts}W to EV (${surplusAmps}A)`);
        evStart();
        evSetChargingCurrent(surplusAmps);
      }
    }
    // else: battery full, no EV → allow export (nothing better to do)
  }
}

// ─────────────────────────── MQTT Connection ────────────────────────

function connectMQTT() {
  log(`Connecting to MQTT broker: ${MQTT_BROKER}`);
  mqttClient = mqtt.connect(MQTT_BROKER);

  mqttClient.on('connect', () => {
    log('Connected to MQTT broker');

    // Subscribe to all N/ (monitor) topics
    const monitorTopics = Object.values(MQTT_TOPICS).filter(t => t.startsWith('N/'));
    mqttClient.subscribe(monitorTopics, (err) => {
      if (err) {
        log(`MQTT subscribe error: ${err.message}`, 'ERROR');
      } else {
        log(`Subscribed to ${monitorTopics.length} topics (incl. EVCS)`);
      }
    });
  });

  mqttClient.on('message', (topic, message) => {
    try {
      const data = JSON.parse(message.toString());
      const value = data.value;
      if (value === null || value === undefined) return;

      switch (topic) {
        // Battery
        case MQTT_TOPICS.BATTERY_SOC:     currentSOC = value; break;
        case MQTT_TOPICS.BATTERY_VOLTAGE: currentVoltage = value; break;
        case MQTT_TOPICS.BATTERY_CURRENT: currentCurrent = value; break;
        case MQTT_TOPICS.BATTERY_POWER:   batteryPower = value; break;

        // Grid & Solar & Load
        case MQTT_TOPICS.GRID_POWER:  gridPower = value; break;
        case MQTT_TOPICS.SOLAR_POWER: solarPower = value; break;
        case MQTT_TOPICS.LOAD_POWER:  loadPower = value; break;

        // ESS feedback
        case MQTT_TOPICS.ESS_MODE_READ:     currentESSMode = value; break;
        case MQTT_TOPICS.INVERTER_MODE_READ: currentInverterMode = value; break;
        case MQTT_TOPICS.MIN_SOC_READ:      currentMinSOC = value; break;
        case MQTT_TOPICS.ACTIVE_SOC_READ:   currentActiveSOC = value; break;

        // EV Charger
        case MQTT_TOPICS.EV_STATUS:      evStatus = value; break;
        case MQTT_TOPICS.EV_MODE:        evMode = value; break;
        case MQTT_TOPICS.EV_POWER:       evPower = value; break;
        case MQTT_TOPICS.EV_CURRENT:     evCurrent = value; break;
        case MQTT_TOPICS.EV_MAX_CURRENT: evMaxCurrent = value; break;
        case MQTT_TOPICS.EV_SET_CURRENT: evSetCurrent = value; break;
        case MQTT_TOPICS.EV_ENERGY:      evEnergy = value; break;
        case MQTT_TOPICS.EV_START_STOP:  evStartStop = value; break;
      }
    } catch (err) {
      // Ignore parse errors for non-JSON messages
    }
  });

  mqttClient.on('error', (err) => log(`MQTT error: ${err.message}`, 'ERROR'));
  mqttClient.on('close', () => log('MQTT connection closed'));
  mqttClient.on('reconnect', () => log('MQTT reconnecting...', 'WARN'));
}

// ─────────────────────────── Lifecycle ───────────────────────────────

async function start() {
  if (isRunning) {
    log('Smart controller already running', 'WARN');
    return;
  }

  log('╔══════════════════════════════════════════════════════╗');
  log('║  Starting Victron Smart ESS Controller              ║');
  log('║  IMPORTANT: Ensure DESS is disabled in VRM!         ║');
  log('╚══════════════════════════════════════════════════════╝');

  isRunning = true;

  // Database
  const dbOk = await initializeDatabase();
  if (!dbOk) {
    isRunning = false;
    throw new Error('Database connection failed');
  }

  // Load rates from Octopus API
  const ratesOk = await loadRatesFromAPI();
  if (!ratesOk) {
    log('Failed to load rates — check OCTOPUS_API_KEY and OCTOPUS_ACCOUNT_NUMBER in .env', 'WARN');
  }

  // MQTT
  connectMQTT();

  // Wait for initial MQTT data
  log('Waiting 5s for initial MQTT data...');
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Classify initial rate
  currentRateClass = classifyCurrentRate();
  log(`Initial rate class: ${currentRateClass} (import=${currentImportRate.toFixed(1)}p, export=${currentExportRate.toFixed(1)}p, product=${productName})`);

  // Start strategy loop
  strategyTimer = setInterval(async () => {
    try { await applyStrategy(); }
    catch (err) { log(`Strategy error: ${err.message}`, 'ERROR'); }
  }, CONFIG.STRATEGY_INTERVAL);

  // Start anti-export feedback loop (faster)
  feedbackTimer = setInterval(() => {
    try { antiExportFeedback(); }
    catch (err) { log(`Feedback error: ${err.message}`, 'ERROR'); }
  }, CONFIG.FEEDBACK_INTERVAL);

  // Periodic rate refresh from Octopus API
  rateRefreshTimer = setInterval(async () => {
    try { await refreshRates(); }
    catch (err) { log(`Rate refresh error: ${err.message}`, 'ERROR'); }
  }, CONFIG.RATE_REFRESH_INTERVAL);

  // Run strategy immediately
  await applyStrategy();

  log(`Smart controller running. Product=${productName}, strategy every ${CONFIG.STRATEGY_INTERVAL / 1000}s, feedback every ${CONFIG.FEEDBACK_INTERVAL / 1000}s, rate refresh every ${CONFIG.RATE_REFRESH_INTERVAL / 60000}min`);
}

async function stop() {
  if (!isRunning) return;
  log('Stopping Smart Controller...');
  isRunning = false;

  if (strategyTimer) { clearInterval(strategyTimer); strategyTimer = null; }
  if (feedbackTimer) { clearInterval(feedbackTimer); feedbackTimer = null; }
  if (rateRefreshTimer) { clearInterval(rateRefreshTimer); rateRefreshTimer = null; }

  // Return to safe defaults
  if (mqttClient && mqttClient.connected) {
    setESSMode(ESS_MODES.OPTIMIZE_WITH_BATTERYLIFE);
    setInverterMode(INVERTER_MODES.ON);
    setGridSetpoint(0);
    setMinSOC(10);
    mqttClient.end();
    mqttClient = null;
  }

  if (dbClient && !dbClient._ending) {
    try { await dbClient.end(); } catch (e) { /* ignore */ }
  }

  log('Smart controller stopped');
}

async function gracefulShutdown(signal) {
  log(`Received ${signal}, shutting down gracefully...`);
  await stop();
  process.exit(0);
}

// ─────────────────────────── Export & Main ───────────────────────────

module.exports = { start, stop };

if (require.main === module) {
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  start().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
