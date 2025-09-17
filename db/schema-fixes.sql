-- Database Schema Fixes
-- Run this to fix the schema mismatches causing errors

-- Fix 1: Add missing 'category' column to victron_metrics table
-- The code expects 'category' but the table has 'metric_type'
ALTER TABLE victron_metrics 
ADD COLUMN IF NOT EXISTS category VARCHAR(100);

-- Update existing data to populate category from metric_type
UPDATE victron_metrics 
SET category = metric_type 
WHERE category IS NULL;

-- Fix 2: Rename 'metric' column to match what code expects
ALTER TABLE victron_metrics 
ADD COLUMN IF NOT EXISTS metric VARCHAR(100);

-- Update existing data
UPDATE victron_metrics 
SET metric = metric_name 
WHERE metric IS NULL;

-- Fix 3: Add missing 'topic' column (code expects 'topic' but table has 'raw_topic')
ALTER TABLE victron_metrics 
ADD COLUMN IF NOT EXISTS topic VARCHAR(255);

-- Update existing data
UPDATE victron_metrics 
SET topic = raw_topic 
WHERE topic IS NULL;

-- Fix 4: Add unique constraint to victron_inverter_data for ON CONFLICT
-- The ON CONFLICT (timestamp) requires a unique constraint
ALTER TABLE victron_inverter_data 
ADD CONSTRAINT IF NOT EXISTS victron_inverter_data_timestamp_device_key 
UNIQUE (timestamp, device_id);

-- Fix 5: Add device_id to the unique constraint for better data integrity
-- Drop the previous constraint and add a better one
ALTER TABLE victron_inverter_data 
DROP CONSTRAINT IF EXISTS victron_inverter_data_timestamp_key;

-- Add unique constraints to various data tables for timestamp and device_id
-- These constraints enable ON CONFLICT handling in data insertion functions

-- Battery data unique constraint
ALTER TABLE victron_battery_data 
ADD CONSTRAINT victron_battery_data_timestamp_device_key 
UNIQUE (timestamp, device_id);

-- PV data unique constraint  
ALTER TABLE victron_pv_data
ADD CONSTRAINT victron_pv_data_timestamp_device_key
UNIQUE (timestamp, device_id);

-- Grid data unique constraint
ALTER TABLE victron_grid_data
ADD CONSTRAINT victron_grid_data_timestamp_device_key
UNIQUE (timestamp, device_id);

-- Inverter data unique constraint
ALTER TABLE victron_inverter_data
ADD CONSTRAINT victron_inverter_data_timestamp_device_key
UNIQUE (timestamp, device_id);

-- PV arrays unique constraint
ALTER TABLE victron_pv_arrays
ADD CONSTRAINT victron_pv_arrays_timestamp_device_array_key
UNIQUE (timestamp, device_id, array_id);

-- Energy tracking unique constraint to prevent duplicates
ALTER TABLE victron_energy_tracking
ADD CONSTRAINT victron_energy_tracking_timestamp_device_key
UNIQUE (tracking_timestamp, device_id);

-- Comments for documentation
COMMENT ON CONSTRAINT victron_battery_data_timestamp_device_key ON victron_battery_data IS 'Prevents duplicate battery readings for same timestamp and device';
COMMENT ON CONSTRAINT victron_pv_data_timestamp_device_key ON victron_pv_data IS 'Prevents duplicate PV readings for same timestamp and device';
COMMENT ON CONSTRAINT victron_grid_data_timestamp_device_key ON victron_grid_data IS 'Prevents duplicate grid readings for same timestamp and device';
COMMENT ON CONSTRAINT victron_inverter_data_timestamp_device_key ON victron_inverter_data IS 'Prevents duplicate inverter readings for same timestamp and device';
COMMENT ON CONSTRAINT victron_pv_arrays_timestamp_device_array_key ON victron_pv_arrays IS 'Prevents duplicate PV array readings for same timestamp, device and array';
COMMENT ON CONSTRAINT victron_energy_tracking_timestamp_device_key ON victron_energy_tracking IS 'Prevents duplicate energy tracking records for same timestamp and device';

-- Fix 7: Create victron_pv_arrays table for individual PV array tracking
CREATE TABLE IF NOT EXISTS victron_pv_arrays (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    device_id VARCHAR(50) NOT NULL,
    array_id INTEGER NOT NULL,
    power NUMERIC(8,3),
    voltage NUMERIC(6,3)
);

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_victron_pv_arrays_timestamp ON victron_pv_arrays(timestamp);
CREATE INDEX IF NOT EXISTS idx_victron_pv_arrays_device_id ON victron_pv_arrays(device_id);
CREATE INDEX IF NOT EXISTS idx_victron_pv_arrays_array_id ON victron_pv_arrays(array_id);

-- Show updated table structure
\d victron_metrics;
\d victron_inverter_data;
\d victron_pv_arrays;
