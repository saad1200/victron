-- Add active_soc_percent column to victron_grid_setpoints table
-- This column will control the Active SOC limit on the Victron device

ALTER TABLE victron_grid_setpoints 
ADD COLUMN IF NOT EXISTS active_soc_percent DECIMAL(5,2) DEFAULT 50.0;

-- Update existing records with appropriate active SOC values
UPDATE victron_grid_setpoints 
SET active_soc_percent = CASE 
    WHEN tariff_period = 'Night' THEN 70.0    -- Night: charge to 70%
    WHEN tariff_period = 'Day' THEN 50.0      -- Day: maintain around 50%
    WHEN tariff_period = 'Evening' THEN 50.0  -- Evening: maintain around 50%
    WHEN tariff_period = 'PEAK' THEN 30.0     -- PEAK: discharge to 30%
    ELSE 50.0
END
WHERE active_soc_percent IS NULL OR active_soc_percent = 50.0;

-- Add comment for documentation
COMMENT ON COLUMN victron_grid_setpoints.active_soc_percent IS 'Active SOC limit - target SOC level for battery management during this tariff period';

-- Show updated table structure
\d victron_grid_setpoints;

-- Show current values
SELECT tariff_period, min_soc_percent, active_soc_percent, max_soc_percent, description 
FROM victron_grid_setpoints 
WHERE device_id = 'c0619ab786e2' 
ORDER BY 
    CASE tariff_period 
        WHEN 'Night' THEN 1
        WHEN 'Day' THEN 2  
        WHEN 'PEAK' THEN 3
        WHEN 'Evening' THEN 4
    END;
