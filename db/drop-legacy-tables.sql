-- Drop Legacy / Duplicate Tables
-- Run this ONCE to clean up obsolete tables that are no longer written to.
--
-- Removed tables:
--   victron_metrics         — duplicated all specific data tables (battery, pv, grid, etc.)
--   victron_battery_snapshots — duplicated victron_battery_data (old charge controller)
--   victron_charge_sessions   — replaced by victron_strategy_decisions + tariff_events
--   victron_charge_events     — replaced by victron_tariff_events
--   victron_charge_config     — replaced by victron_grid_setpoints + tariff_periods
--
-- Also drops associated views.
--
-- Usage: psql -d victron -f db/drop-legacy-tables.sql

-- Drop views that depend on legacy tables first
DROP VIEW IF EXISTS v_charge_session_summary CASCADE;
DROP VIEW IF EXISTS v_daily_charge_stats CASCADE;

-- Drop legacy tables
DROP TABLE IF EXISTS victron_metrics CASCADE;
DROP TABLE IF EXISTS victron_battery_snapshots CASCADE;
DROP TABLE IF EXISTS victron_charge_events CASCADE;
DROP TABLE IF EXISTS victron_charge_sessions CASCADE;
DROP TABLE IF EXISTS victron_charge_config CASCADE;

SELECT 'Legacy tables dropped successfully' AS status;
