#!/usr/bin/env node

// Test script to verify Agile controller setup
const { Client } = require('pg');
require('dotenv').config();

const DB_CONFIG = {
  user: process.env.DB_USER || "postgres",
  host: process.env.DB_HOST || "localhost",
  database: process.env.DB_NAME || "victron",
  password: process.env.DB_PASSWORD || "password",
  port: process.env.DB_PORT || 5433,
};

async function testSetup() {
  const client = new Client(DB_CONFIG);
  
  try {
    console.log('🔍 Testing Agile Controller Setup...\n');
    
    // Test database connection
    await client.connect();
    console.log('✅ Database connection successful');
    
    // Check products table
    const productsResult = await client.query('SELECT id, name, active FROM products ORDER BY id');
    console.log('\n📦 Products:');
    productsResult.rows.forEach(row => {
      console.log(`   ${row.active ? '🟢' : '⚪'} ${row.name} (ID: ${row.id})`);
    });
    
    // Check active product
    const activeResult = await client.query('SELECT name FROM products WHERE active = true');
    const activeProduct = activeResult.rows[0]?.name || 'None';
    console.log(`\n🎯 Active Product: ${activeProduct}`);
    
    // Check Agile configuration
    const agileConfigResult = await client.query(`
      SELECT gs.*, p.name as product_name 
      FROM victron_grid_setpoints gs
      JOIN products p ON gs.product_id = p.id
      WHERE gs.tariff_period = 'agile_config'
    `);
    
    if (agileConfigResult.rows.length > 0) {
      console.log('\n⚙️  Agile Configuration:');
      const config = agileConfigResult.rows[0];
      console.log(`   Max Charge Rate: ${config.grid_setpoint_watts}W`);
      console.log(`   SOC Range: ${config.min_soc_percent}% - ${config.max_soc_percent}%`);
      console.log(`   Target SOC: ${config.active_soc_percent}%`);
      console.log(`   Product: ${config.product_name}`);
      console.log(`   Active: ${config.is_active ? '✅' : '❌'}`);
    } else {
      console.log('\n❌ Agile configuration not found');
      console.log('   Run: psql -d victron -f db/agile-config-migration.sql');
    }
    
    // Test controller file exists
    const fs = require('fs');
    const controllerPath = './src/victron.agile.controller.js';
    if (fs.existsSync(controllerPath)) {
      console.log('\n✅ Agile controller file exists');
    } else {
      console.log('\n❌ Agile controller file missing');
    }
    
    // Test environment variables
    console.log('\n🔧 Environment Variables:');
    console.log(`   OCTOPUS_API_KEY: ${process.env.OCTOPUS_API_KEY ? '✅ Set (sk_live_...)' : '❌ Not set'}`);
    console.log(`   AGILE_PRODUCT_CODE: ${process.env.AGILE_PRODUCT_CODE || '❌ Not set'}`);
    console.log(`   AGILE_TARIFF_CODE: ${process.env.AGILE_TARIFF_CODE || '❌ Not set'}`);
    console.log(`   EXPORT_TARIFF_CODE: ${process.env.EXPORT_TARIFF_CODE || '⚪ Optional (for export rates)'}`);
    console.log(`   MPAN: ${process.env.MPAN ? '✅ Set' : '❌ Not set'}`);
    console.log(`   MQTT_BROKER: ${process.env.MQTT_BROKER || '❌ Not set'}`);
    console.log(`   DEVICE_ID: ${process.env.DEVICE_ID || '❌ Not set'}`);
    
    // Test Octopus API with authentication
    console.log('\n🌐 Testing Octopus API with authentication...');
    const https = require('https');
    
    if (process.env.OCTOPUS_API_KEY && process.env.AGILE_PRODUCT_CODE && process.env.AGILE_TARIFF_CODE) {
      const testUrl = `https://api.octopus.energy/v1/products/${process.env.AGILE_PRODUCT_CODE}/electricity-tariffs/${process.env.AGILE_TARIFF_CODE}/standard-unit-rates/`;
      
      const apiTest = new Promise((resolve, reject) => {
        const auth = Buffer.from(`${process.env.OCTOPUS_API_KEY}:`).toString('base64');
        const options = {
          headers: {
            'Authorization': `Basic ${auth}`,
            'User-Agent': 'Victron-Agile-Test/1.0'
          }
        };
        
        const req = https.get(testUrl, options, (res) => {
          if (res.statusCode === 200) {
            resolve('✅ Octopus API authenticated successfully');
          } else if (res.statusCode === 401) {
            resolve('❌ Octopus API authentication failed (check API key)');
          } else if (res.statusCode === 404) {
            resolve('❌ Tariff not found (check AGILE_PRODUCT_CODE and AGILE_TARIFF_CODE)');
          } else {
            resolve(`⚠️  Octopus API returned status ${res.statusCode}`);
          }
        });
        req.on('error', (err) => {
          resolve(`❌ Octopus API error: ${err.message}`);
        });
        req.setTimeout(10000, () => {
          req.destroy();
          resolve('⚠️  Octopus API timeout (10s)');
        });
      });
      
      const apiResult = await apiTest;
      console.log(`   ${apiResult}`);
    } else {
      console.log('   ⚠️  Skipping API test - missing environment variables');
    }
    
    // Summary
    console.log('\n📋 Setup Summary:');
    const hasAgileProduct = productsResult.rows.some(p => p.name === 'Octopus Agile');
    const hasAgileConfig = agileConfigResult.rows.length > 0;
    const hasEnvVars = process.env.OCTOPUS_API_KEY && process.env.AGILE_TARIFF_CODE && process.env.AGILE_PRODUCT_CODE;
    
    if (hasAgileProduct && hasAgileConfig && hasEnvVars) {
      console.log('   🎉 Setup appears complete!');
      console.log('\n📝 To activate Agile controller:');
      console.log('   1. UPDATE products SET active = false WHERE name = \'Octopus Flux\';');
      console.log('   2. UPDATE products SET active = true WHERE name = \'Octopus Agile\';');
      console.log('   3. The main controller will automatically switch within 5 minutes');
    } else {
      console.log('   ⚠️  Setup incomplete:');
      if (!hasAgileProduct) console.log('      - Run products migration SQL');
      if (!hasAgileConfig) console.log('      - Run agile config migration SQL');
      if (!hasEnvVars) console.log('      - Set OCTOPUS_API_KEY, AGILE_PRODUCT_CODE, and AGILE_TARIFF_CODE in .env');
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  } finally {
    await client.end();
  }
}

// Run the test
testSetup().catch(console.error);
