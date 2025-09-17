const mqtt = require('mqtt');
const cron = require('node-cron');
const { Client } = require('pg');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

const MQTT_BROKER = process.env.MQTT_BROKER;
const DEVICE_ID = process.env.DEVICE_ID;

// Database configuration
const DB_CONFIG = {
  user: process.env.DB_USER || "postgres",
  host: process.env.DB_HOST || "localhost",
  database: process.env.DB_NAME || "victron",
  password: process.env.DB_PASSWORD || "password",
  port: process.env.DB_PORT || 5433,
};

const dbClient = new Client(DB_CONFIG);
const LOG_FILE = path.join(__dirname, "../logs/victron-controller.log");

// Initialize database tables if needed
async function initializeDatabase() {
  try {
    // Connect and test
    await dbClient.connect();
    await dbClient.query('SELECT NOW()');
    log('Database connection successful');
    return true;
  } catch (error) {
    log(`Database connection failed: ${error.message}`, "ERROR");
    return false;
  }
}

// Dynamic tariff configuration - loaded from database
let TARIFF = {};

// Load tariff configuration from database
async function loadTariffConfig() {
  try {
    // Get tariff periods
    const periodsQuery = `
      SELECT period_name, import_rate_pence, export_rate_pence, start_time, end_time 
      FROM victron_tariff_periods 
      WHERE is_active = true
      ORDER BY period_name
    `;
    const periodsResult = await dbClient.query(periodsQuery);
    
    // Get grid setpoints
    const setpointsQuery = `
      SELECT tariff_period, grid_setpoint_watts, min_soc_percent, max_soc_percent, 
             active_soc_percent, ess_mode, inverter_mode, description
      FROM victron_grid_setpoints 
      WHERE device_id = $1 AND is_active = true
    `;
    const setpointsResult = await dbClient.query(setpointsQuery, [DEVICE_ID]);
    
    // Build TARIFF object
    const newTariff = {};
    
    for (const period of periodsResult.rows) {
      const setpoint = setpointsResult.rows.find(s => s.tariff_period === period.period_name);
      
      console.log(`Processing period: ${period.period_name}, found setpoint:`, setpoint);
      
      if (setpoint) {
        newTariff[period.period_name] = {
          importRate: parseFloat(period.import_rate_pence),
          exportRate: parseFloat(period.export_rate_pence),
          startTime: period.start_time,
          endTime: period.end_time,
          gridSetpoint: parseInt(setpoint.grid_setpoint_watts),
          minSOC: parseFloat(setpoint.min_soc_percent),
          maxSOC: parseFloat(setpoint.max_soc_percent),
          activeSOC: setpoint.active_soc_percent ? parseFloat(setpoint.active_soc_percent) : 50.0,
          essMode: parseInt(setpoint.ess_mode),
          inverterMode: parseInt(setpoint.inverter_mode),
          description: setpoint.description
        };
        console.log(`Created config for ${period.period_name}:`, newTariff[period.period_name]);
      } else {
        console.log(`No setpoint found for period: ${period.period_name}`);
      }
    }
    
    TARIFF = newTariff;
    log(`Loaded ${Object.keys(TARIFF).length} tariff periods from database`);
    
    // Log current configuration
    for (const [name, config] of Object.entries(TARIFF)) {
      log(`${name}: ${config.startTime}-${config.endTime}, setpoint: ${config.gridSetpoint}W, ESS: ${config.essMode}, Inv: ${config.inverterMode}`);
    }
    
    return true;
  } catch (error) {
    log(`Failed to load tariff config: ${error.message}`, "ERROR");
    return false;
  }
}

function stopSetpointAdjuster() {
  if (setpointAdjustTimer) {
    clearInterval(setpointAdjustTimer);
    setpointAdjustTimer = null;
    log('Stopped setpoint feedback adjuster');
  }
}


// ESS Modes (Settings/CGwacs/BatteryLife/State) - Controls ESS behavior
const ESS_MODES = {
  OPTIMIZE_WITH_BATTERYLIFE: 1,     // Optimized mode with BatteryLife enabled
  KEEP_BATTERIES_CHARGED: 9,        // Keep batteries charged mode
  OPTIMIZE_WITHOUT_BATTERYLIFE: 10  // Optimized mode without BatteryLife
};

// Inverter Modes (vebus/0/Mode) - Controls inverter operation
const INVERTER_MODES = {
  CHARGER_ONLY: 1,        // Charger only mode (no inverting)
  INVERTER_ONLY: 2,       // Inverter only mode (no charging)
  ON: 3,                  // Normal operation (charge and invert)
  OFF: 4                  // Inverter off
};

// MQTT Topics for control and monitoring
const MQTT_TOPICS = {
  // Control topics (write)
  ESS_MODE_WRITE: `W/${DEVICE_ID}/settings/0/Settings/CGwacs/BatteryLife/State`,
  INVERTER_MODE_WRITE: `W/${DEVICE_ID}/vebus/276/Mode`,
  GRID_SETPOINT_WRITE: `W/${DEVICE_ID}/settings/0/Settings/CGwacs/AcPowerSetPoint`,
  HUB4_MODE_WRITE: `W/${DEVICE_ID}/settings/0/Settings/CGwacs/Hub4Mode`,
  MIN_SOC_WRITE: `W/${DEVICE_ID}/settings/0/Settings/CGwacs/BatteryLife/MinimumSocLimit`,
  MAX_SOC_WRITE: `W/${DEVICE_ID}/settings/0/Settings/CGwacs/MaxChargeCurrent`,
  ACTIVE_SOC_WRITE: `W/${DEVICE_ID}/settings/0/Settings/CGwacs/BatteryLife/SocLimit`,
  
  // ESS Mode 2 control registers (higher priority than direct inverter control)
  ESS_DISABLE_CHARGE: `W/${DEVICE_ID}/settings/0/Settings/CGwacs/MaxChargeCurrent`,
  ESS_DISABLE_INVERTER: `W/${DEVICE_ID}/settings/0/Settings/CGwacs/MaxDischargePower`,
  
  // Monitor topics (read)
  BATTERY_SOC: `N/${DEVICE_ID}/vebus/276/Soc`,
  BATTERY_VOLTAGE: `N/${DEVICE_ID}/system/0/Dc/Battery/Voltage`,
  BATTERY_CURRENT: `N/${DEVICE_ID}/system/0/Dc/Battery/Current`,
  BATTERY_POWER: `N/${DEVICE_ID}/system/0/Dc/Battery/Power`,
  GRID_POWER: `N/${DEVICE_ID}/system/0/Ac/Grid/L1/Power`,
  GRID_IMPORT: `N/${DEVICE_ID}/system/0/Ac/Consumption/L1/Power`,
  SOLAR_POWER: `N/${DEVICE_ID}/system/0/Dc/Pv/Power`,
  LOAD_POWER: `N/${DEVICE_ID}/system/0/Ac/Consumption/L1/Power`,
  ESS_MODE_READ: `N/${DEVICE_ID}/settings/0/Settings/CGwacs/BatteryLife/State`,
  INVERTER_MODE_READ: `N/${DEVICE_ID}/vebus/276/Mode`,
  SYSTEM_STATE: `N/${DEVICE_ID}/vebus/276/State`,
  MIN_SOC_READ: `N/${DEVICE_ID}/settings/0/Settings/CGwacs/BatteryLife/MinimumSocLimit`,
  MAX_SOC_READ: `N/${DEVICE_ID}/settings/0/Settings/CGwacs/MaxChargeCurrent`,
  ACTIVE_SOC_READ: `N/${DEVICE_ID}/settings/0/Settings/CGwacs/BatteryLife/SocLimit`,
  
};

// System state variables
let currentSOC = 0;
let currentMode = 0;  // ESS mode
let currentInverterMode = 0;  // Inverter mode
let currentMinSOC = 0;  // Current minimum SOC setting
let currentMaxSOC = 100;  // Current maximum SOC setting
let currentActiveSOC = 50;  // Current active SOC setting
let currentVoltage = 0;
let currentCurrent = 0;
let currentPower = 0;
let gridPower = 0;
let solarPower = 0;
let loadPower = 0;
let currentTariffPeriod = null;
let currentGridSetpoint = 0;
let mqttClient = null;
let setpointAdjustTimer = null;


// Logging helper
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
  } catch (err) {
    console.error(`Failed to write log: ${err.message}`);
  }
}

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
        vtp.end_time,
        vgs.grid_setpoint_watts,
        vgs.min_soc_percent,
        vgs.max_soc_percent,
        vgs.active_soc_percent,
        vgs.ess_mode,
        vgs.inverter_mode,
        vgs.description
      FROM victron_tariff_periods vtp 
      JOIN victron_grid_setpoints vgs ON vtp.period_name = vgs.tariff_period 
      WHERE vtp.is_active = true AND vgs.is_active = true
        AND (
          -- Handle overnight periods (start_time > end_time)
          (vtp.start_time > vtp.end_time AND ($1::time >= vtp.start_time OR $1::time < vtp.end_time))
          OR
          -- Handle normal periods (start_time <= end_time)  
          (vtp.start_time <= vtp.end_time AND $1::time >= vtp.start_time AND $1::time < vtp.end_time)
        )
      ORDER BY 
        CASE vtp.period_name 
          WHEN 'Night' THEN 1
          WHEN 'Day' THEN 2  
          WHEN 'PEAK' THEN 3
          WHEN 'Evening' THEN 4
        END
      LIMIT 1
    `;
    
    const result = await dbClient.query(query, [currentTime]);
    
    if (result.rows.length > 0) {
      const row = result.rows[0];
      return row.period_name;
    }
    
    // Fallback: load all periods and use Day as default
    await loadTariffConfig();
    return 'Day';
    
  } catch (error) {
    log(`Failed to get current tariff period: ${error.message}`, "ERROR");
    // Fallback to loading all config
    if (Object.keys(TARIFF).length === 0) {
      await loadTariffConfig();
    }
    return 'Day';
  }
}

// Set ESS mode (Settings/CGwacs/BatteryLife/State) - Controls ESS behavior
function setESSMode(mode) {
  if (!mqttClient || !mqttClient.connected) {
    log('MQTT client not connected, cannot set ESS mode', "ERROR");
    return false;
  }
  
  const modeNames = {
    1: 'Optimize with BatteryLife',
    9: 'Keep batteries charged', 
    10: 'Optimize without BatteryLife'
  };
  
  log(`Setting ESS mode to ${mode} (${modeNames[mode] || 'UNKNOWN'})`);
  
  const payload = JSON.stringify({ value: mode });
  mqttClient.publish(MQTT_TOPICS.ESS_MODE_WRITE, payload, (err) => {
    if (err) {
      log(`Failed to set ESS mode: ${err.message}`, "ERROR");
    } 
    // else {
    //   log('ESS mode command sent successfully');
    // }
  });
  return true;
}

// Set Inverter Mode (vebus/276/Mode) - Controls inverter operation
function setInverterMode(mode) {
  if (!mqttClient || !mqttClient.connected || mode == 0) {
    log(`MQTT client not connected, cannot set inverter mode. mode: ${mode}`, "ERROR");
    return false;
  }
  
  // Skip if already at target mode
  if (currentInverterMode === mode) {
    log(`Inverter already at mode ${mode}, skipping`);
    return true;
  }
  
  // Warning for potentially conflicting modes with ESS
  if (mode === INVERTER_MODES.INVERTER_ONLY && currentMode === ESS_MODES.OPTIMIZE_WITH_BATTERYLIFE) {
    log(`WARNING: Setting Inverter-Only mode while ESS is in Optimize mode may cause conflicts`, "WARN");
  }
  
  const modeNames = {
    1: 'Charger Only',
    2: 'Inverter Only', 
    3: 'ON (Normal operation)',
    4: 'OFF'
  };
  
  log(`Setting inverter mode from ${currentInverterMode} to ${mode} (${modeNames[mode] || 'Unknown mode'})`);
  log(`Publishing to MQTT topic: ${MQTT_TOPICS.INVERTER_MODE_WRITE}`);
  const payload = JSON.stringify({ value: mode });
  mqttClient.publish(MQTT_TOPICS.INVERTER_MODE_WRITE, payload, (err) => {
    if (err) log(`Failed to set inverter mode: ${err.message}`, "ERROR");
    else log('Inverter mode command sent successfully');
  });
  return true;
}

// Set minimum SOC
function setMinSOC(socPercent) {
  if (!mqttClient || !mqttClient.connected) {
    log('MQTT client not connected, cannot set minimum SOC', "ERROR");
    return false;
  }

  // Skip if already at target minSOC
  if (currentMinSOC === socPercent) {
    log(`MinSOC already at ${socPercent}%, skipping`);
    return true;
  }

  log(`Setting minimum SOC from ${currentMinSOC}% to ${socPercent}%`);
  log(`Publishing to MQTT topic: ${MQTT_TOPICS.MIN_SOC_WRITE}`);
  
  const payload = JSON.stringify({ value: socPercent });
  mqttClient.publish(MQTT_TOPICS.MIN_SOC_WRITE, payload, (err) => {
    if (err) {
      log(`Failed to set minimum SOC: ${err.message}`, "ERROR");
    } else {
      log(`Minimum SOC command sent successfully`);
      currentMinSOC = socPercent;
    }
  });
  
  return true;
}

// Set maximum SOC
function setMaxSOC(socPercent) {
  if (!mqttClient || !mqttClient.connected) {
    log('MQTT client not connected, cannot set maximum SOC', "ERROR");
    return false;
  }

  // Skip if already at target maxSOC
  if (currentMaxSOC === socPercent) {
    log(`MaxSOC already at ${socPercent}%, skipping`);
    return true;
  }

  log(`Setting maximum SOC from ${currentMaxSOC}% to ${socPercent}%`);
  log(`Publishing to MQTT topic: ${MQTT_TOPICS.MAX_SOC_WRITE}`);
  
  const payload = JSON.stringify({ value: socPercent });
  mqttClient.publish(MQTT_TOPICS.MAX_SOC_WRITE, payload, (err) => {
    if (err) {
      log(`Failed to set maximum SOC: ${err.message}`, "ERROR");
    } else {
      log(`Maximum SOC command sent successfully`);
      currentMaxSOC = socPercent;
    }
  });
  
  return true;
}

// Set active SOC limit
function setActiveSOC(socPercent) {
  if (!mqttClient || !mqttClient.connected) {
    log('MQTT client not connected, cannot set active SOC', "ERROR");
    return false;
  }

  // Skip if already at target activeSOC
  if (currentActiveSOC === socPercent) {
    log(`ActiveSOC already at ${socPercent}%, skipping`);
    return true;
  }

  log(`Setting active SOC from ${currentActiveSOC}% to ${socPercent}%`);
  log(`Publishing to MQTT topic: ${MQTT_TOPICS.ACTIVE_SOC_WRITE}`);
  
  const payload = JSON.stringify({ value: socPercent });
  mqttClient.publish(MQTT_TOPICS.ACTIVE_SOC_WRITE, payload, (err) => {
    if (err) {
      log(`Failed to set active SOC: ${err.message}`, "ERROR");
    } else {
      log(`Active SOC command sent successfully`);
      currentActiveSOC = socPercent;
    }
  });
  
  return true;
}

// Set grid setpoint
function setGridSetpoint(watts) {
  if (!mqttClient || !mqttClient.connected) {
    log('MQTT client not connected, cannot set grid setpoint', "ERROR");
    return false;
  }

  log(`Setting grid setpoint to ${watts}W`);
  
  const payload = JSON.stringify({ value: watts });
  mqttClient.publish(MQTT_TOPICS.GRID_SETPOINT_WRITE, payload, (err) => {
    if (err) {
      log(`Failed to set grid setpoint: ${err.message}`, "ERROR");
    } else {
      log(`Grid setpoint command sent successfully`);
      currentGridSetpoint = watts;
    }
  });
  
  return true;
}

// Database logging functions
async function logTariffEvent(eventType, description, fromPeriod = null, toPeriod = null) {
  try {
    const query = `
      INSERT INTO victron_tariff_events (
        device_id, event_type, from_period, to_period, from_setpoint, to_setpoint,
        from_ess_mode, to_ess_mode, battery_soc, reason
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `;
    
    const tariffConfig = TARIFF[toPeriod || currentTariffPeriod];
    
    await dbClient.query(query, [
      DEVICE_ID, eventType, fromPeriod, toPeriod,
      currentGridSetpoint, tariffConfig?.gridSetpoint || currentGridSetpoint,
      currentMode, tariffConfig?.essMode || currentMode,
      currentSOC, description
    ]);
  } catch (err) {
    log(`Failed to log tariff event: ${err.message}`, "ERROR");
  }
}

// Log charge events to victron_charge_events table
async function logChargeEvent(eventType, description, options = {}) {
  try {
    const query = `
      INSERT INTO victron_charge_events (
        device_id, event_type, event_description, battery_soc, 
        ess_mode_before, ess_mode_after, battery_power, battery_voltage, 
        battery_current, in_charging_window, should_charge, is_charging,
        charge_session_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    `;
    
    await dbClient.query(query, [
      DEVICE_ID,
      eventType,
      description,
      currentSOC,
      options.essModeBefore || currentMode,
      options.essModeAfter || currentMode,
      currentPower,
      currentVoltage,
      currentCurrent,
      options.inChargingWindow || null,
      options.shouldCharge || null,
      options.isCharging || (currentPower > 0),
      options.chargeSessionId || null
    ]);
    
    log(`Charge event logged: ${eventType} - ${description}`);
  } catch (err) {
    log(`Failed to log charge event: ${err.message}`, "ERROR");
  }
}

// Charge session management
let currentChargeSessionId = null;

// Start a new charge session
async function startChargeSession(targetSOC, windowStart, windowEnd) {
  try {
    const query = `
      INSERT INTO victron_charge_sessions (
        device_id, start_soc, target_soc, charge_window_start, 
        charge_window_end, session_status
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `;
    
    const result = await dbClient.query(query, [
      DEVICE_ID,
      currentSOC,
      targetSOC,
      windowStart,
      windowEnd,
      'active'
    ]);
    
    currentChargeSessionId = result.rows[0].id;
    log(`Started charge session ${currentChargeSessionId}: Target ${targetSOC}%, Window ${windowStart}-${windowEnd}`);
    
    await logChargeEvent('session_start', `Charge session started with target ${targetSOC}%`, {
      chargeSessionId: currentChargeSessionId,
      inChargingWindow: true,
      shouldCharge: true
    });
    
    return currentChargeSessionId;
  } catch (err) {
    log(`Failed to start charge session: ${err.message}`, "ERROR");
    return null;
  }
}

// End current charge session
async function endChargeSession(status = 'completed') {
  if (!currentChargeSessionId) {
    return;
  }
  
  try {
    const query = `
      UPDATE victron_charge_sessions 
      SET session_end = CURRENT_TIMESTAMP,
          end_soc = $1,
          session_status = $2,
          total_charge_time_minutes = EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - session_start)) / 60,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
    `;
    
    await dbClient.query(query, [currentSOC, status, currentChargeSessionId]);
    
    log(`Ended charge session ${currentChargeSessionId}: Final SOC ${currentSOC}%, Status: ${status}`);
    
    await logChargeEvent('session_end', `Charge session ended with SOC ${currentSOC}%`, {
      chargeSessionId: currentChargeSessionId,
      inChargingWindow: false,
      shouldCharge: false,
      isCharging: false
    });
    
    currentChargeSessionId = null;
  } catch (err) {
    log(`Failed to end charge session: ${err.message}`, "ERROR");
  }
}


// Main tariff-based control logic
async function applyTariffStrategy() {
  const newPeriod = await getCurrentTariffPeriod();
  const tariffConfig = TARIFF[newPeriod];
  // console.log(`Applying tariff strategy for ${newPeriod}: ${JSON.stringify(tariffConfig)}`);
  // console.log(`Available TARIFF periods: ${JSON.stringify(Object.keys(TARIFF))}`);
  // Check if tariff period changed
  if (newPeriod !== currentTariffPeriod) {
    // log(`Tariff period changed: ${currentTariffPeriod} -> ${newPeriod}`);
    await logTariffEvent('period_change', `Tariff period changed to ${newPeriod}`, currentTariffPeriod, newPeriod);
    await logChargeEvent('period_change', `Tariff period changed from ${currentTariffPeriod} to ${newPeriod}`, {
      inChargingWindow: newPeriod === 'Night',
      shouldCharge: newPeriod === 'Night' && currentSOC < (tariffConfig?.targetSOC || 70)
    });
    currentTariffPeriod = newPeriod;
  }
  
  // log(`Current period: ${newPeriod} - ${tariffConfig.description}`);
  // log(`SOC: ${currentSOC}%, Min: ${tariffConfig.minSOC}%, Active: ${tariffConfig.activeSOC}%, Max: ${tariffConfig.maxSOC}%`);
  // log(`Grid: ${gridPower}W, Solar: ${solarPower}W, Battery: ${currentPower}W, Load: ${loadPower}W`);
  // log(`Current ESS Mode: ${currentMode}, Current Inverter Mode: ${currentInverterMode}, Current MinSOC: ${currentMinSOC}%, Current ActiveSOC: ${currentActiveSOC}%, Current MaxSOC: ${currentMaxSOC}%`);
  
  let needsModeChange = false;
  let needsSetpointChange = false;
  let needsMinSOCChange = false;
  let needsMaxSOCChange = false;
  let needsActiveSOCChange = false;
  
  // Apply tariff-specific strategy
  switch (newPeriod) {
    case 'Night':
      // Night: Use database-configured modes
      setInverterMode(tariffConfig.inverterMode);
      if (currentMinSOC !== tariffConfig.minSOC) {
        setMinSOC(tariffConfig.minSOC);
        needsMinSOCChange = true;
      }
      if (currentMaxSOC !== tariffConfig.maxSOC) {
        setMaxSOC(tariffConfig.maxSOC);
        needsMaxSOCChange = true;
      }
      if (currentActiveSOC !== tariffConfig.activeSOC) {
        setActiveSOC(tariffConfig.activeSOC);
        needsActiveSOCChange = true;
      }
      
      // Handle charging logic
      if (tariffConfig.targetSOC && currentSOC < tariffConfig.targetSOC) {
        // Start charge session if not already active
        if (!currentChargeSessionId) {
          await startChargeSession(tariffConfig.targetSOC, '02:00', '05:00');
        }
        
        if (currentMode !== tariffConfig.essMode) {
          const oldMode = currentMode;
          setESSMode(tariffConfig.essMode);
          needsModeChange = true;
          await logChargeEvent('charging_start', `Started charging: ESS mode ${oldMode} -> ${tariffConfig.essMode}`, {
            essModeBefore: oldMode,
            essModeAfter: tariffConfig.essMode,
            inChargingWindow: true,
            shouldCharge: true,
            isCharging: true,
            chargeSessionId: currentChargeSessionId
          });
        }
        if (currentGridSetpoint !== tariffConfig.gridSetpoint) {
          setGridSetpoint(tariffConfig.gridSetpoint);
          needsSetpointChange = true;
        }
        // log(`Night charging: SOC ${currentSOC}% < target ${tariffConfig.targetSOC}%`);
      } else if (tariffConfig.targetSOC && currentSOC >= tariffConfig.targetSOC) {
        // Day/Evening: End any active charge session (outside charging window)
        if (currentChargeSessionId) {
          await endChargeSession('window_ended');
        }
        
        if (currentMode !== tariffConfig.essMode) {
          setESSMode(tariffConfig.essMode);
          needsModeChange = true;
        }
        // log(`Night target reached: SOC ${currentSOC}% >= ${tariffConfig.targetSOC}%`);
        await logChargeEvent('target_reached', `Night charging target reached: ${currentSOC}% >= ${tariffConfig.targetSOC}%`, {
          inChargingWindow: true,
          shouldCharge: false,
          isCharging: false
        });
      } else {
        // No target SOC, just set ESS mode
        if (currentMode !== tariffConfig.essMode) {
          setESSMode(tariffConfig.essMode);
          needsModeChange = true;
        }
      }
      break;
      
    case 'Day':
    case 'Evening':
      // Day/Evening: End any active charge session (outside charging window)
      if (currentChargeSessionId) {
        await endChargeSession('window_ended');
      }
      
      // Day/Evening: Use database-configured inverter mode
      setInverterMode(tariffConfig.inverterMode);
      if (currentMinSOC !== tariffConfig.minSOC) {
        setMinSOC(tariffConfig.minSOC);
        needsMinSOCChange = true;
      }
      if (currentMaxSOC !== tariffConfig.maxSOC) {
        setMaxSOC(tariffConfig.maxSOC);
        needsMaxSOCChange = true;
      }
      if (currentActiveSOC !== tariffConfig.activeSOC) {
        setActiveSOC(tariffConfig.activeSOC);
        needsActiveSOCChange = true;
      }
      if (currentMode !== tariffConfig.essMode) {
        setESSMode(tariffConfig.essMode);
        needsModeChange = true;
      }
      if (currentGridSetpoint !== tariffConfig.gridSetpoint) {
        setGridSetpoint(tariffConfig.gridSetpoint);
        needsSetpointChange = true;
      }
      
      // Stop any dynamic adjustment - use exact database values
      stopSetpointAdjuster();
      break;
      
    case 'PEAK':
      // Peak: Check if SOC <= active SOC, if so switch to evening behavior immediately
      if (currentSOC <= tariffConfig.activeSOC) {
        log(`PEAK: SOC ${currentSOC}% <= active SOC ${tariffConfig.activeSOC}%, switching to evening behavior`);
        
        // Get evening tariff configuration
        const eveningConfig = TARIFF['Evening'];
        if (eveningConfig) {
          // Apply evening configuration immediately
          setInverterMode(eveningConfig.inverterMode);
          if (currentMinSOC !== eveningConfig.minSOC) {
            setMinSOC(eveningConfig.minSOC);
            needsMinSOCChange = true;
          }
          if (currentMaxSOC !== eveningConfig.maxSOC) {
            setMaxSOC(eveningConfig.maxSOC);
            needsMaxSOCChange = true;
          }
          if (currentActiveSOC !== eveningConfig.activeSOC) {
            setActiveSOC(eveningConfig.activeSOC);
            needsActiveSOCChange = true;
          }
          if (currentMode !== eveningConfig.essMode) {
            setESSMode(eveningConfig.essMode);
            needsModeChange = true;
          }
          if (currentGridSetpoint !== eveningConfig.gridSetpoint) {
            setGridSetpoint(eveningConfig.gridSetpoint);
            needsSetpointChange = true;
          }
          
          // Log the early switch to evening behavior
          await logTariffEvent('early_evening_switch', `PEAK period: SOC ${currentSOC}% <= active SOC ${tariffConfig.activeSOC}%, switched to evening behavior`);
          await logChargeEvent('peak_soc_threshold', `PEAK: Early switch to evening behavior due to low SOC`, {
            inChargingWindow: false,
            shouldCharge: false,
            isCharging: false
          });
          
          log(`PEAK: Applied evening configuration due to low SOC - ESS: ${eveningConfig.essMode}, Setpoint: ${eveningConfig.gridSetpoint}W`);
        } else {
          log(`PEAK: Evening configuration not found, using PEAK configuration`, "WARN");
          // Fallback to normal PEAK behavior
          setInverterMode(tariffConfig.inverterMode);
          if (currentMinSOC !== tariffConfig.minSOC) {
            setMinSOC(tariffConfig.minSOC);
            needsMinSOCChange = true;
          }
          if (currentMaxSOC !== tariffConfig.maxSOC) {
            setMaxSOC(tariffConfig.maxSOC);
            needsMaxSOCChange = true;
          }
          if (currentActiveSOC !== tariffConfig.activeSOC) {
            setActiveSOC(tariffConfig.activeSOC);
            needsActiveSOCChange = true;
          }
          if (currentMode !== tariffConfig.essMode) {
            setESSMode(tariffConfig.essMode);
            needsModeChange = true;
          }
          if (currentGridSetpoint !== tariffConfig.gridSetpoint) {
            setGridSetpoint(tariffConfig.gridSetpoint);
            needsSetpointChange = true;
          }
        }
      } else {
        // Normal PEAK behavior when SOC > active SOC
        log(`PEAK: SOC ${currentSOC}% > active SOC ${tariffConfig.activeSOC}%, using normal PEAK behavior`);
        setInverterMode(tariffConfig.inverterMode);
        if (currentMinSOC !== tariffConfig.minSOC) {
          setMinSOC(tariffConfig.minSOC);
          needsMinSOCChange = true;
        }
        if (currentMaxSOC !== tariffConfig.maxSOC) {
          setMaxSOC(tariffConfig.maxSOC);
          needsMaxSOCChange = true;
        }
        if (currentActiveSOC !== tariffConfig.activeSOC) {
          setActiveSOC(tariffConfig.activeSOC);
          needsActiveSOCChange = true;
        }
        if (currentMode !== tariffConfig.essMode) {
          setESSMode(tariffConfig.essMode);
          needsModeChange = true;
        }
        if (currentGridSetpoint !== tariffConfig.gridSetpoint) {
          setGridSetpoint(tariffConfig.gridSetpoint);
          needsSetpointChange = true;
        }
      }
      
      // No feedback needed in peak; set strong export target
      stopSetpointAdjuster();
      break;
  }
  
  // Log changes
  if (needsModeChange) {
    await logTariffEvent('mode_change', `ESS mode changed to ${tariffConfig.essMode} for ${newPeriod} period`);
  }
  if (needsSetpointChange) {
    await logTariffEvent('setpoint_change', `Grid setpoint changed to ${tariffConfig.gridSetpoint}W for ${newPeriod} period`);
  }
  if (needsMinSOCChange) {
    await logTariffEvent('minsoc_change', `MinSOC changed to ${tariffConfig.minSOC}% for ${newPeriod} period`);
  }
  if (needsMaxSOCChange) {
    await logTariffEvent('maxsoc_change', `MaxSOC changed to ${tariffConfig.maxSOC}% for ${newPeriod} period`);
  }
  if (needsActiveSOCChange) {
    await logTariffEvent('activesoc_change', `ActiveSOC changed to ${tariffConfig.activeSOC}% for ${newPeriod} period`);
  }
}

// Connect to MQTT broker
function connectMQTT() {
  log(`Connecting to MQTT broker: ${MQTT_BROKER}`);
  mqttClient = mqtt.connect(MQTT_BROKER);

  mqttClient.on('connect', () => {
    log('Connected to MQTT broker for Flux tariff control');
    
    // Subscribe to monitoring topics
    const topics = Object.values(MQTT_TOPICS).filter(topic => topic.startsWith('N/'));
    
    mqttClient.subscribe(topics, (err) => {
      if (err) {
        log(`Error subscribing to topics: ${err.message}`, "ERROR");
      } 
      // else {
      //   log(`Subscribed to ${topics.length} monitoring topics`);
      // }
    });
  });

  mqttClient.on('message', async (topic, message) => {
    try {
      const data = JSON.parse(message.toString());
      const value = data.value;
      
      switch (topic) {
        case MQTT_TOPICS.BATTERY_SOC:
          currentSOC = value;
          break;
        case MQTT_TOPICS.BATTERY_VOLTAGE:
          currentVoltage = value;
          break;
        case MQTT_TOPICS.BATTERY_CURRENT:
          currentCurrent = value;
          break;
        case MQTT_TOPICS.BATTERY_POWER:
          currentPower = value;
          break;
        case MQTT_TOPICS.GRID_POWER:
          gridPower = value;
          break;
        case MQTT_TOPICS.SOLAR_POWER:
          solarPower = value;
          break;
        case MQTT_TOPICS.LOAD_POWER:
          loadPower = value;
          break;
        case MQTT_TOPICS.ESS_MODE_READ:
          currentMode = value;
          break;
        case MQTT_TOPICS.INVERTER_MODE_READ:
          if (currentInverterMode !== value) {
            const modeNames = {
              1: 'Charger Only',
              2: 'Inverter Only', 
              3: 'ON (Normal operation)',
              4: 'OFF'
            };
            log(`Inverter mode changed from ${currentInverterMode} (${modeNames[currentInverterMode] || 'Unknown'}) to ${value} (${modeNames[value] || 'Unknown'}) - Device feedback`);
          }
          currentInverterMode = value;
          break;
        case MQTT_TOPICS.MIN_SOC_READ:
          if (currentMinSOC !== value) {
            log(`MinSOC changed from ${currentMinSOC}% to ${value}% - Device feedback`);
          }
          currentMinSOC = value;
          break;
        case MQTT_TOPICS.MAX_SOC_READ:
          if (currentMaxSOC !== value) {
            log(`MaxSOC changed from ${currentMaxSOC}% to ${value}% - Device feedback`);
          }
          currentMaxSOC = value;
          break;
        case MQTT_TOPICS.ACTIVE_SOC_READ:
          if (currentActiveSOC !== value) {
            log(`ActiveSOC changed from ${currentActiveSOC}% to ${value}% - Device feedback`);
          }
          currentActiveSOC = value;
          break;
      }
    } catch (err) {
      log(`Error processing message on ${topic}: ${err.message}`, "ERROR");
    }
  });

  mqttClient.on('error', (err) => {
    log(`MQTT error: ${err.message}`, "ERROR");
  });

  mqttClient.on('end', () => {
    log('MQTT client disconnected');
  });

  mqttClient.on('close', () => {
    log('MQTT client closed');
  });
}

// Simplified scheduler - single interval to check and apply tariff strategy
function setupScheduler() {
  // Check tariff strategy every 2 minutes
  setInterval(async () => {
    await applyTariffStrategy();
  }, 120000); // 2 minutes
  
  log('Simplified tariff scheduler initialized - checking every 2 minutes');
}

// Graceful shutdown
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    log(`Already shutting down, ignoring ${signal}`, "WARN");
    return;
  }
  isShuttingDown = true;
  
  log(`Shutting down Flux controller (${signal})...`);
  
  // Return to safe mode - use current tariff configuration
  if (mqttClient && mqttClient.connected) {
    // Use current tariff config for safe shutdown
    const currentTariff = TARIFF[currentTariffPeriod];
    if (currentTariff) {
      setESSMode(currentTariff.essMode);
      setInverterMode(currentTariff.inverterMode);
    }
    setGridSetpoint(0);
  }
  
  if (mqttClient) {
    mqttClient.end();
  }
  
  if (dbClient && !dbClient._ending) {
    try {
      await dbClient.end();
      log('Database client closed');
    } catch (err) {
      log(`Error closing database client: ${err.message}`, "ERROR");
    }
  }
  
  log('Flux controller shutdown complete');
  process.exit(0);
}

// Initialize MQTT client and start monitoring
(async () => {
  try {
    log('Starting Victron Flux Controller...');
    
    // Initialize database
    await initializeDatabase();
    
    // Load tariff configuration from database
    const configLoaded = await loadTariffConfig();
    if (!configLoaded) {
      log('Failed to load tariff configuration, exiting', 'ERROR');
      process.exit(1);
    }
    
    // Debug: Show loaded TARIFF object
    console.log('Loaded TARIFF object:', JSON.stringify(TARIFF, null, 2));
    
    // Connect to MQTT broker
    mqttClient = mqtt.connect(MQTT_BROKER);

    mqttClient.on('connect', () => {
      log('Connected to MQTT broker for Flux tariff control');
      
      // Subscribe to monitoring topics
      const topics = Object.values(MQTT_TOPICS).filter(topic => topic.startsWith('N/'));
      
      mqttClient.subscribe(topics, (err) => {
        if (err) {
          log(`Error subscribing to topics: ${err.message}`, "ERROR");
        } else {
          log(`Subscribed to ${topics.length} monitoring topics`);
        }
      });
    });

    mqttClient.on('message', async (topic, message) => {
      try {
        const data = JSON.parse(message.toString());
        const value = data.value;
        
        switch (topic) {
          case MQTT_TOPICS.BATTERY_SOC:
            currentSOC = value;
            break;
          case MQTT_TOPICS.BATTERY_VOLTAGE:
            currentVoltage = value;
            break;
          case MQTT_TOPICS.BATTERY_CURRENT:
            currentCurrent = value;
            break;
          case MQTT_TOPICS.BATTERY_POWER:
            currentPower = value;
            break;
          case MQTT_TOPICS.GRID_POWER:
            gridPower = value;
            break;
          case MQTT_TOPICS.SOLAR_POWER:
            solarPower = value;
            break;
          case MQTT_TOPICS.LOAD_POWER:
            loadPower = value;
            break;
          case MQTT_TOPICS.ESS_MODE_READ:
            currentMode = value;
            break;
          case MQTT_TOPICS.INVERTER_MODE_READ:
            if (currentInverterMode !== value) {
              const modeNames = {
                1: 'Charger Only',
                2: 'Inverter Only', 
                3: 'ON (Normal operation)',
                4: 'OFF'
              };
              log(`Inverter mode changed from ${currentInverterMode} (${modeNames[currentInverterMode] || 'Unknown'}) to ${value} (${modeNames[value] || 'Unknown'}) - Device feedback`);
            }
            currentInverterMode = value;
            break;
          
        }
      } catch (err) {
        log(`Error processing message on ${topic}: ${err.message}`, "ERROR");
      }
    });

    mqttClient.on('error', (err) => {
      log(`MQTT error: ${err.message}`, "ERROR");
    });

    // Database already connected in initializeDatabase
    log('Database connection verified');

    setupScheduler();

    
    // Start tariff monitoring (every minute)
    setInterval(applyTariffStrategy, 60 * 1000);
    
    log('Flux controller started successfully');
    
  } catch (error) {
    log(`Failed to start Flux controller: ${error.message}`, "ERROR");
    process.exit(1);
  }
})();

// Signal handlers
process.on('SIGINT', async () => await gracefulShutdown('SIGINT'));
process.on('SIGTERM', async () => await gracefulShutdown('SIGTERM'));
