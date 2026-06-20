-- Add active_soc_percent column to victron_grid_setpoints table
-- Idempotent — safe to re-run.
-- Usage: psql -d victron -f db/add-active-soc-column.sql

ALTER TABLE victron_grid_setpoints 
ADD COLUMN IF NOT EXISTS active_soc_percent DECIMAL(5,2) DEFAULT 50.0;

-- Back-fill existing records with appropriate active SOC values
UPDATE victron_grid_setpoints 
SET active_soc_percent = CASE 
    WHEN tariff_period = 'Night' THEN 70.0
    WHEN tariff_period = 'Day' THEN 50.0
    WHEN tariff_period = 'Evening' THEN 50.0
    WHEN tariff_period = 'PEAK' THEN 30.0
    ELSE 50.0
END
WHERE active_soc_percent IS NULL OR active_soc_percent = 50.0;

COMMENT ON COLUMN victron_grid_setpoints.active_soc_percent IS 'Active SOC limit - target SOC level for battery management during this tariff period';
