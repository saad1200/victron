const mqtt = require('mqtt');
const cron = require('node-cron');
const { Client } = require('pg');
const fs = require('fs').promises;
const path = require('path');
const https = require('https');
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
const LOG_FILE = path.join(__dirname, "../logs/victron-agile-controller.log");

// Controller state
let isRunning = false;
let schedulerInterval = null;
let rateUpdateInterval = null;
let mqttClient = null;

// Octopus Agile API configuration
const OCTOPUS_API_BASE = 'https://api.octopus.energy/v1';
const OCTOPUS_API_KEY = process.env.OCTOPUS_API_KEY; // Your sk_live_... key
const AGILE_PRODUCT_CODE = process.env.AGILE_PRODUCT_CODE || 'AGILE-24-10-01';
const AGILE_TARIFF_CODE = process.env.AGILE_TARIFF_CODE || 'E-1R-AGILE-24-10-01-J';
const MPAN = process.env.MPAN; // Your electricity meter MPAN

// Current rates cache
let currentRates = [];
let currentImportRate = 0; // pence per kWh
let currentExportRate = 0; // pence per kWh
let nextRateUpdate = null;

// System state variables
let currentSOC = 0;
let currentMode = 0;
let currentInverterMode = 0;
let currentVoltage = 0;
let currentCurrent = 0;
let currentPower = 0;
let gridPower = 0;
let solarPower = 0;
let loadPower = 0;
let currentGridSetpoint = 0;

// Agile configuration loaded from database
let agileConfig = {
  maxChargeRate: 3000, // watts
  maxDischargeRate: 5000, // watts
  minSOC: 10, // %
  maxSOC: 100, // %
  targetSOC: 80, // %
  cheapRateThreshold: 10, // pence - charge when below this
  expensiveRateThreshold: 25, // pence - discharge when above this
  negativeRateThreshold: 0, // pence - aggressive charging when negative
  selfConsumptionPriority: true
};

// MQTT Topics (same as flux controller)
const MQTT_TOPICS = {
  // Control topics (write)
  ESS_MODE_WRITE: `W/${DEVICE_ID}/settings/0/Settings/CGwacs/BatteryLife/State`,
  INVERTER_MODE_WRITE: `W/${DEVICE_ID}/vebus/276/Mode`,
  GRID_SETPOINT_WRITE: `W/${DEVICE_ID}/settings/0/Settings/CGwacs/AcPowerSetPoint`,
  MIN_SOC_WRITE: `W/${DEVICE_ID}/settings/0/Settings/CGwacs/BatteryLife/MinimumSocLimit`,
  
  // Monitor topics (read)
  BATTERY_SOC: `N/${DEVICE_ID}/vebus/276/Soc`,
  BATTERY_VOLTAGE: `N/${DEVICE_ID}/system/0/Dc/Battery/Voltage`,
  BATTERY_CURRENT: `N/${DEVICE_ID}/system/0/Dc/Battery/Current`,
  BATTERY_POWER: `N/${DEVICE_ID}/system/0/Dc/Battery/Power`,
  GRID_POWER: `N/${DEVICE_ID}/system/0/Ac/Grid/L1/Power`,
  SOLAR_POWER: `N/${DEVICE_ID}/system/0/Dc/Pv/Power`,
  LOAD_POWER: `N/${DEVICE_ID}/system/0/Ac/Consumption/L1/Power`,
  ESS_MODE_READ: `N/${DEVICE_ID}/settings/0/Settings/CGwacs/BatteryLife/State`,
  INVERTER_MODE_READ: `N/${DEVICE_ID}/vebus/276/Mode`,
};

// ESS and Inverter modes (same as flux controller)
const ESS_MODES = {
  OPTIMIZE_WITH_BATTERYLIFE: 1,
  KEEP_BATTERIES_CHARGED: 9,
  OPTIMIZE_WITHOUT_BATTERYLIFE: 10
};

const INVERTER_MODES = {
  CHARGER_ONLY: 1,
  INVERTER_ONLY: 2,
  ON: 3,
  OFF: 4
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
  const entry = `[${timestamp}] [AGILE-CONTROLLER] [${level}] ${message}\n`;
  try {
    await fs.appendFile(LOG_FILE, entry);
    console.log(entry.trim());
  } catch (err) {
    console.error(`Failed to write log: ${err.message}`);
  }
}

// Initialize database connection
async function initializeDatabase() {
  try {
    await dbClient.connect();
    await dbClient.query('SELECT NOW()');
    log('Database connection successful');
    return true;
  } catch (error) {
    log(`Database connection failed: ${error.message}`, "ERROR");
    return false;
  }
}

// Load Agile configuration from database
async function loadAgileConfig() {
  try {
    // Get Octopus Agile product ID
    const productQuery = `SELECT id FROM products WHERE name = 'Octopus Agile' AND active = true`;
    const productResult = await dbClient.query(productQuery);
    
    if (productResult.rows.length === 0) {
      log('Octopus Agile product not found or not active', 'ERROR');
      return false;
    }
    
    const agileProductId = productResult.rows[0].id;
    log(`Loading agile config for Octopus Agile (product_id: ${agileProductId})`);
    
    // Get agile-specific grid setpoints configuration
    const configQuery = `
      SELECT 
        grid_setpoint_watts as max_charge_rate,
        min_soc_percent,
        max_soc_percent,
        active_soc_percent as target_soc,
        ess_mode,
        inverter_mode,
        description
      FROM victron_grid_setpoints 
      WHERE device_id = $1 AND is_active = true AND product_id = $2
      AND tariff_period = 'agile_config'
    `;
    const configResult = await dbClient.query(configQuery, [DEVICE_ID, agileProductId]);
    
    if (configResult.rows.length > 0) {
      const config = configResult.rows[0];
      agileConfig = {
        ...agileConfig,
        maxChargeRate: Math.abs(config.max_charge_rate) || agileConfig.maxChargeRate,
        maxDischargeRate: Math.abs(config.max_charge_rate) || agileConfig.maxDischargeRate,
        minSOC: config.min_soc_percent || agileConfig.minSOC,
        maxSOC: config.max_soc_percent || agileConfig.maxSOC,
        targetSOC: config.target_soc || agileConfig.targetSOC
      };
      log(`Loaded agile config: charge=${agileConfig.maxChargeRate}W, discharge=${agileConfig.maxDischargeRate}W, SOC=${agileConfig.minSOC}-${agileConfig.maxSOC}%`);
    } else {
      log('No agile configuration found in database, using defaults', 'WARN');
    }
    
    return true;
  } catch (error) {
    log(`Failed to load agile config: ${error.message}`, "ERROR");
    return false;
  }
}

// Fetch current Octopus Agile rates
async function fetchAgileRates() {
  return new Promise((resolve, reject) => {
    if (!OCTOPUS_API_KEY) {
      reject(new Error('OCTOPUS_API_KEY not configured'));
      return;
    }
    
    const now = new Date();
    const from = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2 hours ago
    const to = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 hours ahead
    
    const fromISO = from.toISOString();
    const toISO = to.toISOString();
    
    // Construct API URL using the proper format from your example
    const importUrl = `${OCTOPUS_API_BASE}/products/${AGILE_PRODUCT_CODE}/electricity-tariffs/${AGILE_TARIFF_CODE}/standard-unit-rates/?period_from=${fromISO}&period_to=${toISO}`;
    
    log(`Fetching Agile rates from: ${importUrl}`);
    
    // Create authentication header (API key as username, empty password)
    const auth = Buffer.from(`${OCTOPUS_API_KEY}:`).toString('base64');
    
    const options = {
      headers: {
        'Authorization': `Basic ${auth}`,
        'User-Agent': 'Victron-Agile-Controller/1.0'
      }
    };
    
    https.get(importUrl, options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          
          if (response.results && response.results.length > 0) {
            currentRates = response.results.map(rate => ({
              validFrom: new Date(rate.valid_from),
              validTo: new Date(rate.valid_to),
              importRate: rate.value_inc_vat, // pence per kWh
              exportRate: rate.value_inc_vat * 0.5 // Will be updated with actual export rates if available
            }));
            
            // Sort by valid_from time
            currentRates.sort((a, b) => a.validFrom - b.validFrom);
            
            // Find current rate
            const currentRate = currentRates.find(rate => 
              now >= rate.validFrom && now < rate.validTo
            );
            
            if (currentRate) {
              currentImportRate = currentRate.importRate;
              currentExportRate = currentRate.exportRate;
              nextRateUpdate = currentRate.validTo;
              
              log(`Current rates: Import ${currentImportRate.toFixed(2)}p/kWh, Export ${currentExportRate.toFixed(2)}p/kWh`);
              log(`Next rate update: ${nextRateUpdate.toLocaleString('en-GB', { timeZone: 'Europe/London' })}`);
            } else {
              log('No current rate found in fetched data', 'WARN');
            }
            
            // Try to fetch export rates if export tariff is configured
            fetchExportRates().then(() => {
              resolve(currentRates);
            }).catch(() => {
              // Export rates failed, but continue with import rates
              log('Export rates not available, using estimated rates', 'WARN');
              resolve(currentRates);
            });
          } else {
            reject(new Error('No rates data received from Octopus API'));
          }
        } catch (error) {
          reject(new Error(`Failed to parse Octopus API response: ${error.message}`));
        }
      });
    }).on('error', (error) => {
      reject(new Error(`Failed to fetch Octopus rates: ${error.message}`));
    });
  });
}

// Fetch export rates if export tariff is configured
async function fetchExportRates() {
  return new Promise((resolve, reject) => {
    const EXPORT_TARIFF_CODE = process.env.EXPORT_TARIFF_CODE;
    
    if (!EXPORT_TARIFF_CODE) {
      reject(new Error('No export tariff configured'));
      return;
    }
    
    const now = new Date();
    const from = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const to = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    
    const fromISO = from.toISOString();
    const toISO = to.toISOString();
    
    // Construct export rates URL
    const exportUrl = `${OCTOPUS_API_BASE}/products/${AGILE_PRODUCT_CODE}/electricity-tariffs/${EXPORT_TARIFF_CODE}/standard-unit-rates/?period_from=${fromISO}&period_to=${toISO}`;
    
    const auth = Buffer.from(`${OCTOPUS_API_KEY}:`).toString('base64');
    const options = {
      headers: {
        'Authorization': `Basic ${auth}`,
        'User-Agent': 'Victron-Agile-Controller/1.0'
      }
    };
    
    https.get(exportUrl, options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          
          if (response.results && response.results.length > 0) {
            // Update export rates in currentRates array
            response.results.forEach(exportRate => {
              const matchingRate = currentRates.find(rate => 
                rate.validFrom.getTime() === new Date(exportRate.valid_from).getTime()
              );
              if (matchingRate) {
                matchingRate.exportRate = exportRate.value_inc_vat;
              }
            });
            
            log('Export rates updated successfully');
            resolve();
          } else {
            reject(new Error('No export rates data received'));
          }
        } catch (error) {
          reject(new Error(`Failed to parse export rates: ${error.message}`));
        }
      });
    }).on('error', (error) => {
      reject(new Error(`Failed to fetch export rates: ${error.message}`));
    });
  });
}

// Get rate forecast for next few hours
function getRateForecast(hoursAhead = 6) {
  const now = new Date();
  const futureTime = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);
  
  return currentRates.filter(rate => 
    rate.validFrom >= now && rate.validFrom <= futureTime
  ).sort((a, b) => a.validFrom - b.validFrom);
}

// Find cheapest and most expensive rates in forecast
function analyzeForecast(hoursAhead = 6) {
  const forecast = getRateForecast(hoursAhead);
  
  if (forecast.length === 0) {
    return { cheapest: null, mostExpensive: null, average: currentImportRate };
  }
  
  const rates = forecast.map(r => r.importRate);
  const cheapest = Math.min(...rates);
  const mostExpensive = Math.max(...rates);
  const average = rates.reduce((sum, rate) => sum + rate, 0) / rates.length;
  
  return { cheapest, mostExpensive, average, forecast };
}

// Set ESS mode
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
  });
  return true;
}

// Set Inverter Mode
function setInverterMode(mode) {
  if (!mqttClient || !mqttClient.connected || mode == 0) {
    log(`MQTT client not connected, cannot set inverter mode. mode: ${mode}`, "ERROR");
    return false;
  }
  
  if (currentInverterMode === mode) {
    return true;
  }
  
  const modeNames = {
    1: 'Charger Only',
    2: 'Inverter Only', 
    3: 'ON (Normal operation)',
    4: 'OFF'
  };
  
  log(`Setting inverter mode from ${currentInverterMode} to ${mode} (${modeNames[mode] || 'Unknown mode'})`);
  
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

  log(`Setting grid setpoint to ${watts}W (Rate: ${currentImportRate.toFixed(2)}p/kWh)`);
  
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

// Set minimum SOC
function setMinSOC(socPercent) {
  if (!mqttClient || !mqttClient.connected) {
    log('MQTT client not connected, cannot set minimum SOC', "ERROR");
    return false;
  }

  log(`Setting minimum SOC to ${socPercent}%`);
  
  const payload = JSON.stringify({ value: socPercent });
  mqttClient.publish(MQTT_TOPICS.MIN_SOC_WRITE, payload, (err) => {
    if (err) {
      log(`Failed to set minimum SOC: ${err.message}`, "ERROR");
    } else {
      log(`Minimum SOC command sent successfully`);
    }
  });
  
  return true;
}

// Main Agile optimization logic
async function applyAgileStrategy() {
  if (!isRunning) return;
  
  try {
    // Analyze rate forecast
    const analysis = analyzeForecast(6);
    
    log(`Current: SOC ${currentSOC}%, Rate ${currentImportRate.toFixed(2)}p/kWh, Grid ${gridPower}W, Solar ${solarPower}W, Battery ${currentPower}W`);
    
    if (analysis.forecast.length > 0) {
      log(`6h forecast: Cheapest ${analysis.cheapest.toFixed(2)}p, Most expensive ${analysis.mostExpensive.toFixed(2)}p, Average ${analysis.average.toFixed(2)}p`);
    }
    
    let targetSetpoint = 0;
    let targetESSMode = ESS_MODES.OPTIMIZE_WITH_BATTERYLIFE;
    let targetInverterMode = INVERTER_MODES.ON;
    let strategy = "unknown";
    
    // Decision logic based on current rate and SOC
    if (currentImportRate <= agileConfig.negativeRateThreshold) {
      // Negative rates - aggressive charging
      strategy = "negative_rate_charging";
      targetSetpoint = agileConfig.maxChargeRate;
      targetESSMode = ESS_MODES.KEEP_BATTERIES_CHARGED;
      targetInverterMode = INVERTER_MODES.CHARGER_ONLY;
      
    } else if (currentImportRate <= agileConfig.cheapRateThreshold) {
      // Very cheap rates - charge if SOC below target
      if (currentSOC < agileConfig.targetSOC) {
        strategy = "cheap_rate_charging";
        targetSetpoint = agileConfig.maxChargeRate;
        targetESSMode = ESS_MODES.KEEP_BATTERIES_CHARGED;
        targetInverterMode = INVERTER_MODES.ON;
      } else {
        strategy = "cheap_rate_maintain";
        targetSetpoint = 0; // Self-consumption priority
        targetESSMode = ESS_MODES.OPTIMIZE_WITH_BATTERYLIFE;
        targetInverterMode = INVERTER_MODES.ON;
      }
      
    } else if (currentImportRate >= agileConfig.expensiveRateThreshold) {
      // Expensive rates - discharge if SOC above minimum
      if (currentSOC > agileConfig.minSOC + 10) { // 10% buffer above minimum
        strategy = "expensive_rate_discharge";
        targetSetpoint = -agileConfig.maxDischargeRate;
        targetESSMode = ESS_MODES.OPTIMIZE_WITHOUT_BATTERYLIFE;
        targetInverterMode = INVERTER_MODES.ON;
      } else {
        strategy = "expensive_rate_preserve";
        targetSetpoint = 0;
        targetESSMode = ESS_MODES.OPTIMIZE_WITH_BATTERYLIFE;
        targetInverterMode = INVERTER_MODES.ON;
      }
      
    } else {
      // Moderate rates - optimize for self-consumption
      strategy = "self_consumption";
      
      // If solar is generating and battery not full, allow charging
      if (solarPower > 100 && currentSOC < agileConfig.maxSOC) {
        targetSetpoint = 0; // Let solar charge naturally
        targetESSMode = ESS_MODES.OPTIMIZE_WITH_BATTERYLIFE;
      } 
      // If no solar and high load, use battery if economical
      else if (solarPower < 100 && loadPower > 500) {
        // Check if using battery is better than importing
        if (currentSOC > agileConfig.minSOC + 20 && analysis.cheapest < currentImportRate * 0.8) {
          // Cheaper rates coming soon, preserve battery
          targetSetpoint = Math.min(loadPower, 1000); // Import for immediate needs
          targetESSMode = ESS_MODES.OPTIMIZE_WITH_BATTERYLIFE;
        } else {
          // Use battery for current load
          targetSetpoint = 0;
          targetESSMode = ESS_MODES.OPTIMIZE_WITH_BATTERYLIFE;
        }
      } else {
        targetSetpoint = 0;
        targetESSMode = ESS_MODES.OPTIMIZE_WITH_BATTERYLIFE;
      }
      
      targetInverterMode = INVERTER_MODES.ON;
    }
    
    log(`Strategy: ${strategy}, Target setpoint: ${targetSetpoint}W, ESS mode: ${targetESSMode}, Inverter mode: ${targetInverterMode}`);
    
    // Apply settings
    setESSMode(targetESSMode);
    setInverterMode(targetInverterMode);
    setGridSetpoint(targetSetpoint);
    setMinSOC(agileConfig.minSOC);
    
    // Log decision to database
    await logAgileEvent(strategy, `Rate: ${currentImportRate.toFixed(2)}p/kWh, SOC: ${currentSOC}%, Setpoint: ${targetSetpoint}W`);
    
  } catch (error) {
    log(`Error in agile strategy: ${error.message}`, "ERROR");
  }
}

// Log agile events to database
async function logAgileEvent(eventType, description) {
  try {
    const query = `
      INSERT INTO victron_tariff_events (
        device_id, event_type, from_setpoint, to_setpoint,
        from_ess_mode, to_ess_mode, battery_soc, reason
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `;
    
    await dbClient.query(query, [
      DEVICE_ID, eventType, currentGridSetpoint, currentGridSetpoint,
      currentMode, currentMode, currentSOC, description
    ]);
  } catch (err) {
    log(`Failed to log agile event: ${err.message}`, "ERROR");
  }
}

// Connect to MQTT broker
function connectMQTT() {
  log(`Connecting to MQTT broker: ${MQTT_BROKER}`);
  mqttClient = mqtt.connect(MQTT_BROKER);

  mqttClient.on('connect', () => {
    log('Connected to MQTT broker for Agile control');
    
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

// Setup scheduler for rate updates and strategy execution
function setupScheduler() {
  // Update rates every hour
  rateUpdateInterval = setInterval(async () => {
    if (isRunning) {
      try {
        await fetchAgileRates();
      } catch (error) {
        log(`Failed to update rates: ${error.message}`, "ERROR");
      }
    }
  }, 60 * 60 * 1000); // 1 hour
  
  // Apply strategy every 5 minutes
  schedulerInterval = setInterval(async () => {
    if (isRunning) {
      await applyAgileStrategy();
    }
  }, 5 * 60 * 1000); // 5 minutes
  
  log('Agile scheduler initialized - rates update hourly, strategy every 5 minutes');
}

// Start function for the Agile controller
async function start() {
  if (isRunning) {
    log('Agile controller is already running', 'WARN');
    return;
  }
  
  try {
    log('Starting Victron Agile Controller...');
    isRunning = true;
    
    // Initialize database
    await initializeDatabase();
    
    // Load agile configuration
    const configLoaded = await loadAgileConfig();
    if (!configLoaded) {
      log('Failed to load agile configuration', 'ERROR');
      isRunning = false;
      throw new Error('Failed to load agile configuration');
    }
    
    // Fetch initial rates
    await fetchAgileRates();
    
    // Connect to MQTT broker
    connectMQTT();
    
    // Setup scheduler
    setupScheduler();
    
    log('Agile controller started successfully');
    
  } catch (error) {
    log(`Failed to start Agile controller: ${error.message}`, "ERROR");
    isRunning = false;
    throw error;
  }
}

// Stop function for the Agile controller
async function stop() {
  if (!isRunning) {
    log('Agile controller is not running', 'WARN');
    return;
  }
  
  log('Stopping Victron Agile Controller...');
  isRunning = false;
  
  // Clear intervals
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
  
  if (rateUpdateInterval) {
    clearInterval(rateUpdateInterval);
    rateUpdateInterval = null;
  }
  
  // Return to safe mode
  if (mqttClient && mqttClient.connected) {
    setESSMode(ESS_MODES.OPTIMIZE_WITH_BATTERYLIFE);
    setInverterMode(INVERTER_MODES.ON);
    setGridSetpoint(0);
    
    // Close MQTT connection
    mqttClient.end();
    mqttClient = null;
  }
  
  log('Agile controller stopped successfully');
}

// Export functions for use by main controller
module.exports = {
  start,
  stop
};

// Only set up signal handlers if this file is run directly
if (require.main === module) {
  // Auto-start if run directly
  start().catch(error => {
    console.error('Failed to start Agile controller:', error.message);
    process.exit(1);
  });
}
