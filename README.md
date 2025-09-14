# Victron Solar System Controller & Data Logger

This project contains a smart charging controller and data logger for Victron energy systems with Octopus Flux tariff optimization.

## Components

### 1. Core Controller (`core.js`)
Smart charging controller that optimizes battery charging/discharging based on:
- Solar generation forecasts
- Octopus Flux tariff periods
- Battery state of charge
- Grid export limits

### 2. Web Server (`server.js`)
Simple web interface to view system logs at `http://localhost:3000`

### 3. Data Logger (`victron-data-logger.js`)
MQTT data logger that captures Victron metrics and stores them in PostgreSQL with timestamps.

## Setup

### Prerequisites
- Node.js (v16 or higher)
- PostgreSQL database
- Access to Victron system via MQTT

### Installation

1. Install dependencies:
```bash
npm install
```

2. Configure environment variables in `.env`:
```bash
# MQTT Configuration
MQTT_BROKER=mqtt://192.168.9.226
DEVICE_ID=c0619ab786e2

# Database Configuration
DB_HOST=localhost
DB_PORT=5433
DB_NAME=victron
DB_USER=postgres
DB_PASSWORD=your_password_here

# Octopus Energy API (optional)
OCTOPUS_API_KEY=your_api_key_here
```

3. Create PostgreSQL database:
```sql
CREATE DATABASE victron;
```

4. Set up database schema (choose one method):

**Option A: Manual SQL execution (recommended):**
```bash
psql -d victron -f victron-schema.sql
```

**Option B: Using Node.js script:**
```bash
npm run setup.db
```

## Usage

### Start the Smart Controller
```bash
npm run start.script
```

### Start the Web Server
```bash
npm run start.server
```

### Start the Data Logger
```bash
npm run start.logger
```

## Data Logger Features

The data logger captures the following metrics from your Victron system:

### Battery Metrics
- State of Charge (SOC) %
- Voltage (V)
- Current (A)
- Power (W)

### Solar PV Metrics
- Power generation (W)
- Voltage (V)
- Current (A)

### Grid Metrics
- Power consumption/export per phase (W)
- Grid voltage (V)
- Grid frequency (Hz)

### Inverter Metrics
- Output power (W)
- Output voltage (V)
- Output current (A)

### System Metrics
- System state
- ESS mode

## Database Schema

The logger creates the following tables:

- `victron_metrics` - All individual metrics with timestamps
- `victron_battery_data` - Structured battery data
- `victron_pv_data` - Structured solar PV data
- `victron_grid_data` - Structured grid data
- `victron_inverter_data` - Structured inverter data

## Monitoring

- Logs are written to `victron-flux.log` (controller) and `victron-data-logger.log` (data logger)
- Web interface available at `http://localhost:3000` for real-time log viewing
- Database metrics can be queried directly from PostgreSQL

## Configuration

### MQTT Topics Monitored
The data logger subscribes to all relevant Victron MQTT topics including:
- Battery metrics: `/battery/0/Dc/0/*`
- PV metrics: `/system/0/Dc/Pv/*`
- Grid metrics: `/system/0/Ac/Consumption/*`
- Inverter metrics: `/vebus/0/Ac/Out/*`
- System state: `/system/0/SystemState/State`

### Data Insertion Strategy
- Individual metrics are inserted immediately upon receipt
- Structured data (battery, PV, grid, inverter) is batched and inserted every 30 seconds
- All timestamps are stored in UTC with timezone information

## Troubleshooting

1. **MQTT Connection Issues**: Verify MQTT broker address and network connectivity
2. **Database Connection Issues**: Check PostgreSQL service status and credentials
3. **Missing Data**: Verify MQTT topics match your Victron system configuration
4. **Performance**: Monitor database size and consider data retention policies

## Security Notes

- Store database credentials securely in `.env` file
- Consider using connection pooling for high-frequency data logging
- Implement proper backup strategies for historical data
