-- Octopus Flux Tariff Database Schema Extension
-- Idempotent — safe to re-run on an existing database.
-- Usage: psql -d victron -f db/flux-tariff-schema.sql

-- Table for tariff periods and rates
CREATE TABLE IF NOT EXISTS victron_tariff_periods (
    id SERIAL PRIMARY KEY,
    period_name VARCHAR(20) NOT NULL,
    import_rate_pence DECIMAL(6,2) NOT NULL,
    export_rate_pence DECIMAL(6,2) NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Table for grid setpoint configurations per tariff period
CREATE TABLE IF NOT EXISTS victron_grid_setpoints (
    id SERIAL PRIMARY KEY,
    device_id VARCHAR(50) NOT NULL,
    tariff_period VARCHAR(20) NOT NULL,
    grid_setpoint_watts INTEGER NOT NULL,
    min_soc_percent DECIMAL(5,2) DEFAULT 10.0,
    max_soc_percent DECIMAL(5,2) DEFAULT 100.0,
    ess_mode INTEGER,
    inverter_mode INTEGER DEFAULT 3,
    description TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Table for energy import/export tracking (5-min aggregates from monitoring)
CREATE TABLE IF NOT EXISTS victron_energy_tracking (
    id SERIAL PRIMARY KEY,
    device_id VARCHAR(50) NOT NULL,
    tracking_timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    tariff_period VARCHAR(20) NOT NULL,
    import_rate_pence DECIMAL(6,2) NOT NULL,
    export_rate_pence DECIMAL(6,2) NOT NULL,
    grid_import_kwh DECIMAL(10,4) DEFAULT 0,
    grid_export_kwh DECIMAL(10,4) DEFAULT 0,
    solar_generation_kwh DECIMAL(10,4) DEFAULT 0,
    battery_charge_kwh DECIMAL(10,4) DEFAULT 0,
    battery_discharge_kwh DECIMAL(10,4) DEFAULT 0,
    load_consumption_kwh DECIMAL(10,4) DEFAULT 0,
    import_cost_pence DECIMAL(10,2) DEFAULT 0,
    export_earnings_pence DECIMAL(10,2) DEFAULT 0,
    net_cost_pence DECIMAL(10,2) DEFAULT 0,
    battery_soc_start DECIMAL(5,2),
    battery_soc_end DECIMAL(5,2),
    grid_setpoint_watts INTEGER,
    ess_mode INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Table for tariff period transitions and decisions
CREATE TABLE IF NOT EXISTS victron_tariff_events (
    id SERIAL PRIMARY KEY,
    device_id VARCHAR(50) NOT NULL,
    event_timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    event_type VARCHAR(30) NOT NULL,
    from_period VARCHAR(20),
    to_period VARCHAR(20),
    from_setpoint INTEGER,
    to_setpoint INTEGER,
    from_ess_mode INTEGER,
    to_ess_mode INTEGER,
    battery_soc DECIMAL(5,2),
    reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_energy_tracking_timestamp ON victron_energy_tracking(tracking_timestamp);
CREATE INDEX IF NOT EXISTS idx_energy_tracking_period ON victron_energy_tracking(tariff_period);
CREATE INDEX IF NOT EXISTS idx_tariff_events_timestamp ON victron_tariff_events(event_timestamp);
CREATE INDEX IF NOT EXISTS idx_grid_setpoints_device ON victron_grid_setpoints(device_id, is_active);

-- ═══════════════════════════════════════════════════════════════════════
-- Migration: add constraints to existing tables
-- ═══════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'victron_grid_setpoints_device_id_tariff_period_key'
  ) THEN
    ALTER TABLE victron_grid_setpoints
      ADD CONSTRAINT victron_grid_setpoints_device_id_tariff_period_key UNIQUE (device_id, tariff_period);
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

-- Migration: add columns that may not exist on older installs
ALTER TABLE victron_energy_tracking ADD COLUMN IF NOT EXISTS import_rate_pence DECIMAL(6,2);
ALTER TABLE victron_energy_tracking ADD COLUMN IF NOT EXISTS export_rate_pence DECIMAL(6,2);
ALTER TABLE victron_energy_tracking ADD COLUMN IF NOT EXISTS total_cost_pence DECIMAL(10,2);

-- ═══════════════════════════════════════════════════════════════════════
-- Views
-- ═══════════════════════════════════════════════════════════════════════

DROP VIEW IF EXISTS v_daily_energy_summary CASCADE;
CREATE OR REPLACE VIEW v_daily_energy_summary AS
SELECT 
    device_id,
    DATE(tracking_timestamp) as date,
    tariff_period,
    SUM(grid_import_kwh) as total_import_kwh,
    SUM(grid_export_kwh) as total_export_kwh,
    SUM(solar_generation_kwh) as total_solar_kwh,
    SUM(import_cost_pence) as total_import_cost_pence,
    SUM(export_earnings_pence) as total_export_earnings_pence,
    SUM(net_cost_pence) as total_net_cost_pence,
    AVG(battery_soc_start) as avg_soc_start,
    AVG(battery_soc_end) as avg_soc_end
FROM victron_energy_tracking
GROUP BY device_id, DATE(tracking_timestamp), tariff_period
ORDER BY date DESC, tariff_period;

DROP VIEW IF EXISTS v_tariff_period_performance CASCADE;
CREATE OR REPLACE VIEW v_tariff_period_performance AS
SELECT 
    tariff_period,
    COUNT(*) as periods_count,
    AVG(grid_import_kwh) as avg_import_kwh,
    AVG(grid_export_kwh) as avg_export_kwh,
    AVG(net_cost_pence) as avg_net_cost_pence,
    SUM(import_cost_pence) as total_import_cost_pence,
    SUM(export_earnings_pence) as total_export_earnings_pence,
    SUM(net_cost_pence) as total_net_cost_pence
FROM victron_energy_tracking
WHERE tracking_timestamp >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY tariff_period
ORDER BY tariff_period;

-- ═══════════════════════════════════════════════════════════════════════
-- Seed data (no-op if already exists)
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO victron_tariff_periods (period_name, import_rate_pence, export_rate_pence, start_time, end_time) VALUES
('Night', 16.61, 5.05, '02:00:00', '05:00:00'),
('Day', 27.68, 10.24, '05:00:00', '16:00:00'),
('PEAK', 38.75, 29.79, '16:00:00', '19:00:00'),
('Evening', 27.68, 10.24, '19:00:00', '02:00:00')
ON CONFLICT DO NOTHING;

INSERT INTO victron_grid_setpoints (device_id, tariff_period, grid_setpoint_watts, min_soc_percent, max_soc_percent, ess_mode, inverter_mode, description) VALUES
('c0619ab786e2', 'Night', 3000, 10.0, 70.0, 1, 1, 'Night charging: Import up to 3kW to charge battery to 70% - Charger Only mode'),
('c0619ab786e2', 'Day', 0, 10.0, 100.0, NULL, 3, 'Day: Solar priority, 0W setpoint, maintain min 10% SOC - Inverter ON'),
('c0619ab786e2', 'Evening', 0, 10.0, 100.0, NULL, 3, 'Evening: Solar priority, 0W setpoint, maintain min 10% SOC - Inverter ON'),
('c0619ab786e2', 'PEAK', -12000, 10.0, 100.0, NULL, 3, 'Peak: Maximum export 12kW, discharge battery at full rate - Inverter ON')
ON CONFLICT (device_id, tariff_period) DO NOTHING;

COMMENT ON TABLE victron_tariff_periods IS 'Octopus Flux tariff periods with import/export rates';
COMMENT ON TABLE victron_grid_setpoints IS 'Grid setpoint configurations for each tariff period to maximize profit';
COMMENT ON TABLE victron_energy_tracking IS 'Detailed energy import/export tracking for financial analysis (5-min aggregates, kept forever)';
COMMENT ON TABLE victron_tariff_events IS 'Log of tariff period changes and system decisions';
