-- Products Migration Script
-- This script adds the products table and updates existing tables to support multiple tariff products

-- Create products table
CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    active BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Insert the two products
INSERT INTO products (name, active) VALUES
('Octopus Flux', true),
('Octopus Agile', false)
ON CONFLICT (name) DO UPDATE SET
    active = EXCLUDED.active,
    updated_at = CURRENT_TIMESTAMP;

-- Add product_id column to victron_tariff_periods
ALTER TABLE victron_tariff_periods 
ADD COLUMN IF NOT EXISTS product_id INTEGER REFERENCES products(id);

-- Add product_id column to victron_grid_setpoints
ALTER TABLE victron_grid_setpoints 
ADD COLUMN IF NOT EXISTS product_id INTEGER REFERENCES products(id);

-- Update existing records to use Octopus Flux product_id
UPDATE victron_tariff_periods 
SET product_id = (SELECT id FROM products WHERE name = 'Octopus Flux')
WHERE product_id IS NULL;

UPDATE victron_grid_setpoints 
SET product_id = (SELECT id FROM products WHERE name = 'Octopus Flux')
WHERE product_id IS NULL;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);
CREATE INDEX IF NOT EXISTS idx_tariff_periods_product ON victron_tariff_periods(product_id);
CREATE INDEX IF NOT EXISTS idx_grid_setpoints_product ON victron_grid_setpoints(product_id);

-- Update the views to include product information
DROP VIEW IF EXISTS v_daily_energy_summary;
CREATE OR REPLACE VIEW v_daily_energy_summary AS
SELECT 
    et.device_id,
    DATE(et.tracking_timestamp) as date,
    et.tariff_period,
    p.name as product_name,
    SUM(et.grid_import_kwh) as total_import_kwh,
    SUM(et.grid_export_kwh) as total_export_kwh,
    SUM(et.solar_generation_kwh) as total_solar_kwh,
    SUM(et.import_cost_pence) as total_import_cost_pence,
    SUM(et.export_earnings_pence) as total_export_earnings_pence,
    SUM(et.net_cost_pence) as total_net_cost_pence,
    AVG(et.battery_soc_start) as avg_soc_start,
    AVG(et.battery_soc_end) as avg_soc_end
FROM victron_energy_tracking et
LEFT JOIN victron_tariff_periods tp ON et.tariff_period = tp.period_name
LEFT JOIN products p ON tp.product_id = p.id
GROUP BY et.device_id, DATE(et.tracking_timestamp), et.tariff_period, p.name
ORDER BY date DESC, et.tariff_period;

-- Add comments for documentation
COMMENT ON TABLE products IS 'Energy tariff products (e.g., Octopus Flux, Octopus Agile)';
COMMENT ON COLUMN products.active IS 'Only one product should be active at a time';

-- Display the products
SELECT 'Products created:' as message;
SELECT id, name, active, created_at FROM products ORDER BY id;

-- Display updated table structures
SELECT 'Updated victron_tariff_periods with product_id:' as message;
SELECT tp.id, tp.period_name, p.name as product_name, tp.is_active 
FROM victron_tariff_periods tp 
LEFT JOIN products p ON tp.product_id = p.id 
ORDER BY tp.id;

SELECT 'Updated victron_grid_setpoints with product_id:' as message;
SELECT gs.id, gs.tariff_period, p.name as product_name, gs.is_active 
FROM victron_grid_setpoints gs 
LEFT JOIN products p ON gs.product_id = p.id 
ORDER BY gs.id;
