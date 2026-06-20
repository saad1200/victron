-- Strategy Advisor Schema
-- Idempotent — safe to re-run on an existing database.
-- Usage: psql -d victron -f db/strategy-advisor-schema.sql

CREATE TABLE IF NOT EXISTS victron_strategy_decisions (
    id SERIAL PRIMARY KEY,
    decision_date DATE NOT NULL,
    action VARCHAR(30) NOT NULL,
    target_soc INTEGER,
    confidence VARCHAR(10) DEFAULT 'medium',
    solar_forecast_kwh DECIMAL(8,2),
    battery_soc DECIMAL(5,2),
    battery_capacity_kwh DECIMAL(8,2),
    avg_daily_consumption_kwh DECIMAL(8,2),
    avg_daily_solar_kwh DECIMAL(8,2),
    import_rate_cheap_pence DECIMAL(6,2),
    export_rate_peak_pence DECIMAL(6,2),
    reasoning TEXT,
    model VARCHAR(50),
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_strategy_decisions_date
    ON victron_strategy_decisions(decision_date DESC);

-- Hourly solar forecast snapshots (saved with each decision)
CREATE TABLE IF NOT EXISTS victron_solar_forecasts (
    id SERIAL PRIMARY KEY,
    forecast_date DATE NOT NULL,
    hour_timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    forecast_kwh DECIMAL(8,4),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_solar_forecasts_date
    ON victron_solar_forecasts(forecast_date DESC);

-- ═══════════════════════════════════════════════════════════════════════
-- Migration: add constraints and columns to existing tables
-- ═══════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'victron_strategy_decisions_decision_date_key'
  ) THEN
    ALTER TABLE victron_strategy_decisions
      ADD CONSTRAINT victron_strategy_decisions_decision_date_key UNIQUE (decision_date);
  END IF;
END $$;

-- Columns added after initial release (historical performance data)
ALTER TABLE victron_strategy_decisions ADD COLUMN IF NOT EXISTS avg_peak_export_kwh DECIMAL(8,2);
ALTER TABLE victron_strategy_decisions ADD COLUMN IF NOT EXISTS avg_peak_earnings_pence DECIMAL(10,2);
ALTER TABLE victron_strategy_decisions ADD COLUMN IF NOT EXISTS avg_night_import_kwh DECIMAL(8,2);
ALTER TABLE victron_strategy_decisions ADD COLUMN IF NOT EXISTS avg_night_cost_pence DECIMAL(10,2);
ALTER TABLE victron_strategy_decisions ADD COLUMN IF NOT EXISTS system_efficiency_pct DECIMAL(5,2);

-- ═══════════════════════════════════════════════════════════════════════
-- Views
-- ═══════════════════════════════════════════════════════════════════════

DROP VIEW IF EXISTS v_latest_strategy_decision CASCADE;
CREATE OR REPLACE VIEW v_latest_strategy_decision AS
SELECT * FROM victron_strategy_decisions
ORDER BY decision_date DESC
LIMIT 1;

DROP VIEW IF EXISTS v_decision_accuracy CASCADE;
CREATE OR REPLACE VIEW v_decision_accuracy AS
SELECT
    d.decision_date,
    d.action,
    d.solar_forecast_kwh,
    COALESCE(SUM(e.total_solar_kwh), 0) AS actual_solar_kwh,
    d.avg_peak_export_kwh AS expected_peak_export,
    COALESCE(peak.actual_peak_export, 0) AS actual_peak_export,
    d.avg_night_cost_pence AS expected_night_cost,
    COALESCE(night.actual_night_cost, 0) AS actual_night_cost,
    d.reasoning
FROM victron_strategy_decisions d
LEFT JOIN v_daily_energy_summary e
    ON e.date = d.decision_date
LEFT JOIN (
    SELECT date, SUM(total_export_kwh) AS actual_peak_export
    FROM v_daily_energy_summary
    WHERE tariff_period = 'PEAK'
    GROUP BY date
) peak ON peak.date = d.decision_date
LEFT JOIN (
    SELECT date, SUM(COALESCE(total_import_cost_pence, 0)) AS actual_night_cost
    FROM v_daily_energy_summary
    WHERE tariff_period = 'Night'
    GROUP BY date
) night ON night.date = d.decision_date
GROUP BY d.decision_date, d.action, d.solar_forecast_kwh,
         d.avg_peak_export_kwh, peak.actual_peak_export,
         d.avg_night_cost_pence, night.actual_night_cost, d.reasoning
ORDER BY d.decision_date DESC;

COMMENT ON TABLE victron_strategy_decisions IS 'Daily AI-generated night charging decisions based on solar forecast, historical performance, and battery state';
COMMENT ON TABLE victron_solar_forecasts IS 'Hourly solar forecast snapshots saved with each advisor decision';
