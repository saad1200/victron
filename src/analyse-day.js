/**
 * Daily Energy Report
 * Analyses a day's energy data from VRM API, calculates profitability,
 * logs to file, and emails the report.
 *
 * Usage:
 *   node src/analyse-day.js [YYYY-MM-DD]    # run once for a specific date
 *   node src/analyse-day.js                  # run once for today, then schedule daily
 *   node src/analyse-day.js --once           # run once for today and exit
 *
 * VRM kwh stats energy flow keys:
 *   Gb = Grid → Battery (night charging)
 *   Gc = Grid → Consumers (grid import for loads)
 *   Bg = Battery → Grid (battery export)
 *   Pg = PV → Grid (solar export)
 *   Pb = PV → Battery (solar charging battery)
 *   Pc = PV → Consumers (solar powering loads)
 *   Bc = Battery → Consumers (battery powering loads)
 */

const cron = require('node-cron');
const VRMAPI = require('./vrm-api');
const { Client } = require('pg');
const { ReportLogger, sendReport, toISODateUK } = require('./report-utils');
require('dotenv').config();

const BATTERY_CAPACITY_KWH = parseFloat(process.env.BATTERY_CAPACITY_KWH) || 43;

const DB_CONFIG = {
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'victron',
  password: process.env.DB_PASSWORD || 'password',
  port: process.env.DB_PORT || 5433,
};

/**
 * Load tariff rates from victron_tariff_periods table.
 * Falls back to Flux defaults if DB unavailable.
 */
async function loadTariffRates(logger) {
  const defaults = {
    Night:   { import: 16.61, export: 5.05 },
    Day:     { import: 27.68, export: 10.24 },
    PEAK:    { import: 38.75, export: 29.79 },
    Evening: { import: 27.68, export: 10.24 },
  };

  try {
    const db = new Client(DB_CONFIG);
    await db.connect();
    const result = await db.query(
      `SELECT period_name, import_rate_pence, export_rate_pence
       FROM victron_tariff_periods WHERE is_active = true`
    );
    await db.end();

    if (result.rows.length > 0) {
      const rates = {};
      for (const row of result.rows) {
        rates[row.period_name] = {
          import: parseFloat(row.import_rate_pence),
          export: parseFloat(row.export_rate_pence),
        };
      }
      logger.log('Tariff rates loaded from database');
      return rates;
    }
  } catch (e) {
    logger.log(`DB tariff load failed (${e.message}), using defaults`, 'WARN');
  }
  return defaults;
}

// ─── Helpers ───

function getHour(tsMs) {
  return parseInt(new Date(tsMs).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }));
}

function sumPeriod(series, fromHour, toHour) {
  if (!series || !Array.isArray(series)) return 0;
  return series.reduce((acc, [ts, val]) => {
    const h = getHour(ts);
    return (h >= fromHour && h < toHour) ? acc + (val || 0) : acc;
  }, 0);
}

function sumAll(series) {
  if (!series || !Array.isArray(series)) return 0;
  return series.reduce((acc, [, val]) => acc + (val || 0), 0);
}

function combineSeries(a, b) {
  if (!a && !b) return [];
  if (!a) return b;
  if (!b) return a;
  const map = new Map();
  for (const [ts, val] of a) map.set(ts, (map.get(ts) || 0) + (val || 0));
  for (const [ts, val] of b) map.set(ts, (map.get(ts) || 0) + (val || 0));
  return [...map.entries()].sort((a, b) => a[0] - b[0]);
}

function printHourly(logger, label, series, unit = 'kWh') {
  if (!series || !Array.isArray(series) || series.length === 0) {
    logger.plain(`  ${label}: no data`);
    return;
  }
  logger.plain(`\n  ${label}:`);
  for (const [tsMs, val] of series) {
    const time = new Date(tsMs).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
    const v = val || 0;
    const bar = '█'.repeat(Math.max(0, Math.round(v / 0.3)));
    logger.plain(`    ${time}: ${v.toFixed(2)} ${unit} ${bar}`);
  }
}

// ─── Main Analysis ───

async function analyse(targetDate) {
  const logger = new ReportLogger('DAILY-REPORT');

  const vrm = new VRMAPI();
  await vrm.login();
  await vrm.ensureSiteId();

  const RATES = await loadTariffRates(logger);

  logger.plain(`\n═══ VRM Energy Analysis: ${targetDate} ═══\n`);
  logger.plain('Tariff rates (p/kWh inc VAT):');
  for (const [period, r] of Object.entries(RATES)) {
    logger.plain(`  ${period}: import=${r.import}p, export=${r.export}p`);
  }

  const dayStart = new Date(`${targetDate}T00:00:00+01:00`);
  const dayEnd = new Date(`${targetDate}T23:59:59+01:00`);
  const start = Math.floor(dayStart.getTime() / 1000);
  const end = Math.floor(dayEnd.getTime() / 1000);

  logger.log('Fetching VRM data...');
  const kwh = await vrm.getStats('kwh', { start, end, interval: 'hours' });
  const venus = await vrm.getStats('venus', { start, end, interval: 'hours' });

  // Energy flow series (all in kWh)
  const Gb = kwh.Gb || [];  // Grid → Battery
  const Gc = kwh.Gc || [];  // Grid → Consumers
  const Bg = kwh.Bg || [];  // Battery → Grid
  const Pg = kwh.Pg || [];  // PV → Grid
  const Pb = kwh.Pb || [];  // PV → Battery
  const Pc = kwh.Pc || [];  // PV → Consumers
  const Bc = kwh.Bc || [];  // Battery → Consumers

  // Composite series
  const gridImport = combineSeries(Gb, Gc);
  const gridExport = combineSeries(Bg, Pg);
  const totalSolar = combineSeries(combineSeries(Pb, Pc), Pg);
  const totalConsumption = combineSeries(combineSeries(Gc, Bc), Pc);

  // Battery SOC series
  const soc = venus.bs || [];

  // ─── Battery SOC ───
  logger.plain('\n─── Battery SOC ───');
  let socAtMidnight = null;
  let socAt0500 = null;
  let socAt1600 = null;
  if (soc.length > 0) {
    logger.plain('\n  SOC:');
    for (const [tsMs, avg, min, max] of soc) {
      const time = new Date(tsMs).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
      const h = getHour(tsMs);
      const bar = '█'.repeat(Math.max(0, Math.round((avg || 0) / 2)));
      logger.plain(`    ${time}: ${(avg||0).toFixed(0)}% (${(min||0).toFixed(0)}-${(max||0).toFixed(0)}%) ${bar}`);
      if (h === 0) socAtMidnight = avg;
      if (h === 5) socAt0500 = avg;
      if (h === 16) socAt1600 = avg;
    }
  }

  logger.plain('\n─── Solar Generation (PV→Battery + PV→Consumers + PV→Grid) ───');
  printHourly(logger, 'Solar', totalSolar);
  logger.plain(`\n  TOTAL: ${sumAll(totalSolar).toFixed(2)} kWh`);

  logger.plain('\n─── Grid Import (Grid→Battery + Grid→Consumers) ───');
  printHourly(logger, 'Import', gridImport);

  logger.plain('\n─── Grid Export (Battery→Grid + PV→Grid) ───');
  printHourly(logger, 'Export', gridExport);

  logger.plain('\n─── Night Charging Detail (Grid→Battery) ───');
  printHourly(logger, 'Grid→Battery', Gb);

  // ─── Period totals ───
  const nightGridToBat = sumPeriod(Gb, 2, 5);
  const nightGridToCon = sumPeriod(Gc, 2, 5);
  const nightImportTotal = sumPeriod(gridImport, 2, 5);
  const nightExportTotal = sumPeriod(gridExport, 2, 5);

  const dayImportTotal = sumPeriod(gridImport, 5, 16);
  const dayExportTotal = sumPeriod(gridExport, 5, 16);
  const daySolarTotal = sumPeriod(totalSolar, 5, 16);

  const peakImportTotal = sumPeriod(gridImport, 16, 19);
  const peakExportTotal = sumPeriod(gridExport, 16, 19);
  const peakBatToGrid = sumPeriod(Bg, 16, 19);
  const peakPvToGrid = sumPeriod(Pg, 16, 19);
  const peakSolarTotal = sumPeriod(totalSolar, 16, 19);

  const eveningImportTotal = sumPeriod(gridImport, 19, 24) + sumPeriod(gridImport, 0, 2);
  const eveningExportTotal = sumPeriod(gridExport, 19, 24) + sumPeriod(gridExport, 0, 2);

  // Battery consumption during day (05:00-16:00) — what battery powered instead of grid
  const dayBatToCon = sumPeriod(Bc, 5, 16);

  const totalSolarKwh = sumAll(totalSolar);
  const totalConsKwh = sumAll(totalConsumption);

  // ─── Financials ───
  const nightCost = nightImportTotal * RATES.Night.import;
  const nightEarn = nightExportTotal * RATES.Night.export;
  const dayCost = dayImportTotal * RATES.Day.import;
  const dayEarn = dayExportTotal * RATES.Day.export;
  const peakCost = peakImportTotal * RATES.PEAK.import;
  const peakEarn = peakExportTotal * RATES.PEAK.export;
  const eveningCost = eveningImportTotal * (RATES.Evening || RATES.Day).import;
  const eveningEarn = eveningExportTotal * (RATES.Evening || RATES.Day).export;

  const totalCost = nightCost + dayCost + peakCost + eveningCost;
  const totalEarn = nightEarn + dayEarn + peakEarn + eveningEarn;
  const netCost = totalCost - totalEarn;

  logger.plain('\n═══ PERIOD BREAKDOWN ═══');

  logger.plain(`\nNIGHT (02:00-05:00) — ${RATES.Night.import}p import / ${RATES.Night.export}p export:`);
  logger.plain(`  Grid→Battery: ${nightGridToBat.toFixed(2)} kWh (charging)`);
  logger.plain(`  Grid→Consumers: ${nightGridToCon.toFixed(2)} kWh (house load)`);
  logger.plain(`  Import total: ${nightImportTotal.toFixed(2)} kWh = £${(nightCost/100).toFixed(2)}`);
  logger.plain(`  Export total: ${nightExportTotal.toFixed(2)} kWh = £${(nightEarn/100).toFixed(2)}`);
  logger.plain(`  Net: £${((nightCost - nightEarn)/100).toFixed(2)} COST`);

  logger.plain(`\nDAY (05:00-16:00) — ${RATES.Day.import}p import / ${RATES.Day.export}p export:`);
  logger.plain(`  Solar: ${daySolarTotal.toFixed(2)} kWh`);
  logger.plain(`  Battery→Consumers: ${dayBatToCon.toFixed(2)} kWh (night charge powering house)`);
  logger.plain(`  Import: ${dayImportTotal.toFixed(2)} kWh = £${(dayCost/100).toFixed(2)}`);
  logger.plain(`  Export: ${dayExportTotal.toFixed(2)} kWh = £${(dayEarn/100).toFixed(2)}`);
  logger.plain(`  Net: £${((dayCost - dayEarn)/100).toFixed(2)} ${dayEarn > dayCost ? 'EARNED' : 'COST'}`);

  logger.plain(`\nPEAK (16:00-19:00) — ${RATES.PEAK.import}p import / ${RATES.PEAK.export}p export:`);
  logger.plain(`  Solar: ${peakSolarTotal.toFixed(2)} kWh`);
  logger.plain(`  Battery→Grid: ${peakBatToGrid.toFixed(2)} kWh`);
  logger.plain(`  PV→Grid: ${peakPvToGrid.toFixed(2)} kWh`);
  logger.plain(`  Import: ${peakImportTotal.toFixed(2)} kWh = £${(peakCost/100).toFixed(2)}`);
  logger.plain(`  Export: ${peakExportTotal.toFixed(2)} kWh = £${(peakEarn/100).toFixed(2)}`);
  logger.plain(`  Net: £${((peakCost - peakEarn)/100).toFixed(2)} ${peakEarn > peakCost ? 'EARNED' : 'COST'}`);

  logger.plain(`\nEVENING (19:00-02:00) — ${(RATES.Evening || RATES.Day).import}p import / ${(RATES.Evening || RATES.Day).export}p export:`);
  logger.plain(`  Import: ${eveningImportTotal.toFixed(2)} kWh = £${(eveningCost/100).toFixed(2)}`);
  logger.plain(`  Export: ${eveningExportTotal.toFixed(2)} kWh = £${(eveningEarn/100).toFixed(2)}`);
  logger.plain(`  Net: £${((eveningCost - eveningEarn)/100).toFixed(2)} ${eveningEarn > eveningCost ? 'EARNED' : 'COST'}`);

  // ─── Night charge profitability ───
  logger.plain('\n═══ NIGHT CHARGE PROFITABILITY ═══\n');

  const chargeCostBattery = nightGridToBat * RATES.Night.import;
  const chargeCostTotal = nightImportTotal * RATES.Night.import;
  const peakExportEarnGross = peakExportTotal * RATES.PEAK.export;
  const peakBatEarn = peakBatToGrid * RATES.PEAK.export;
  const peakPvEarn = peakPvToGrid * RATES.PEAK.export;
  const efficiency = nightGridToBat > 0 ? (peakBatToGrid / nightGridToBat * 100) : 0;

  const trueNetProfit = peakExportEarnGross - chargeCostTotal;
  const batOnlyProfit = peakBatEarn - chargeCostBattery;

  logger.plain(`Night import cost:     £${(chargeCostTotal/100).toFixed(2)} (${nightImportTotal.toFixed(1)} kWh total @ ${RATES.Night.import}p)`);
  logger.plain(`  ├─ battery charge:   £${(chargeCostBattery/100).toFixed(2)} (${nightGridToBat.toFixed(1)} kWh)`);
  logger.plain(`  └─ house load:       £${((chargeCostTotal - chargeCostBattery)/100).toFixed(2)} (${nightGridToCon.toFixed(1)} kWh)`);
  logger.plain('');
  logger.plain(`Peak export gross:     £${(peakExportEarnGross/100).toFixed(2)} (${peakExportTotal.toFixed(1)} kWh @ ${RATES.PEAK.export}p)`);
  logger.plain(`  ├─ from battery:     £${(peakBatEarn/100).toFixed(2)} (${peakBatToGrid.toFixed(1)} kWh)`);
  logger.plain(`  └─ from solar:       £${(peakPvEarn/100).toFixed(2)} (${peakPvToGrid.toFixed(1)} kWh)`);
  logger.plain('');
  logger.plain(`Round-trip efficiency:  ${efficiency.toFixed(1)}% (${nightGridToBat.toFixed(1)} kWh in → ${peakBatToGrid.toFixed(1)} kWh out)`);
  logger.plain('');
  logger.plain(`TRUE NET PROFIT:       £${(trueNetProfit/100).toFixed(2)} (peak £${(peakExportEarnGross/100).toFixed(2)} - night £${(chargeCostTotal/100).toFixed(2)}) ${trueNetProfit > 0 ? '✓ PROFIT' : '✗ LOSS'}`);
  logger.plain(`  Battery-only profit: £${(batOnlyProfit/100).toFixed(2)} (bat export £${(peakBatEarn/100).toFixed(2)} - bat charge £${(chargeCostBattery/100).toFixed(2)})`);

  // ─── Day total ───
  logger.plain('\n═══ DAY TOTAL ═══\n');
  logger.plain(`Total solar:           ${totalSolarKwh.toFixed(2)} kWh`);
  logger.plain(`Total consumption:     ${totalConsKwh.toFixed(2)} kWh`);
  logger.plain(`Total import cost:     £${(totalCost/100).toFixed(2)}`);
  logger.plain(`Total export earned:   £${(totalEarn/100).toFixed(2)}`);
  logger.plain(`Net result:            £${(Math.abs(netCost)/100).toFixed(2)} ${netCost > 0 ? 'COST (you paid)' : 'EARNED (you made money)'}`);

  // ─── What-if: skip night charge (battery-state aware) ───
  logger.plain('\n═══ WHAT-IF: SKIPPED NIGHT CHARGE ═══\n');

  const startSOC = socAtMidnight || 20;
  const startBatKwh = (startSOC / 100) * BATTERY_CAPACITY_KWH;

  logger.plain(`Battery at midnight:        ${startSOC.toFixed(0)}% (${startBatKwh.toFixed(1)} kWh)`);
  logger.plain(`Battery at 05:00 (actual):  ${socAt0500 ? socAt0500.toFixed(0) + '%' : 'unknown'}`);
  logger.plain(`Battery at 16:00 (actual):  ${socAt1600 ? socAt1600.toFixed(0) + '%' : 'unknown'}`);

  // Without night charge, battery stays at midnight SOC (~20%).
  // Morning consumption (05:00-09:00) that was covered by battery would instead come from grid at day rate.
  const morningBatToCon = sumPeriod(Bc, 5, 10); // battery powered house 05:00-10:00
  const morningGridCost = morningBatToCon * RATES.Day.import; // would have to buy from grid instead

  logger.plain(`\nMorning (05-10) bat→house:  ${morningBatToCon.toFixed(1)} kWh (powered by night charge)`);
  logger.plain(`Without night charge, this comes from grid @ ${RATES.Day.import}p = £${(morningGridCost/100).toFixed(2)} extra cost`);

  // Solar surplus after consumption — but need to subtract morning deficit
  const solarSurplus = totalSolarKwh - totalConsKwh;
  // Solar available to charge battery (only during daylight, not all solar — some powers house)
  const solarToBatActual = sumAll(Pb);

  logger.plain(`\nTotal solar:                ${totalSolarKwh.toFixed(1)} kWh`);
  logger.plain(`Total consumption:          ${totalConsKwh.toFixed(1)} kWh`);
  logger.plain(`Solar surplus:              ${solarSurplus.toFixed(1)} kWh`);
  logger.plain(`Solar→Battery (actual):     ${solarToBatActual.toFixed(1)} kWh`);

  if (solarSurplus > 0) {
    // How much could solar charge battery if we started empty?
    // Battery would start at ~startSOC, and solar charges during the day
    // But morning consumption has to come from grid (no battery) or solar
    const solarForBat = Math.min(solarSurplus, BATTERY_CAPACITY_KWH - startBatKwh);
    const solarBatAtPeak = startBatKwh + solarForBat;
    const potentialPeakExport = Math.min(solarBatAtPeak, peakBatToGrid); // limited by inverter/time
    const potentialPeakEarn = potentialPeakExport * RATES.PEAK.export;
    const solarPeakExportEarn = peakPvToGrid * RATES.PEAK.export;

    logger.plain(`\nBattery at peak (solar-only): ~${(solarBatAtPeak/BATTERY_CAPACITY_KWH*100).toFixed(0)}% (${solarBatAtPeak.toFixed(1)} kWh)`);
    logger.plain(`Potential peak bat export:    ${potentialPeakExport.toFixed(1)} kWh = £${(potentialPeakEarn/100).toFixed(2)}`);
    logger.plain(`Solar direct peak export:     ${peakPvToGrid.toFixed(1)} kWh = £${(solarPeakExportEarn/100).toFixed(2)}`);

    // Night charge approach: paid for night, earned from peak, battery covered morning
    const actualNet = peakExportEarnGross - chargeCostTotal;
    // Solar approach: no night cost, but morning grid cost + less peak export
    const solarNet = (potentialPeakEarn + solarPeakExportEarn) - morningGridCost;
    const diff = solarNet - actualNet;

    logger.plain('');
    logger.plain(`  Actual (night charge):   £${(actualNet/100).toFixed(2)} net`);
    logger.plain(`    peak export £${(peakExportEarnGross/100).toFixed(2)} - night import £${(chargeCostTotal/100).toFixed(2)}`);
    logger.plain(`  Solar-only (no charge):  £${(solarNet/100).toFixed(2)} net`);
    logger.plain(`    peak export £${((potentialPeakEarn + solarPeakExportEarn)/100).toFixed(2)} - morning grid £${(morningGridCost/100).toFixed(2)}`);
    logger.plain(`  Difference:              £${(Math.abs(diff)/100).toFixed(2)} ${diff > 0 ? '← SOLAR-ONLY BETTER' : '← NIGHT CHARGE BETTER'}`);
  } else {
    logger.plain(`\nSolar didn't cover consumption — night charge was necessary.`);
    logger.plain(`Without night charge: morning grid cost £${(morningGridCost/100).toFixed(2)} + no peak export`);
    logger.plain(`Night charge clearly the right call.`);
  }

  // ─── Save and email ───
  const logPath = logger.saveToFile(targetDate);
  await sendReport(
    `⚡ Solar Daily Report: ${targetDate} — ${netCost > 0 ? 'Cost £' + (netCost/100).toFixed(2) : 'Earned £' + (Math.abs(netCost)/100).toFixed(2)}`,
    logger.getReport(),
    logPath
  );

  return { netCost, trueNetProfit, totalSolarKwh, totalConsKwh };
}

// ─── Scheduling ───

const runOnce = process.argv.includes('--once');
const explicitDate = process.argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));

// If a date is provided, analyse that date and exit
if (explicitDate) {
  analyse(explicitDate)
    .then(() => process.exit(0))
    .catch(err => { console.error('Error:', err.message); process.exit(1); });
} else {
  // Analyse today
  const today = toISODateUK();
  analyse(today)
    .then(() => {
      if (runOnce) process.exit(0);
      // Schedule daily at 23:30 UK time
      console.log('Scheduling daily report at 23:30 Europe/London');
      cron.schedule('30 23 * * *', () => {
        const d = toISODateUK();
        analyse(d).catch(err => console.error(`Scheduled report error: ${err.message}`));
      }, { timezone: 'Europe/London' });
    })
    .catch(err => {
      console.error('Error:', err.message);
      if (runOnce) process.exit(1);
      console.log('Scheduling daily report at 23:30 despite first run failure');
      cron.schedule('30 23 * * *', () => {
        const d = toISODateUK();
        analyse(d).catch(e => console.error(`Scheduled report error: ${e.message}`));
      }, { timezone: 'Europe/London' });
    });
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
