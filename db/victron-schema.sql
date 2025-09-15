-- Victron Database Schema
-- Run this SQL script manually to create the required database tables
-- Usage: psql -d victron -f victron-schema.sql

-- Main metrics table for all individual measurements
CREATE TABLE IF NOT EXISTS victron_metrics (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    device_id VARCHAR(50) NOT NULL,
    metric_type VARCHAR(100) NOT NULL,
    metric_name VARCHAR(100) NOT NULL,
    value NUMERIC(10,3),
    unit VARCHAR(20),
    raw_topic VARCHAR(255)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_victron_metrics_timestamp ON victron_metrics(timestamp);
CREATE INDEX IF NOT EXISTS idx_victron_metrics_device_id ON victron_metrics(device_id);
CREATE INDEX IF NOT EXISTS idx_victron_metrics_type ON victron_metrics(metric_type);
CREATE INDEX IF NOT EXISTS idx_victron_metrics_name ON victron_metrics(metric_name);

-- Battery data table for structured battery metrics
CREATE TABLE IF NOT EXISTS victron_battery_data (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    device_id VARCHAR(50) NOT NULL,
    soc NUMERIC(5,2),
    voltage NUMERIC(6,3),
    current NUMERIC(8,3),
    power NUMERIC(8,3)
);

CREATE INDEX IF NOT EXISTS idx_victron_battery_timestamp ON victron_battery_data(timestamp);
CREATE INDEX IF NOT EXISTS idx_victron_battery_device_id ON victron_battery_data(device_id);

-- Solar PV data table
CREATE TABLE IF NOT EXISTS victron_pv_data (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    device_id VARCHAR(50) NOT NULL,
    power NUMERIC(8,3),
    voltage NUMERIC(6,3),
    current NUMERIC(8,3)
);

CREATE INDEX IF NOT EXISTS idx_victron_pv_timestamp ON victron_pv_data(timestamp);
CREATE INDEX IF NOT EXISTS idx_victron_pv_device_id ON victron_pv_data(device_id);

-- Grid data table
CREATE TABLE IF NOT EXISTS victron_grid_data (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    device_id VARCHAR(50) NOT NULL,
    power_l1 NUMERIC(8,3),
    power_l2 NUMERIC(8,3),
    power_l3 NUMERIC(8,3),
    voltage_l1 NUMERIC(6,3),
    frequency NUMERIC(5,2)
);

CREATE INDEX IF NOT EXISTS idx_victron_grid_timestamp ON victron_grid_data(timestamp);
CREATE INDEX IF NOT EXISTS idx_victron_grid_device_id ON victron_grid_data(device_id);

-- Inverter data table
CREATE TABLE IF NOT EXISTS victron_inverter_data (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    device_id VARCHAR(50) NOT NULL,
    power NUMERIC(8,3),
    voltage NUMERIC(6,3),
    current NUMERIC(8,3)
);

CREATE INDEX IF NOT EXISTS idx_victron_inverter_timestamp ON victron_inverter_data(timestamp);
CREATE INDEX IF NOT EXISTS idx_victron_inverter_device_id ON victron_inverter_data(device_id);

-- System events table for tracking system state changes
CREATE TABLE IF NOT EXISTS victron_system_events (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    device_id VARCHAR(50) NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    event_value VARCHAR(100),
    description TEXT
);

CREATE INDEX IF NOT EXISTS idx_victron_events_timestamp ON victron_system_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_victron_events_device_id ON victron_system_events(device_id);
CREATE INDEX IF NOT EXISTS idx_victron_events_type ON victron_system_events(event_type);

-- Display table information
SELECT 'victron_metrics' as table_name UNION ALL
SELECT 'victron_battery_data' UNION ALL
SELECT 'victron_pv_data' UNION ALL
SELECT 'victron_grid_data' UNION ALL
SELECT 'victron_inverter_data' UNION ALL
SELECT 'victron_system_events';
