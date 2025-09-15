# Solar Energy Dashboard

A comprehensive web dashboard for monitoring your Victron solar energy system with Octopus Flux tariff optimization.

## Features

### 📊 Real-time Monitoring
- **Energy Flow Visualization**: Track solar generation, grid import/export, and battery performance
- **Financial Analysis**: Monitor costs, earnings, and profit/loss in real-time
- **Battery Performance**: SOC tracking and charge/discharge patterns
- **Tariff Period Breakdown**: Analyze performance across different rate periods

### 💰 Financial Insights
- **Import Costs**: Track electricity import expenses by period
- **Export Earnings**: Monitor solar export revenue
- **Net Profit/Loss**: Calculate overall financial performance
- **Period Comparison**: Compare performance between different date ranges

### 🔍 Advanced Analytics
- **Date Range Filtering**: Analyze data for any time period
- **Multiple View Modes**: Daily, hourly, or tariff period aggregation
- **Battery Efficiency**: Calculate round-trip efficiency metrics
- **Self-Consumption**: Track solar energy usage vs export

## Setup Instructions

### 1. Database Setup
First, ensure your database schema is up to date:

```bash
# Apply the latest schema with inverter mode support
psql -d victron -f db/flux-tariff-schema.sql
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Environment Configuration
Create a `.env` file with your database credentials:

```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=victron
DB_USER=postgres
DB_PASSWORD=your_password
DASHBOARD_PORT=3001
```

### 4. Start the Dashboard Server
```bash
# Start the dashboard API server
npm run dashboard
```

### 5. Access the Dashboard
Open your browser and navigate to:
```
http://localhost:3001
```

## Dashboard Components

### Summary Cards
- **Total Energy Import/Export**: kWh consumed and generated
- **Solar Generation**: Total solar energy produced
- **Financial Performance**: Import costs, export earnings, net profit
- **Battery Metrics**: Efficiency and self-consumption rates

### Charts
1. **Energy Flow Over Time**: Line chart showing import, export, solar, and load
2. **Financial Performance**: Bar chart of daily costs and earnings
3. **Battery Performance**: Dual-axis chart with SOC and power
4. **Tariff Period Breakdown**: Doughnut chart showing profit by period

### Filtering Options
- **Date Range**: Select start and end dates
- **Period Aggregation**: View by day, hour, or tariff period
- **Comparison Mode**: Compare two different time periods

## API Endpoints

### GET /api/dashboard-data
Retrieve dashboard data for a specific date range.

**Parameters:**
- `start`: Start date (YYYY-MM-DD)
- `end`: End date (YYYY-MM-DD)
- `period`: Aggregation period (`day`, `hour`, `tariff`)

**Response:**
```json
{
  "summary": {
    "totalImport": 45.2,
    "totalExport": 38.7,
    "totalSolar": 52.1,
    "importCost": 1234.56,
    "exportEarnings": 987.65,
    "batteryEfficiency": 85.2,
    "selfConsumption": 74.3
  },
  "timeSeries": [...],
  "financial": [...],
  "battery": [...],
  "tariffBreakdown": {...}
}
```

### GET /api/health
Health check endpoint.

## Data Sources

The dashboard pulls data from these database tables:
- `victron_energy_tracking`: Energy import/export and financial data
- `victron_battery_data`: Battery SOC and power data
- `victron_grid_setpoints`: Tariff period configurations
- `victron_tariff_periods`: Rate information

## Currency Conversion

Financial data is stored in pence and automatically converted to dollars for display:
- Database: Values stored in pence (e.g., 1234 pence)
- Dashboard: Displayed in dollars (e.g., $12.34)

## Troubleshooting

### Dashboard Not Loading
1. Check that the dashboard server is running on port 3001
2. Verify database connection in the console logs
3. Ensure the database schema is up to date

### No Data Showing
1. Verify that the energy tracking system is collecting data
2. Check the date range - ensure it includes periods with data
3. Look for errors in the browser console

### Performance Issues
1. Limit the date range for large datasets
2. Use daily aggregation instead of hourly for long periods
3. Consider adding database indexes for frequently queried columns

## Development

### Adding New Metrics
1. Update the database query in `dashboard-api.js`
2. Add the metric to the summary calculation
3. Update the frontend display in `dashboard.js`

### Customizing Charts
Charts use Chart.js library. Modify the chart configurations in `dashboard.js` to customize:
- Colors and styling
- Chart types
- Data formatting
- Tooltips and legends

## Security Notes

- The dashboard is intended for local network use
- No authentication is implemented by default
- Database credentials should be secured
- Consider adding HTTPS for production deployments
