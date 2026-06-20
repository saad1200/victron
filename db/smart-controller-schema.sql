-- Smart Controller & EV Charger Database Schema Extension
-- Run: psql -d victron -f db/smart-controller-schema.sql

-- EV Charger raw data (from victron.collection.js)
CREATE TABLE IF NOT EXISTS victron_ev_data (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    device_id VARCHAR(50) NOT NULL,
    power_watts NUMERIC(8,1),
    current_amps NUMERIC(6,2),
    energy_kwh NUMERIC(10,3),
    status INTEGER
);

CREATE INDEX IF NOT EXISTS idx_ev_data_timestamp ON victron_ev_data(timestamp);
CREATE INDEX IF NOT EXISTS idx_ev_data_device ON victron_ev_data(device_id);

-- EV Charger events (from smart controller decisions)
CREATE TABLE IF NOT EXISTS victron_ev_events (
    id SERIAL PRIMARY KEY,
    event_timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    device_id VARCHAR(50) NOT NULL,
    event_type VARCHAR(50) NOT NULL,  -- 'charge_max', 'charge_solar_NNA', 'charge_min', 'paused_peak', 'paused_no_surplus', etc.
    ev_status INTEGER,                -- EVCS status code at time of event
    ev_power_watts NUMERIC(8,1),
    ev_current_amps NUMERIC(6,2),
    battery_soc NUMERIC(5,2),
    solar_power_watts NUMERIC(8,1),
    grid_power_watts NUMERIC(8,1),
    description TEXT
);

CREATE INDEX IF NOT EXISTS idx_ev_events_timestamp ON victron_ev_events(event_timestamp);
CREATE INDEX IF NOT EXISTS idx_ev_events_device ON victron_ev_events(device_id);
CREATE INDEX IF NOT EXISTS idx_ev_events_type ON victron_ev_events(event_type);

-- EV charging sessions (aggregated)
CREATE TABLE IF NOT EXISTS victron_ev_sessions (
    id SERIAL PRIMARY KEY,
    device_id VARCHAR(50) NOT NULL,
    session_start TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    session_end TIMESTAMPTZ,
    energy_kwh NUMERIC(10,3),
    peak_power_watts NUMERIC(8,1),
    avg_power_watts NUMERIC(8,1),
    solar_percentage NUMERIC(5,2),   -- % of charge from solar
    grid_percentage NUMERIC(5,2),    -- % of charge from grid
    battery_percentage NUMERIC(5,2), -- % of charge from battery
    estimated_cost_pence NUMERIC(10,2),
    session_status VARCHAR(20) DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS idx_ev_sessions_device ON victron_ev_sessions(device_id);

-- View: Daily EV charging summary
CREATE OR REPLACE VIEW v_daily_ev_summary AS
SELECT
    device_id,
    DATE(timestamp) as date,
    COUNT(*) as data_points,
    MAX(power_watts) as peak_power_watts,
    AVG(CASE WHEN power_watts > 0 THEN power_watts END) as avg_power_watts,
    MAX(energy_kwh) - MIN(energy_kwh) as energy_charged_kwh,
    SUM(CASE WHEN power_watts > 0 THEN 1 ELSE 0 END) as charging_samples,
    SUM(CASE WHEN power_watts = 0 OR power_watts IS NULL THEN 1 ELSE 0 END) as idle_samples
FROM victron_ev_data
GROUP BY device_id, DATE(timestamp)
ORDER BY date DESC;

-- View: Smart controller decision log (uses existing victron_tariff_events)
CREATE OR REPLACE VIEW v_smart_decisions AS
SELECT
    event_timestamp,
    device_id,
    event_type,
    from_period,
    to_period,
    from_setpoint,
    to_setpoint,
    from_ess_mode,
    to_ess_mode,
    battery_soc,
    reason
FROM victron_tariff_events
WHERE event_type IN ('period_change', 'strategy_change', 'anti_export', 'ev_action')
ORDER BY event_timestamp DESC;

COMMENT ON TABLE victron_ev_data IS 'Raw EV charger metrics from MQTT';
COMMENT ON TABLE victron_ev_events IS 'Smart controller EV charging decisions';
COMMENT ON TABLE victron_ev_sessions IS 'Aggregated EV charging sessions with source breakdown';
