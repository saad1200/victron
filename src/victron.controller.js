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
             target_soc_percent, ess_mode, description
      FROM victron_grid_setpoints 
      WHERE device_id = $1 AND is_active = true
    `;
    const setpointsResult = await dbClient.query(setpointsQuery, [DEVICE_ID]);
    
    // Build TARIFF object
    const newTariff = {};
    
    for (const period of periodsResult.rows) {
      const setpoint = setpointsResult.rows.find(s => s.tariff_period === period.period_name);
      
      if (setpoint) {
        newTariff[period.period_name] = {
          import: parseFloat(period.import_rate_pence),
          export: parseFloat(period.export_rate_pence),
          start: period.start_time.slice(0, 5), // HH:MM format
          end: period.end_time.slice(0, 5),
          gridSetpoint: parseInt(setpoint.grid_setpoint_watts),
          targetSOC: setpoint.target_soc_percent ? parseFloat(setpoint.target_soc_percent) : null,
          minSOC: parseFloat(setpoint.min_soc_percent || 10),
          maxSOC: parseFloat(setpoint.max_soc_percent || 100),
          essMode: parseInt(setpoint.ess_mode || 3),
          description: setpoint.description || `${period.period_name} period`
        };
      }
    }
    
    TARIFF = newTariff;
    log(`Loaded ${Object.keys(TARIFF).length} tariff periods from database`);
    
    // Log current configuration
    for (const [name, config] of Object.entries(TARIFF)) {
      log(`${name}: ${config.start}-${config.end}, setpoint: ${config.gridSetpoint}W, mode: ${config.essMode}`);
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

// Victron ESS Mode values
const ESS_MODES = {
  CHARGER_ONLY: 1,
  INVERTER_ONLY: 2,
  ON: 3,
  OFF: 4
};

// MQTT Topics for control and monitoring
const MQTT_TOPICS = {
  // Control topics (write)
  ESS_MODE_WRITE: `W/${DEVICE_ID}/vebus/276/Mode`,
  GRID_SETPOINT_WRITE: `W/${DEVICE_ID}/settings/0/Settings/CGwacs/AcPowerSetPoint`,
  HUB4_MODE_WRITE: `W/${DEVICE_ID}/settings/0/Settings/CGwacs/Hub4Mode`,
  
  // Monitor topics (read)
  BATTERY_SOC: `N/${DEVICE_ID}/vebus/276/Soc`,
  BATTERY_VOLTAGE: `N/${DEVICE_ID}/system/0/Dc/Battery/Voltage`,
  BATTERY_CURRENT: `N/${DEVICE_ID}/system/0/Dc/Battery/Current`,
  BATTERY_POWER: `N/${DEVICE_ID}/system/0/Dc/Battery/Power`,
  GRID_POWER: `N/${DEVICE_ID}/system/0/Ac/Grid/L1/Power`,
  GRID_IMPORT: `N/${DEVICE_ID}/system/0/Ac/Consumption/L1/Power`,
  SOLAR_POWER: `N/${DEVICE_ID}/system/0/Dc/Pv/Power`,
  LOAD_POWER: `N/${DEVICE_ID}/system/0/Ac/Consumption/L1/Power`,
  ESS_MODE_READ: `N/${DEVICE_ID}/vebus/276/Mode`,
  SYSTEM_STATE: `N/${DEVICE_ID}/vebus/276/State`
};

// System state variables
let currentSOC = 0;
let currentMode = 0;
let currentVoltage = 0;
let currentCurrent = 0;
let currentPower = 0;
let gridPower = 0;
let solarPower = 0;
let loadPower = 0;
let currentTariffPeriod = null;
let currentGridSetpoint = 0;
let mqttClient = null;
let energyTrackingInterval = null;
let setpointAdjustTimer = null;
let lastEnergyReading = {
  timestamp: Date.now(),
  gridImport: 0,
  gridExport: 0,
  solarGeneration: 0,
  batteryCharge: 0,
  batteryDischarge: 0,
  loadConsumption: 0
};

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
      
      // Update TARIFF object with current period data
      TARIFF[row.period_name] = {
        import: parseFloat(row.import_rate_pence),
        export: parseFloat(row.export_rate_pence),
        start: row.start_time.slice(0, 5),
        end: row.end_time.slice(0, 5),
        gridSetpoint: parseInt(row.grid_setpoint_watts),
        targetSOC: row.target_soc_percent ? parseFloat(row.target_soc_percent) : null,
        minSOC: parseFloat(row.min_soc_percent || 10),
        maxSOC: parseFloat(row.max_soc_percent || 100),
        essMode: parseInt(row.ess_mode || 3),
        description: row.description || `${row.period_name} period`
      };
      
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

// Set ESS mode
function setESSMode(mode) {
  if (!mqttClient || !mqttClient.connected) {
    log('MQTT client not connected, cannot set ESS mode', "ERROR");
    return false;
  }

  const modeNames = {
    1: 'CHARGER_ONLY',
    2: 'INVERTER_ONLY', 
    3: 'ON',
    4: 'OFF'
  };

  log(`Setting ESS mode to ${mode} (${modeNames[mode] || 'UNKNOWN'})`);
  
  const payload = JSON.stringify({ value: mode });
  mqttClient.publish(MQTT_TOPICS.ESS_MODE_WRITE, payload, (err) => {
    if (err) {
      log(`Failed to set ESS mode: ${err.message}`, "ERROR");
    } else {
      log(`ESS mode command sent successfully`);
    }
  });
  
  return true;
}

// Set Hub4Mode (1 = External control via setpoint)
function setHub4Mode(mode = 1) {
  if (!mqttClient || !mqttClient.connected) {
    log('MQTT client not connected, cannot set Hub4Mode', "ERROR");
    return false;
  }
  log(`Setting Hub4Mode to ${mode}`);
  const payload = JSON.stringify({ value: mode });
  mqttClient.publish(MQTT_TOPICS.HUB4_MODE_WRITE, payload, (err) => {
    if (err) log(`Failed to set Hub4Mode: ${err.message}`, "ERROR");
    else log('Hub4Mode command sent successfully');
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

async function trackEnergyUsage() {
  try {
    const now = Date.now();
    const timeDiffHours = (now - lastEnergyReading.timestamp) / (1000 * 60 * 60);
    
    if (timeDiffHours < 0.01) return; // Skip if less than 36 seconds
    
    const tariffConfig = TARIFF[currentTariffPeriod];
    
    // Calculate energy deltas (kWh)
    const gridImportKwh = Math.max(0, gridPower) * timeDiffHours / 1000;
    const gridExportKwh = Math.max(0, -gridPower) * timeDiffHours / 1000;
    const solarKwh = Math.max(0, solarPower) * timeDiffHours / 1000;
    const batteryChargeKwh = Math.max(0, currentPower) * timeDiffHours / 1000;
    const batteryDischargeKwh = Math.max(0, -currentPower) * timeDiffHours / 1000;
    const loadKwh = Math.max(0, loadPower) * timeDiffHours / 1000;
    
    // Calculate costs and earnings (pence)
    const importCost = gridImportKwh * tariffConfig.import;
    const exportEarnings = gridExportKwh * tariffConfig.export;
    const netCost = importCost - exportEarnings;
    
    const query = `
      INSERT INTO victron_energy_tracking (
        device_id, tariff_period, import_rate_pence, export_rate_pence,
        grid_import_kwh, grid_export_kwh, solar_generation_kwh,
        battery_charge_kwh, battery_discharge_kwh, load_consumption_kwh,
        import_cost_pence, export_earnings_pence, net_cost_pence,
        battery_soc_start, battery_soc_end, grid_setpoint_watts, ess_mode
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    `;
    
    await dbClient.query(query, [
      DEVICE_ID, currentTariffPeriod, tariffConfig.import, tariffConfig.export,
      gridImportKwh, gridExportKwh, solarKwh,
      batteryChargeKwh, batteryDischargeKwh, loadKwh,
      importCost, exportEarnings, netCost,
      lastEnergyReading.soc || currentSOC, currentSOC,
      currentGridSetpoint, currentMode
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
    
  } catch (err) {
    log(`Failed to track energy usage: ${err.message}`, "ERROR");
  }
}

// Main tariff-based control logic
async function applyTariffStrategy() {
  const newPeriod = await getCurrentTariffPeriod();
  const tariffConfig = TARIFF[newPeriod];
  console.log(`Applying tariff strategy for ${newPeriod}: ${JSON.stringify(tariffConfig)}`);
  // Check if tariff period changed
  if (newPeriod !== currentTariffPeriod) {
    log(`Tariff period changed: ${currentTariffPeriod} -> ${newPeriod}`);
    await logTariffEvent('period_change', `Tariff period changed to ${newPeriod}`, currentTariffPeriod, newPeriod);
    currentTariffPeriod = newPeriod;
  }
  
  log(`Current period: ${newPeriod} - ${tariffConfig.description}`);
  log(`SOC: ${currentSOC}%, Target: ${tariffConfig.targetSOC || 'N/A'}%, Min: ${tariffConfig.minSOC}%`);
  log(`Grid: ${gridPower}W, Solar: ${solarPower}W, Battery: ${currentPower}W, Load: ${loadPower}W`);
  
  let needsModeChange = false;
  let needsSetpointChange = false;
  
  // Apply tariff-specific strategy
  switch (newPeriod) {
    case 'Night':
      // Night: Charge to 70% SOC with 3kW import limit
      setHub4Mode(1);
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
        // Target reached, switch to normal mode but maintain setpoint
        if (currentMode !== ESS_MODES.ON) {
          setESSMode(ESS_MODES.ON);
          needsModeChange = true;
        }
        log(`Night target reached: SOC ${currentSOC}% >= ${tariffConfig.targetSOC}%`);
      }
      break;
      
    case 'Day':
    case 'Evening':
      // Day/Evening: Use ESS mode and exact setpoint from database
      setHub4Mode(1); // External control
      
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
      
    case 'PEAK':
      // Peak: Maximum export, discharge battery at full rate
      setHub4Mode(1);
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
  
  if (energyTrackingInterval) {
    clearInterval(energyTrackingInterval);
  }
  
  // Return to safe mode
  if (mqttClient && mqttClient.connected) {
    setESSMode(ESS_MODES.ON);
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

    // Start energy tracking
    energyTrackingInterval = setInterval(trackEnergyUsage, 60000); // Every minute

    // Initial tariff strategy application
    setTimeout(async () => {
      currentTariffPeriod = await getCurrentTariffPeriod();
      await applyTariffStrategy();
    }, 5000);

    log('Octopus Flux controller initialized successfully');
  } catch (err) {
    log(`Error starting Flux controller: ${err.message}`, "ERROR");
    process.exit(1);
  }
})();

// Signal handlers
process.on('SIGINT', async () => await gracefulShutdown('SIGINT'));
process.on('SIGTERM', async () => await gracefulShutdown('SIGTERM'));
