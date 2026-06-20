-- Agile Configuration Migration Script
-- This script adds Octopus Agile specific configuration to the victron_grid_setpoints table

-- Insert Agile configuration record
INSERT INTO victron_grid_setpoints (
    device_id, 
    tariff_period, 
    grid_setpoint_watts, 
    min_soc_percent, 
    max_soc_percent, 
    active_soc_percent,
    ess_mode, 
    inverter_mode, 
    description,
    product_id
) VALUES (
    'c0619ab786e2',
    'agile_config',
    3000,  -- Max charge rate in watts (positive value, will be used as absolute)
    10.0,  -- Minimum SOC %
    100.0, -- Maximum SOC %
    80.0,  -- Target SOC %
    1,     -- Default ESS mode (Optimize with BatteryLife)
    3,     -- Default Inverter mode (ON)
    'Agile configuration: Max charge 3kW, discharge 5kW, target 80% SOC, optimize for dynamic pricing',
    (SELECT id FROM products WHERE name = 'Octopus Agile')
)
ON CONFLICT (device_id, tariff_period) DO UPDATE SET
    grid_setpoint_watts = EXCLUDED.grid_setpoint_watts,
    min_soc_percent = EXCLUDED.min_soc_percent,
    max_soc_percent = EXCLUDED.max_soc_percent,
    active_soc_percent = EXCLUDED.active_soc_percent,
    ess_mode = EXCLUDED.ess_mode,
    inverter_mode = EXCLUDED.inverter_mode,
    description = EXCLUDED.description,
    product_id = EXCLUDED.product_id,
    updated_at = CURRENT_TIMESTAMP;

-- Display the configuration
SELECT 'Agile configuration created:' as message;
SELECT 
    gs.device_id,
    gs.tariff_period,
    gs.grid_setpoint_watts as max_charge_watts,
    gs.min_soc_percent,
    gs.max_soc_percent,
    gs.active_soc_percent as target_soc,
    gs.description,
    p.name as product_name,
    gs.is_active
FROM victron_grid_setpoints gs
JOIN products p ON gs.product_id = p.id
WHERE gs.tariff_period = 'agile_config'
ORDER BY gs.id;
