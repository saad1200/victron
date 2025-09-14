-- Charge Controller Database Schema
-- This extends the existing Victron schema with charge control logging tables

-- Table for charge controller sessions (each charging period)
CREATE TABLE IF NOT EXISTS victron_charge_sessions (
    id SERIAL PRIMARY KEY,
    device_id VARCHAR(50) NOT NULL,
    session_start TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    session_end TIMESTAMP WITH TIME ZONE,
    start_soc DECIMAL(5,2),
    end_soc DECIMAL(5,2),
    target_soc DECIMAL(5,2) NOT NULL,
    charge_window_start TIME NOT NULL,
    charge_window_end TIME NOT NULL,
    session_status VARCHAR(20) DEFAULT 'active', -- active, completed, interrupted, failed
    total_charge_time_minutes INTEGER,
    energy_charged_kwh DECIMAL(10,3),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Table for detailed charge controller events and decisions
CREATE TABLE IF NOT EXISTS victron_charge_events (
    id SERIAL PRIMARY KEY,
    device_id VARCHAR(50) NOT NULL,
    charge_session_id INTEGER REFERENCES victron_charge_sessions(id),
    event_timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    event_type VARCHAR(50) NOT NULL, -- 'session_start', 'session_end', 'mode_change', 'soc_check', 'window_check', 'target_reached', 'error'
    event_description TEXT,
    battery_soc DECIMAL(5,2),
    ess_mode_before INTEGER,
    ess_mode_after INTEGER,
    in_charging_window BOOLEAN,
    should_charge BOOLEAN,
    is_charging BOOLEAN,
    battery_power DECIMAL(10,2), -- Watts (positive = charging, negative = discharging)
    battery_voltage DECIMAL(6,2), -- Volts
    battery_current DECIMAL(8,2), -- Amps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Table for battery state snapshots (high-frequency logging during charging)
CREATE TABLE IF NOT EXISTS victron_battery_snapshots (
    id SERIAL PRIMARY KEY,
    device_id VARCHAR(50) NOT NULL,
    charge_session_id INTEGER REFERENCES victron_charge_sessions(id),
    snapshot_timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    soc DECIMAL(5,2) NOT NULL,
    voltage DECIMAL(6,2),
    current DECIMAL(8,2),
    power DECIMAL(10,2),
    temperature DECIMAL(5,1), -- If available
    ess_mode INTEGER,
    system_state INTEGER,
    is_charging BOOLEAN,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Table for charge controller configuration and settings
CREATE TABLE IF NOT EXISTS victron_charge_config (
    id SERIAL PRIMARY KEY,
    device_id VARCHAR(50) NOT NULL,
    config_name VARCHAR(100) NOT NULL,
    config_value TEXT NOT NULL,
    config_type VARCHAR(20) DEFAULT 'string', -- string, number, boolean, time
    description TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(device_id, config_name)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_charge_sessions_device_start ON victron_charge_sessions(device_id, session_start);
CREATE INDEX IF NOT EXISTS idx_charge_events_session ON victron_charge_events(charge_session_id);
CREATE INDEX IF NOT EXISTS idx_charge_events_timestamp ON victron_charge_events(event_timestamp);
CREATE INDEX IF NOT EXISTS idx_battery_snapshots_session ON victron_battery_snapshots(charge_session_id);
CREATE INDEX IF NOT EXISTS idx_battery_snapshots_timestamp ON victron_battery_snapshots(snapshot_timestamp);
CREATE INDEX IF NOT EXISTS idx_charge_config_device ON victron_charge_config(device_id, is_active);

-- Views for analysis
CREATE OR REPLACE VIEW v_charge_session_summary AS
SELECT 
    cs.*,
    COUNT(ce.id) as total_events,
    COUNT(bs.id) as total_snapshots,
    AVG(bs.soc) as avg_soc_during_session,
    MAX(bs.power) as max_charge_power,
    AVG(bs.power) as avg_charge_power
FROM victron_charge_sessions cs
LEFT JOIN victron_charge_events ce ON cs.id = ce.charge_session_id
LEFT JOIN victron_battery_snapshots bs ON cs.id = bs.charge_session_id
GROUP BY cs.id;

CREATE OR REPLACE VIEW v_daily_charge_stats AS
SELECT 
    device_id,
    DATE(session_start) as charge_date,
    COUNT(*) as sessions_count,
    SUM(total_charge_time_minutes) as total_charge_minutes,
    SUM(energy_charged_kwh) as total_energy_kwh,
    AVG(start_soc) as avg_start_soc,
    AVG(end_soc) as avg_end_soc,
    MAX(end_soc) as max_soc_reached
FROM victron_charge_sessions
WHERE session_status = 'completed'
GROUP BY device_id, DATE(session_start)
ORDER BY charge_date DESC;

-- Insert default configuration
INSERT INTO victron_charge_config (device_id, config_name, config_value, config_type, description) 
VALUES 
    ('c0619ab786e2', 'target_soc', '70', 'number', 'Target State of Charge percentage'),
    ('c0619ab786e2', 'charge_start_hour', '2', 'number', 'Charging window start hour (24h format)'),
    ('c0619ab786e2', 'charge_end_hour', '5', 'number', 'Charging window end hour (24h format)'),
    ('c0619ab786e2', 'snapshot_interval_seconds', '60', 'number', 'Battery snapshot logging interval during charging'),
    ('c0619ab786e2', 'max_charge_power_watts', '3000', 'number', 'Maximum allowed charge power'),
    ('c0619ab786e2', 'enable_logging', 'true', 'boolean', 'Enable detailed charge controller logging')
ON CONFLICT (device_id, config_name) DO NOTHING;

-- Comments for documentation
COMMENT ON TABLE victron_charge_sessions IS 'Records each charging session with start/end times and SOC levels';
COMMENT ON TABLE victron_charge_events IS 'Detailed log of all charge controller decisions and events';
COMMENT ON TABLE victron_battery_snapshots IS 'High-frequency battery state logging during charging sessions';
COMMENT ON TABLE victron_charge_config IS 'Configuration settings for the charge controller';
