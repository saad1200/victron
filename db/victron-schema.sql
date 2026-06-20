-- Victron Database Schema
-- Run this SQL script manually to create the required database tables
-- Usage: psql -d victron -f victron-schema.sql
--
-- Data is written every 30s (buffered averages from MQTT).
-- Raw data is auto-purged after DATA_RETENTION_DAYS (default 90).
-- Energy tracking (5-min aggregates) and strategy decisions are kept forever.

-- Battery data table
CREATE TABLE IF NOT EXISTS victron_battery_data (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    device_id VARCHAR(50) NOT NULL,
    soc NUMERIC(5,2),
    voltage NUMERIC(6,3),
    current NUMERIC(8,3),
    power NUMERIC(8,3),
    UNIQUE (timestamp, device_id)
);

CREATE INDEX IF NOT EXISTS idx_victron_battery_timestamp ON victron_battery_data(timestamp);

-- Solar PV data table (system total)
CREATE TABLE IF NOT EXISTS victron_pv_data (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    device_id VARCHAR(50) NOT NULL,
    power NUMERIC(8,3),
    voltage NUMERIC(6,3),
    current NUMERIC(8,3),
    UNIQUE (timestamp, device_id)
);

CREATE INDEX IF NOT EXISTS idx_victron_pv_timestamp ON victron_pv_data(timestamp);

-- Individual PV array tracking
CREATE TABLE IF NOT EXISTS victron_pv_arrays (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    device_id VARCHAR(50) NOT NULL,
    array_id INTEGER NOT NULL,
    power_watts NUMERIC(8,3),
    voltage_volts NUMERIC(6,3),
    UNIQUE (timestamp, device_id, array_id)
);

CREATE INDEX IF NOT EXISTS idx_victron_pv_arrays_timestamp ON victron_pv_arrays(timestamp);

-- Grid data table
CREATE TABLE IF NOT EXISTS victron_grid_data (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    device_id VARCHAR(50) NOT NULL,
    power_l1 NUMERIC(8,3),
    power_l2 NUMERIC(8,3),
    power_l3 NUMERIC(8,3),
    voltage_l1 NUMERIC(6,3),
    frequency NUMERIC(5,2),
    UNIQUE (timestamp, device_id)
);

CREATE INDEX IF NOT EXISTS idx_victron_grid_timestamp ON victron_grid_data(timestamp);

-- Inverter data table
CREATE TABLE IF NOT EXISTS victron_inverter_data (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    device_id VARCHAR(50) NOT NULL,
    power NUMERIC(8,3),
    voltage NUMERIC(6,3),
    current NUMERIC(8,3),
    UNIQUE (timestamp, device_id)
);

CREATE INDEX IF NOT EXISTS idx_victron_inverter_timestamp ON victron_inverter_data(timestamp);

-- System events table (rare — only vebus errors etc.)
CREATE TABLE IF NOT EXISTS victron_system_events (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    device_id VARCHAR(50) NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    event_value VARCHAR(100),
    description TEXT
);

CREATE INDEX IF NOT EXISTS idx_victron_events_timestamp ON victron_system_events(timestamp);

-- ═══════════════════════════════════════════════════════════════════════
-- Migration: add UNIQUE constraints to existing tables
-- Safe to re-run — uses DO blocks to skip if constraint already exists.
-- ═══════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'victron_battery_data_timestamp_device_key'
  ) THEN
    ALTER TABLE victron_battery_data
      ADD CONSTRAINT victron_battery_data_timestamp_device_key UNIQUE (timestamp, device_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'victron_pv_data_timestamp_device_key'
  ) THEN
    ALTER TABLE victron_pv_data
      ADD CONSTRAINT victron_pv_data_timestamp_device_key UNIQUE (timestamp, device_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'victron_pv_arrays_timestamp_device_array_key'
  ) THEN
    ALTER TABLE victron_pv_arrays
      ADD CONSTRAINT victron_pv_arrays_timestamp_device_array_key UNIQUE (timestamp, device_id, array_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'victron_grid_data_timestamp_device_key'
  ) THEN
    ALTER TABLE victron_grid_data
      ADD CONSTRAINT victron_grid_data_timestamp_device_key UNIQUE (timestamp, device_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'victron_inverter_data_timestamp_device_key'
  ) THEN
    ALTER TABLE victron_inverter_data
      ADD CONSTRAINT victron_inverter_data_timestamp_device_key UNIQUE (timestamp, device_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'victron_energy_tracking_timestamp_device_key'
  ) THEN
    ALTER TABLE victron_energy_tracking
      ADD CONSTRAINT victron_energy_tracking_timestamp_device_key UNIQUE (tracking_timestamp, device_id);
  END IF;
END $$;

-- Drop redundant per-column indexes now covered by unique constraints
DROP INDEX IF EXISTS idx_victron_battery_device_id;
DROP INDEX IF EXISTS idx_victron_pv_device_id;
DROP INDEX IF EXISTS idx_victron_grid_device_id;
DROP INDEX IF EXISTS idx_victron_inverter_device_id;
DROP INDEX IF EXISTS idx_victron_events_device_id;
DROP INDEX IF EXISTS idx_victron_events_type;
DROP INDEX IF EXISTS idx_victron_metrics_timestamp;
DROP INDEX IF EXISTS idx_victron_metrics_device_id;
DROP INDEX IF EXISTS idx_victron_metrics_type;
DROP INDEX IF EXISTS idx_victron_metrics_name;
DROP INDEX IF EXISTS idx_victron_pv_arrays_device_id;
DROP INDEX IF EXISTS idx_victron_pv_arrays_array_id;
