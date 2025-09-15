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
             target_soc_percent, ess_mode, inverter_mode, description
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
          targetSOC: setpoint.target_soc_percent ? parseFloat(setpoint.target_soc_percent) : null,
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
  
};

// System state variables
let currentSOC = 0;
let currentMode = 0;  // ESS mode
let currentInverterMode = 0;  // Inverter mode
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
    console.log(entry.trim());
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
        vgs.target_soc_percent,
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
    } else {
      log('ESS mode command sent successfully');
    }
  });
  return true;
}

// Set Inverter Mode (vebus/276/Mode) - Controls inverter operation
function setInverterMode(mode) {
  if (!mqttClient || !mqttClient.connected) {
    log('MQTT client not connected, cannot set inverter mode', "ERROR");
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


// Main tariff-based control logic
async function applyTariffStrategy() {
  const newPeriod = await getCurrentTariffPeriod();
  const tariffConfig = TARIFF[newPeriod];
  console.log(`Applying tariff strategy for ${newPeriod}: ${JSON.stringify(tariffConfig)}`);
  console.log(`Available TARIFF periods: ${JSON.stringify(Object.keys(TARIFF))}`);
  // Check if tariff period changed
  if (newPeriod !== currentTariffPeriod) {
    log(`Tariff period changed: ${currentTariffPeriod} -> ${newPeriod}`);
    await logTariffEvent('period_change', `Tariff period changed to ${newPeriod}`, currentTariffPeriod, newPeriod);
    currentTariffPeriod = newPeriod;
  }
  
  log(`Current period: ${newPeriod} - ${tariffConfig.description}`);
  log(`SOC: ${currentSOC}%, Target: ${tariffConfig.targetSOC || 'N/A'}%, Min: ${tariffConfig.minSOC}%`);
  log(`Grid: ${gridPower}W, Solar: ${solarPower}W, Battery: ${currentPower}W, Load: ${loadPower}W`);
  log(`Current ESS Mode: ${currentMode}, Current Inverter Mode: ${currentInverterMode}`);
  
  let needsModeChange = false;
  let needsSetpointChange = false;
  
  // Apply tariff-specific strategy
  switch (newPeriod) {
    case 'Night':
      // Night: Use database-configured modes
      setInverterMode(tariffConfig.inverterMode);
      if (currentSOC < tariffConfig.targetSOC) {
        if (currentMode !== tariffConfig.essMode) {
          setESSMode(tariffConfig.essMode);
          needsModeChange = true;
        }
        if (currentGridSetpoint !== tariffConfig.gridSetpoint) {
          setGridSetpoint(tariffConfig.gridSetpoint);
          needsSetpointChange = true;
        }
        log(`Night charging: SOC ${currentSOC}% < target ${tariffConfig.targetSOC}%`);
      } else {
        // Target reached, use database-configured ESS mode
        if (currentMode !== tariffConfig.essMode) {
          setESSMode(tariffConfig.essMode);
          needsModeChange = true;
        }
        log(`Night target reached: SOC ${currentSOC}% >= ${tariffConfig.targetSOC}%`);
      }
      break;
      
    case 'Day':
    case 'Evening':
      // Day/Evening: Use database-configured inverter mode
      setInverterMode(tariffConfig.inverterMode);
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
      // Peak: Use database-configured inverter mode
      setInverterMode(tariffConfig.inverterMode);
      if (currentMode !== tariffConfig.essMode) {
        setESSMode(tariffConfig.essMode);
        needsModeChange = true;
      }
      if (currentGridSetpoint !== tariffConfig.gridSetpoint) {
        setGridSetpoint(tariffConfig.gridSetpoint);
        needsSetpointChange = true;
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
