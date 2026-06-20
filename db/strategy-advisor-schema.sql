-- Strategy Advisor Schema
-- Stores daily AI-generated charging decisions based on solar forecast + battery state

CREATE TABLE IF NOT EXISTS victron_strategy_decisions (
    id SERIAL PRIMARY KEY,
    decision_date DATE NOT NULL,                          -- which night this decision applies to
    action VARCHAR(30) NOT NULL,                          -- 'skip_night_charge', 'partial_charge', 'full_charge'
    target_soc INTEGER,                                   -- target SOC % (null = default / N/A)
    confidence VARCHAR(10) DEFAULT 'medium',              -- 'high', 'medium', 'low'

    -- Input data snapshot
    solar_forecast_kwh DECIMAL(8,2),                      -- tomorrow's forecast solar yield
    battery_soc DECIMAL(5,2),                             -- SOC at time of decision
    battery_capacity_kwh DECIMAL(8,2),                    -- estimated usable battery capacity
    avg_daily_consumption_kwh DECIMAL(8,2),               -- recent avg daily consumption
    avg_daily_solar_kwh DECIMAL(8,2),                     -- recent avg daily solar yield
    import_rate_cheap_pence DECIMAL(6,2),                 -- Flux night import rate
    export_rate_peak_pence DECIMAL(6,2),                  -- Flux peak export rate

    -- Historical performance (actual data from recent days)
    avg_peak_export_kwh DECIMAL(8,2),                     -- avg actual export during peak (16-19)
    avg_peak_earnings_pence DECIMAL(10,2),                -- avg actual earnings during peak
    avg_night_import_kwh DECIMAL(8,2),                    -- avg actual import during night charge
    avg_night_cost_pence DECIMAL(10,2),                   -- avg actual cost of night charging
    system_efficiency_pct DECIMAL(5,2),                   -- round-trip efficiency (export/import ratio)

    -- AI analysis
    reasoning TEXT,                                        -- LLM explanation
    model VARCHAR(50),                                     -- e.g. 'gpt-4o-mini', 'gemini-2.0-flash'
    prompt_tokens INTEGER,
    completion_tokens INTEGER,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(decision_date)
);

CREATE INDEX IF NOT EXISTS idx_strategy_decisions_date
    ON victron_strategy_decisions(decision_date DESC);

-- Hourly solar forecast snapshots (saved with each decision)
CREATE TABLE IF NOT EXISTS victron_solar_forecasts (
    id SERIAL PRIMARY KEY,
    forecast_date DATE NOT NULL,                           -- which day the forecast is for
    hour_timestamp TIMESTAMP WITH TIME ZONE NOT NULL,      -- specific hour
    forecast_kwh DECIMAL(8,4),                             -- expected kWh for that hour
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_solar_forecasts_date
    ON victron_solar_forecasts(forecast_date DESC);

-- View: latest decision
CREATE OR REPLACE VIEW v_latest_strategy_decision AS
SELECT * FROM victron_strategy_decisions
ORDER BY decision_date DESC
LIMIT 1;

-- View: decision accuracy — compare forecast vs actual solar yield
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
