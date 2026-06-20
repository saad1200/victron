# Octopus Agile Controller

The Octopus Agile Controller is a dynamic energy management system that optimizes battery charging and discharging based on real-time Octopus Energy Agile tariff rates.

## Features

### 🔄 **Dynamic Rate Fetching**
- Fetches current and future Agile rates from Octopus Energy API
- Updates rates hourly automatically
- Caches rates for 24 hours ahead for forecasting

### 🧠 **Intelligent Decision Making**
- **Negative Rate Charging**: Aggressive charging when rates are negative (you get paid to import)
- **Cheap Rate Charging**: Charges battery when rates are very low (configurable threshold)
- **Expensive Rate Discharging**: Discharges battery when rates are high to maximize export profit
- **Self-Consumption Optimization**: Prioritizes using solar generation and battery over grid import

### ⚡ **Adaptive Strategies**

#### 1. **Negative Rate Strategy** (Rate ≤ 0p/kWh)
- Maximum charging at full rate (3kW default)
- Charger-only mode to prevent any discharge
- Overrides SOC limits to maximize benefit

#### 2. **Cheap Rate Strategy** (Rate ≤ 10p/kWh)
- Charges battery if SOC below target (80% default)
- Maintains current SOC if already at target
- Normal inverter operation

#### 3. **Expensive Rate Strategy** (Rate ≥ 25p/kWh)
- Discharges battery at maximum rate (5kW default)
- Maintains 10% buffer above minimum SOC for safety
- Maximizes export earnings

#### 4. **Self-Consumption Strategy** (Moderate rates)
- Prioritizes solar charging when available
- Uses battery for loads when economical
- Preserves battery if cheaper rates are forecast soon

### 📊 **Rate Analysis**
- Analyzes 6-hour forecast for optimal decisions
- Identifies cheapest and most expensive upcoming periods
- Calculates average rates for comparison

## Configuration

### Environment Variables
Add these to your `.env` file:

```bash
# Octopus Agile Configuration
AGILE_TARIFF_CODE=E-1R-AGILE-FLEX-22-11-25
AGILE_REGION_CODE=H  # H = Southern England
```

### Database Configuration
The controller uses the `victron_grid_setpoints` table with `tariff_period = 'agile_config'`:

- `grid_setpoint_watts`: Maximum charge rate (3000W default)
- `min_soc_percent`: Minimum SOC (10% default)  
- `max_soc_percent`: Maximum SOC (100% default)
- `active_soc_percent`: Target SOC (80% default)

### Rate Thresholds (Configurable in code)
```javascript
agileConfig = {
  cheapRateThreshold: 10,     // pence - charge when below
  expensiveRateThreshold: 25, // pence - discharge when above  
  negativeRateThreshold: 0,   // pence - aggressive charge when negative
  maxChargeRate: 3000,        // watts
  maxDischargeRate: 5000,     // watts
}
```

## Installation & Setup

### 1. Run Database Migration
```bash
psql -d victron -f db/agile-config-migration.sql
```

### 2. Configure Environment
```bash
cp .env.agile.example .env
# Edit .env with your Octopus tariff details
```

### 3. Switch to Agile Product
```sql
-- Switch from Flux to Agile
UPDATE products SET active = false WHERE name = 'Octopus Flux';
UPDATE products SET active = true WHERE name = 'Octopus Agile';
```

### 4. Restart Controller
The main controller will automatically detect the product change and switch to the Agile controller.

## API Integration

### Octopus Energy API
- **Endpoint**: `https://api.octopus.energy/v1/products/{tariff_code}/electricity-tariffs/{tariff_code}-{region}/standard-unit-rates/`
- **Rate Limit**: No authentication required for Agile rates
- **Update Frequency**: Hourly
- **Forecast**: 24 hours ahead

### Rate Structure
```json
{
  "results": [
    {
      "value_inc_vat": 15.75,  // pence per kWh
      "valid_from": "2023-12-01T16:00:00Z",
      "valid_to": "2023-12-01T16:30:00Z"
    }
  ]
}
```

## Monitoring & Logging

### Log Files
- Location: `logs/victron-agile-controller.log`
- Format: `[timestamp] [AGILE-CONTROLLER] [level] message`

### Key Log Messages
- Rate updates: `Current rates: Import 15.75p/kWh, Export 7.88p/kWh`
- Strategy decisions: `Strategy: cheap_rate_charging, Target setpoint: 3000W`
- Forecast analysis: `6h forecast: Cheapest 8.50p, Most expensive 28.30p`

### Database Events
Events are logged to `victron_tariff_events` table with event types:
- `negative_rate_charging`
- `cheap_rate_charging` 
- `expensive_rate_discharge`
- `self_consumption`

## Optimization Logic

### Decision Matrix

| Rate Condition | SOC Condition | Action | Setpoint | Strategy |
|----------------|---------------|--------|----------|----------|
| Negative (≤0p) | Any | Charge Max | +3000W | Aggressive charge |
| Cheap (≤10p) | <Target | Charge | +3000W | Opportunistic charge |
| Cheap (≤10p) | ≥Target | Maintain | 0W | Self-consumption |
| Expensive (≥25p) | >Min+10% | Discharge | -5000W | Export profit |
| Expensive (≥25p) | ≤Min+10% | Preserve | 0W | Safety preserve |
| Moderate | Variable | Optimize | Variable | Self-consumption |

### Self-Consumption Logic
1. **Solar Available + Battery Not Full**: Allow natural solar charging
2. **High Load + No Solar**: Use battery if economical vs forecast
3. **Forecast Cheaper Soon**: Preserve battery, import for immediate needs
4. **Default**: Zero setpoint for natural optimization

## Troubleshooting

### Common Issues

#### 1. **No Rate Data**
- Check internet connection
- Verify `AGILE_TARIFF_CODE` and `AGILE_REGION_CODE`
- Check Octopus API status

#### 2. **Controller Not Starting**
- Ensure Octopus Agile product is active in database
- Check database connection
- Verify MQTT broker connection

#### 3. **Unexpected Behavior**
- Check current SOC and rate thresholds
- Review recent log entries
- Verify configuration in `victron_grid_setpoints`

### Testing

#### Test Rate Fetching
```bash
# Run controller directly to see rate fetching
node src/victron.agile.controller.js
```

#### Test Product Switching
```sql
-- Check current active product
SELECT name, active FROM products;

-- Switch products
UPDATE products SET active = false;
UPDATE products SET active = true WHERE name = 'Octopus Agile';
```

## Performance

- **Rate Updates**: Every 60 minutes
- **Strategy Execution**: Every 5 minutes  
- **Memory Usage**: ~50MB typical
- **API Calls**: ~24 per day (hourly updates)
- **Database Queries**: ~288 per day (5-minute intervals)

## Future Enhancements

- [ ] Export rate optimization (currently assumes 50% of import rate)
- [ ] Machine learning for load prediction
- [ ] Integration with weather forecasts for solar prediction
- [ ] Multi-day optimization strategies
- [ ] Integration with other Octopus tariffs (Go, Intelligent)
