const { Client } = require('pg');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

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

// Product-specific controllers
let activeController = null;
let currentActiveProduct = null;

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
  const entry = `[${timestamp}] [MAIN-CONTROLLER] [${level}] ${message}\n`;
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

// Get the currently active product
async function getActiveProduct() {
  try {
    const query = 'SELECT id, name FROM products WHERE active = true LIMIT 1';
    const result = await dbClient.query(query);
    
    if (result.rows.length > 0) {
      return result.rows[0];
    }
    
    log('No active product found', "WARN");
    return null;
  } catch (error) {
    log(`Failed to get active product: ${error.message}`, "ERROR");
    return null;
  }
}

// Load and start the appropriate controller based on active product
async function loadProductController(product) {
  try {
    // Stop current controller if running
    if (activeController && typeof activeController.stop === 'function') {
      log(`Stopping current controller for product: ${currentActiveProduct?.name}`);
      await activeController.stop();
      activeController = null;
    }

    // Load the appropriate controller based on product name
    let controllerPath;
    switch (product.name) {
      case 'Octopus Flux':
        controllerPath = './victron.flux.controller';
        break;
      case 'Octopus Agile':
        controllerPath = './victron.agile.controller';
        break;
      case 'Smart':
      case 'Smart Controller':
        controllerPath = './victron.smart.controller';
        break;
      default:
        log(`Unknown product: ${product.name}`, "ERROR");
        return false;
    }

    log(`Loading controller for product: ${product.name} (${controllerPath})`);
    
    // Check if controller file exists
    const fullPath = path.join(__dirname, controllerPath + '.js');
    try {
      await fs.access(fullPath);
    } catch (err) {
      log(`Controller file not found: ${fullPath}`, "ERROR");
      return false;
    }

    // Dynamically import the controller
    delete require.cache[require.resolve(controllerPath)];
    const ControllerModule = require(controllerPath);
    
    // Check if the controller exports a start function
    if (typeof ControllerModule.start === 'function') {
      log(`Starting controller for ${product.name}`);
      activeController = ControllerModule;
      currentActiveProduct = product;
      await ControllerModule.start();
      return true;
    } else {
      log(`Controller for ${product.name} does not export a start function`, "ERROR");
      return false;
    }
    
  } catch (error) {
    log(`Failed to load controller for ${product.name}: ${error.message}`, "ERROR");
    return false;
  }
}

// Check for product changes and reload controller if needed
async function checkProductChanges() {
  try {
    const activeProduct = await getActiveProduct();
    
    if (!activeProduct) {
      if (activeController) {
        log('No active product found, stopping current controller');
        if (typeof activeController.stop === 'function') {
          await activeController.stop();
        }
        activeController = null;
        currentActiveProduct = null;
      }
      return;
    }

    // Check if product has changed
    if (!currentActiveProduct || currentActiveProduct.id !== activeProduct.id) {
      log(`Product change detected: ${currentActiveProduct?.name || 'none'} -> ${activeProduct.name}`);
      await loadProductController(activeProduct);
    }
    
  } catch (error) {
    log(`Error checking product changes: ${error.message}`, "ERROR");
  }
}

// Graceful shutdown
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    log(`Already shutting down, ignoring ${signal}`, "WARN");
    return;
  }
  isShuttingDown = true;
  
  log(`Shutting down main controller (${signal})...`);
  
  // Stop active controller
  if (activeController && typeof activeController.stop === 'function') {
    try {
      await activeController.stop();
      log('Active controller stopped successfully');
    } catch (err) {
      log(`Error stopping active controller: ${err.message}`, "ERROR");
    }
  }
  
  // Close database connection
  if (dbClient && !dbClient._ending) {
    try {
      await dbClient.end();
      log('Database client closed');
    } catch (err) {
      log(`Error closing database client: ${err.message}`, "ERROR");
    }
  }
  
  log('Main controller shutdown complete');
  process.exit(0);
}

// Main initialization
(async () => {
  try {
    log('Starting Victron Main Controller...');
    
    // Initialize database
    const dbConnected = await initializeDatabase();
    if (!dbConnected) {
      log('Failed to connect to database, exiting', 'ERROR');
      process.exit(1);
    }
    
    // Get active product and load appropriate controller
    const activeProduct = await getActiveProduct();
    if (activeProduct) {
      const controllerLoaded = await loadProductController(activeProduct);
      if (!controllerLoaded) {
        log('Failed to load product controller, exiting', 'ERROR');
        process.exit(1);
      }
    } else {
      log('No active product found, waiting for product activation', 'WARN');
    }
    
    // Set up periodic check for product changes (every 5 minutes)
    setInterval(checkProductChanges, 5 * 60 * 1000);
    
    log('Main controller started successfully');
    
  } catch (error) {
    log(`Failed to start main controller: ${error.message}`, "ERROR");
    process.exit(1);
  }
})();

// Signal handlers
process.on('SIGINT', async () => await gracefulShutdown('SIGINT'));
process.on('SIGTERM', async () => await gracefulShutdown('SIGTERM'));

// Export functions for testing
module.exports = {
  getActiveProduct,
  loadProductController,
  checkProductChanges
};
