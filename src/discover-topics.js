const mqtt = require('mqtt');
require('dotenv').config();

const MQTT_BROKER_URL = process.env.MQTT_BROKER;
const DEVICE_ID = process.env.DEVICE_ID;

console.log(`Connecting to MQTT broker: ${MQTT_BROKER_URL}`);
console.log(`Device ID: ${DEVICE_ID}`);

const client = mqtt.connect(MQTT_BROKER_URL);
const discoveredTopics = new Set();

client.on('connect', () => {
  console.log('Connected to MQTT broker');
  console.log('Subscribing to all topics for device...');
  
  // Subscribe to all topics for this device
  client.subscribe(`N/${DEVICE_ID}/#`, (err) => {
    if (err) {
      console.error('Subscription error:', err);
    } else {
      console.log(`Subscribed to N/${DEVICE_ID}/#`);
      console.log('Listening for messages for 30 seconds...\n');
    }
  });
});

client.on('message', (topic, message) => {
  if (!discoveredTopics.has(topic)) {
    discoveredTopics.add(topic);
    try {
      const data = JSON.parse(message.toString());
      console.log(`${topic}: ${JSON.stringify(data)}`);
    } catch (e) {
      console.log(`${topic}: ${message.toString()}`);
    }
  }
});

client.on('error', (err) => {
  console.error('MQTT error:', err);
});

// Run for 30 seconds then exit
setTimeout(() => {
  console.log(`\n\nDiscovered ${discoveredTopics.size} unique topics:`);
  Array.from(discoveredTopics).sort().forEach(topic => {
    console.log(`  ${topic}`);
  });
  
  client.end();
  process.exit(0);
}, 30000);
