/**
 * Strategy Advisor
 *
 * Daily analysis that decides whether to charge batteries from the grid
 * during cheap (night) rate, or skip charging and rely on solar instead.
 *
 * Flow:
 *  1. Fetch tomorrow's solar forecast from VRM API
 *  2. Get current battery SOC + recent consumption/solar from DB
 *  3. Get Flux tariff rates from Octopus API
 *  4. Send all data to ChatGPT for analysis
 *  5. Save the decision to victron_strategy_decisions table
 *  6. Smart controller reads the decision during cheap rate periods
 *
 * Runs daily at 20:00 UK time (before cheap rate starts at 02:00).
 *
 * Usage:
 *   node src/victron.strategy.advisor.js          # run + schedule daily
 *   node src/victron.strategy.advisor.js --once   # run once and exit
 *
 * Env vars:
 *   VRM_TOKEN / VRM_EMAIL + VRM_PASSWORD  – VRM API auth
 *   VRM_SITE_ID                           – VRM installation id (auto-detected)
 *   LLM_PROVIDER                          – 'openai' (default) or 'gemini'
 *   OPENAI_API_KEY                        – OpenAI API key
 *   OPENAI_MODEL                          – model name (default: gpt-4o-mini)
 *   GEMINI_API_KEY                        – Google Gemini API key
 *   GEMINI_MODEL                          – model name (default: gemini-2.0-flash)
 *   BATTERY_CAPACITY_KWH                  – usable battery capacity (default: 10)
 */

const cron = require('node-cron');
const axios = require('axios');
const { Client } = require('pg');
const VRMAPI = require('./vrm-api');
const OctopusAPI = require('./octopus-api');
const { ReportLogger, sendReport } = require('./report-utils');
require('dotenv').config();

const DB_CONFIG = {
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'victron',
  password: process.env.DB_PASSWORD || 'password',
  port: process.env.DB_PORT || 5433,
};

const LLM_PROVIDER = (process.env.LLM_PROVIDER || 'openai').toLowerCase();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const BATTERY_CAPACITY_KWH = parseFloat(process.env.BATTERY_CAPACITY_KWH) || 10;

function timestamp() {
  return new Date().toLocaleString('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

// Global logger instance — replaced per analyzeAndDecide() call
let logger = new ReportLogger('ADVISOR');

function log(msg, level = 'INFO') {
  logger.log(msg, level);
}

// ─────────────────────────── Data Gathering ──────────────────────────

/**
 * Get the latest battery SOC from the database.
 */
async function getLatestSOC(db) {
  try {
    const result = await db.query(`
      SELECT value FROM victron_battery_data
      WHERE topic LIKE '%Soc'
      ORDER BY timestamp DESC LIMIT 1
    `);
    return result.rows.length > 0 ? parseFloat(result.rows[0].value) : null;
  } catch (e) {
    log(`Could not fetch SOC from DB: ${e.message}`, 'WARN');
    return null;
  }
}

/**
 * Get average daily consumption and solar from recent energy tracking.
 */
async function getRecentAverages(db, daysBack = 14) {
  try {
    const result = await db.query(`
      SELECT
        AVG(daily_consumption) AS avg_consumption,
        AVG(daily_solar) AS avg_solar,
        AVG(daily_import) AS avg_import,
        AVG(daily_export) AS avg_export,
        COUNT(*) AS days
      FROM (
        SELECT
          DATE(tracking_timestamp) AS d,
          SUM(load_consumption_kwh) AS daily_consumption,
          SUM(solar_generation_kwh) AS daily_solar,
          SUM(grid_import_kwh) AS daily_import,
          SUM(grid_export_kwh) AS daily_export
        FROM victron_energy_tracking
        WHERE tracking_timestamp >= NOW() - INTERVAL '${daysBack} days'
        GROUP BY DATE(tracking_timestamp)
      ) sub
    `);
    if (result.rows.length > 0 && result.rows[0].days > 0) {
      const r = result.rows[0];
      return {
        avgConsumption: parseFloat(r.avg_consumption) || 0,
        avgSolar: parseFloat(r.avg_solar) || 0,
        avgImport: parseFloat(r.avg_import) || 0,
        avgExport: parseFloat(r.avg_export) || 0,
        days: parseInt(r.days),
      };
    }
  } catch (e) {
    log(`Could not fetch averages from DB: ${e.message}`, 'WARN');
  }
  return null;
}

/**
 * Get actual historical performance from energy tracking.
 * This gives the AI REAL data about peak export, night costs, and system efficiency.
 */
async function getHistoricalPerformance(db, daysBack = 14) {
  try {
    const result = await db.query(`
      SELECT
        -- Peak period (16:00-19:00): actual export achievable
        AVG(CASE WHEN tariff_period = 'PEAK' THEN total_export_kwh END) AS avg_peak_export_kwh,
        AVG(CASE WHEN tariff_period = 'PEAK' THEN total_export_earnings_pence END) AS avg_peak_earnings_pence,
        MAX(CASE WHEN tariff_period = 'PEAK' THEN total_export_kwh END) AS max_peak_export_kwh,
        -- Night period (02:00-05:00): actual charge cost
        AVG(CASE WHEN tariff_period = 'Night' THEN total_import_kwh END) AS avg_night_import_kwh,
        AVG(CASE WHEN tariff_period = 'Night' THEN total_import_cost_pence END) AS avg_night_cost_pence,
        -- Net daily result
        AVG(total_net_cost_pence) AS avg_daily_net_cost_pence,
        COUNT(DISTINCT date) AS days
      FROM v_daily_energy_summary
      WHERE date >= CURRENT_DATE - INTERVAL '${daysBack} days'
    `);

    if (result.rows.length > 0 && result.rows[0].days > 0) {
      const r = result.rows[0];

      // Calculate round-trip efficiency: how much of night import becomes peak export
      const nightImport = parseFloat(r.avg_night_import_kwh) || 0;
      const peakExport = parseFloat(r.avg_peak_export_kwh) || 0;
      const efficiency = nightImport > 0 ? (peakExport / nightImport) * 100 : null;

      return {
        avgPeakExportKwh: parseFloat(r.avg_peak_export_kwh) || 0,
        avgPeakEarningsPence: parseFloat(r.avg_peak_earnings_pence) || 0,
        maxPeakExportKwh: parseFloat(r.max_peak_export_kwh) || 0,
        avgNightImportKwh: parseFloat(r.avg_night_import_kwh) || 0,
        avgNightCostPence: parseFloat(r.avg_night_cost_pence) || 0,
        avgDailyNetCostPence: parseFloat(r.avg_daily_net_cost_pence) || 0,
        systemEfficiency: efficiency ? Math.round(efficiency * 10) / 10 : null,
        days: parseInt(r.days),
      };
    }
  } catch (e) {
    log(`Could not fetch historical performance: ${e.message}`, 'WARN');
  }
  return null;
}

/**
 * Get current Flux rates from Octopus API.
 */
async function getFluxRates() {
  try {
    const api = new OctopusAPI();
    const tariffs = await api.getCurrentTariffs();
    if (!tariffs.importTariff) return null;

    const now = new Date();
    const start = new Date(now); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + 1);

    const importRates = api.createRateLookup(
      await api.getTariffRates(tariffs.importTariff, start.toISOString(), end.toISOString())
    );
    let exportRates = [];
    if (tariffs.exportTariff) {
      exportRates = api.createRateLookup(
        await api.getTariffRates(tariffs.exportTariff, start.toISOString(), end.toISOString())
      );
    }

    // Find min import (cheap/night) and max export (peak)
    const importValues = importRates.map(r => r.value_inc_vat);
    const exportValues = exportRates.map(r => r.value_inc_vat);

    return {
      cheapImport: Math.min(...importValues),
      standardImport: importValues.sort((a, b) => a - b)[Math.floor(importValues.length / 2)] || 0,
      peakImport: Math.max(...importValues),
      peakExport: exportValues.length > 0 ? Math.max(...exportValues) : 0,
      standardExport: exportValues.length > 0 ? exportValues.sort((a, b) => a - b)[Math.floor(exportValues.length / 2)] : 0,
    };
  } catch (e) {
    log(`Could not fetch Flux rates: ${e.message}`, 'WARN');
    return null;
  }
}

// ─────────────────────────── OpenAI Analysis ─────────────────────────

function buildPrompt(forecast, soc, averages, rates, batteryCapacity, history) {
  const tomorrowKwh = forecast?.tomorrowTotal || 0;
  const hourlyBreakdown = (forecast?.forecastSeries || [])
    .filter(p => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      return p.timestamp.toLocaleDateString('en-CA', { timeZone: 'Europe/London' }) ===
             tomorrow.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
    })
    .map(p => `  ${p.timestamp.toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' })}: ${p.kwh.toFixed(2)} kWh`)
    .join('\n');

  return `You are an energy strategy advisor for a UK home with solar panels, a ${batteryCapacity} kWh battery (Victron ESS with MultiPlus-II 15kVA), and Octopus Flux tariff.

CURRENT STATE:
- Battery SOC: ${soc !== null ? soc + '%' : 'unknown'}
- Battery usable capacity: ${batteryCapacity} kWh
- Date/time: ${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })}

SOLAR FORECAST FOR TOMORROW:
- Total expected: ${tomorrowKwh} kWh
${hourlyBreakdown ? 'Hourly breakdown:\n' + hourlyBreakdown : '(no hourly data)'}

RECENT AVERAGES (${averages?.days || 0} days):
- Daily consumption: ${averages?.avgConsumption?.toFixed(1) || 'unknown'} kWh
- Daily solar yield: ${averages?.avgSolar?.toFixed(1) || 'unknown'} kWh
- Daily grid import: ${averages?.avgImport?.toFixed(1) || 'unknown'} kWh
- Daily grid export: ${averages?.avgExport?.toFixed(1) || 'unknown'} kWh

ACTUAL HISTORICAL PERFORMANCE (${history?.days || 0} days) — USE THIS, NOT THEORETICAL MAXIMUMS:
- Avg peak export (16-19): ${history?.avgPeakExportKwh?.toFixed(1) || 'unknown'} kWh (max achieved: ${history?.maxPeakExportKwh?.toFixed(1) || 'unknown'} kWh)
- Avg peak earnings: ${history?.avgPeakEarningsPence?.toFixed(0) || 'unknown'}p (£${history?.avgPeakEarningsPence ? (history.avgPeakEarningsPence / 100).toFixed(2) : '?'})
- Avg night charge cost: ${history?.avgNightCostPence?.toFixed(0) || 'unknown'}p (£${history?.avgNightCostPence ? (history.avgNightCostPence / 100).toFixed(2) : '?'}) for ${history?.avgNightImportKwh?.toFixed(1) || '?'} kWh
- System round-trip efficiency: ${history?.systemEfficiency || 'unknown'}% (grid→battery→export losses)
- Avg daily net cost: ${history?.avgDailyNetCostPence?.toFixed(0) || 'unknown'}p

OCTOPUS FLUX RATES (inc VAT):
- Night import (02:00-05:00): ${rates?.cheapImport?.toFixed(2) || '?'}p/kWh  ← cheap grid charging window
- Day import (05:00-16:00): ${rates?.standardImport?.toFixed(2) || '?'}p/kWh
- Peak import (16:00-19:00): ${rates?.peakImport?.toFixed(2) || '?'}p/kWh
- Peak export (16:00-19:00): ${rates?.peakExport?.toFixed(2) || '?'}p/kWh  ← best export window
- Day/Evening export: ${rates?.standardExport?.toFixed(2) || '?'}p/kWh

IMPORTANT REAL-WORLD CONSTRAINTS:
- Peak export is only 3 hours (16:00-19:00) and the house has consumption during this time
- Actual peak export is typically ${history?.avgPeakExportKwh?.toFixed(0) || '10-11'} kWh, NOT the full battery capacity
- In hot weather, export drops further (~10 kWh) due to inverter derating
- There are significant system losses: charging from grid at night and exporting at peak loses ~${history?.systemEfficiency ? (100 - history.systemEfficiency).toFixed(0) : '15-25'}% of energy
- Night charging is only worthwhile if the profit (peak export earnings minus night charge cost) exceeds zero AFTER losses
- Solar charging is free, so even modest solar forecast may beat grid charging financially

STRATEGY OPTIONS:
1. "full_charge" – Charge battery to 100% from grid during cheap night rate. Best when solar forecast is very low AND night charge is profitable after losses.
2. "partial_charge" – Charge to a specific target SOC (e.g. 20-50%) to cover morning consumption until solar kicks in. Good compromise.
3. "skip_night_charge" – Don't charge from grid at all. Rely on solar tomorrow. Best when forecast is good — solar charges for free.

ANALYSIS REQUIRED:
- Use the ACTUAL historical performance data, not theoretical maximums
- Calculate: night charge cost (${history?.avgNightImportKwh?.toFixed(1) || '?'} kWh × ${rates?.cheapImport?.toFixed(2) || '?'}p) vs peak export earnings (${history?.avgPeakExportKwh?.toFixed(1) || '?'} kWh × ${rates?.peakExport?.toFixed(2) || '?'}p)
- Account for system round-trip efficiency loss of ${history?.systemEfficiency ? (100 - history.systemEfficiency).toFixed(0) : '~20'}%
- If solar forecast ≥ battery capacity, solar can fill the battery for FREE — far better than paying for night charge
- Consider morning consumption (05:00-09:00) before solar ramps up — partial charge can cover this gap
- Factor in weather uncertainty — forecast is not guaranteed, but recent trends help

Respond with ONLY valid JSON (no markdown, no code fences):
{
  "action": "skip_night_charge" | "partial_charge" | "full_charge",
  "target_soc": <number 0-100 or null>,
  "confidence": "high" | "medium" | "low",
  "reasoning": "<2-3 sentence explanation using actual historical data>"
}`;
}

/**
 * Call the configured LLM provider. Dispatches to OpenAI or Gemini.
 */
async function callLLM(prompt) {
  if (LLM_PROVIDER === 'gemini') {
    return callGemini(prompt);
  }
  return callOpenAI(prompt);
}

async function callOpenAI(prompt) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not set — add it to .env or switch LLM_PROVIDER=gemini');
  }

  const response = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: 'You are a precise energy strategy advisor. Always respond with valid JSON only.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.3,
    max_tokens: 300,
  }, {
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  const choice = response.data.choices[0];
  const usage = response.data.usage || {};

  return parseLLMResponse(choice.message.content, {
    model: OPENAI_MODEL,
    promptTokens: usage.prompt_tokens || 0,
    completionTokens: usage.completion_tokens || 0,
  });
}

async function callGemini(prompt) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not set — add it to .env or switch LLM_PROVIDER=openai');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const response = await axios.post(url, {
    contents: [{
      parts: [{
        text: 'You are a precise energy strategy advisor. Always respond with valid JSON only.\n\n' + prompt,
      }],
    }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 300,
      responseMimeType: 'application/json',
    },
  }, {
    headers: { 'Content-Type': 'application/json' },
  });

  const candidate = response.data.candidates?.[0];
  const text = candidate?.content?.parts?.[0]?.text || '';
  const usage = response.data.usageMetadata || {};

  return parseLLMResponse(text, {
    model: GEMINI_MODEL,
    promptTokens: usage.promptTokenCount || 0,
    completionTokens: usage.candidatesTokenCount || 0,
  });
}

/**
 * Parse and validate the JSON response from any LLM provider.
 */
function parseLLMResponse(rawText, meta) {
  let text = rawText.trim();
  // Strip markdown code fences if present
  text = text.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');

  let decision;
  try {
    decision = JSON.parse(text);
  } catch (e) {
    throw new Error(`Failed to parse LLM response as JSON: ${text}`);
  }

  if (!['skip_night_charge', 'partial_charge', 'full_charge'].includes(decision.action)) {
    throw new Error(`Invalid action: ${decision.action}`);
  }

  return {
    ...decision,
    model: meta.model,
    promptTokens: meta.promptTokens,
    completionTokens: meta.completionTokens,
  };
}

// ─────────────────────────── Main Logic ──────────────────────────────

async function analyzeAndDecide() {
  logger = new ReportLogger('ADVISOR');
  log('═══ Starting daily strategy analysis ═══');
  const db = new Client(DB_CONFIG);

  try {
    await db.connect();

    // 1. Solar forecast from VRM
    let forecast = null;
    try {
      const vrm = new VRMAPI();
      await vrm.login();
      forecast = await vrm.getSolarForecast();
      log(`Solar forecast: today=${forecast.todayTotal} kWh, tomorrow=${forecast.tomorrowTotal} kWh`);
    } catch (e) {
      log(`VRM solar forecast unavailable: ${e.message}`, 'WARN');
    }

    // 2. Current battery SOC
    const soc = await getLatestSOC(db);
    log(`Battery SOC: ${soc !== null ? soc + '%' : 'unknown'}`);

    // 3. Recent consumption/solar averages (from DB or VRM)
    let averages = await getRecentAverages(db);
    if (!averages) {
      // Fallback: try VRM historical data
      try {
        const vrm = new VRMAPI();
        await vrm.login();
        averages = await vrm.getDailyAverages(14);
        log(`VRM averages: solar=${averages.avgSolarYield} kWh, consumption=${averages.avgConsumption} kWh`);
      } catch (e) {
        log(`VRM history unavailable: ${e.message}`, 'WARN');
      }
    } else {
      log(`DB averages (${averages.days}d): consumption=${averages.avgConsumption.toFixed(1)} kWh, solar=${averages.avgSolar.toFixed(1)} kWh`);
    }

    // 4. Historical performance (actual peak export, night costs, efficiency)
    const history = await getHistoricalPerformance(db);
    if (history) {
      log(`Historical (${history.days}d): peak_export=${history.avgPeakExportKwh.toFixed(1)} kWh, night_cost=${(history.avgNightCostPence/100).toFixed(2)}, efficiency=${history.systemEfficiency}%`);
    }

    // 5. Current Flux rates
    const rates = await getFluxRates();
    if (rates) {
      log(`Rates: cheap=${rates.cheapImport.toFixed(1)}p, peak_export=${rates.peakExport.toFixed(1)}p`);
    }

    // 6. Build prompt and call LLM
    const prompt = buildPrompt(forecast, soc, averages, rates, BATTERY_CAPACITY_KWH, history);
    log(`Calling ${LLM_PROVIDER} (${LLM_PROVIDER === 'gemini' ? GEMINI_MODEL : OPENAI_MODEL}) for analysis...`);
    const decision = await callLLM(prompt);

    log(`Decision: ${decision.action}${decision.target_soc ? ' (target=' + decision.target_soc + '%)' : ''} [${decision.confidence}]`);
    log(`Reasoning: ${decision.reasoning}`);

    // 7. Save to database
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const decisionDate = tomorrow.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });

    await db.query(`
      INSERT INTO victron_strategy_decisions (
        decision_date, action, target_soc, confidence,
        solar_forecast_kwh, battery_soc, battery_capacity_kwh,
        avg_daily_consumption_kwh, avg_daily_solar_kwh,
        import_rate_cheap_pence, export_rate_peak_pence,
        avg_peak_export_kwh, avg_peak_earnings_pence,
        avg_night_import_kwh, avg_night_cost_pence, system_efficiency_pct,
        reasoning, model, prompt_tokens, completion_tokens
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      ON CONFLICT (decision_date) DO UPDATE SET
        action = EXCLUDED.action,
        target_soc = EXCLUDED.target_soc,
        confidence = EXCLUDED.confidence,
        solar_forecast_kwh = EXCLUDED.solar_forecast_kwh,
        battery_soc = EXCLUDED.battery_soc,
        battery_capacity_kwh = EXCLUDED.battery_capacity_kwh,
        avg_daily_consumption_kwh = EXCLUDED.avg_daily_consumption_kwh,
        avg_daily_solar_kwh = EXCLUDED.avg_daily_solar_kwh,
        import_rate_cheap_pence = EXCLUDED.import_rate_cheap_pence,
        export_rate_peak_pence = EXCLUDED.export_rate_peak_pence,
        avg_peak_export_kwh = EXCLUDED.avg_peak_export_kwh,
        avg_peak_earnings_pence = EXCLUDED.avg_peak_earnings_pence,
        avg_night_import_kwh = EXCLUDED.avg_night_import_kwh,
        avg_night_cost_pence = EXCLUDED.avg_night_cost_pence,
        system_efficiency_pct = EXCLUDED.system_efficiency_pct,
        reasoning = EXCLUDED.reasoning,
        model = EXCLUDED.model,
        prompt_tokens = EXCLUDED.prompt_tokens,
        completion_tokens = EXCLUDED.completion_tokens,
        created_at = NOW()
    `, [
      decisionDate,
      decision.action,
      decision.target_soc || null,
      decision.confidence || 'medium',
      forecast?.tomorrowTotal || null,
      soc,
      BATTERY_CAPACITY_KWH,
      averages?.avgConsumption || averages?.avgSolarYield || null,
      averages?.avgSolar || averages?.avgSolarYield || null,
      rates?.cheapImport || null,
      rates?.peakExport || null,
      history?.avgPeakExportKwh || null,
      history?.avgPeakEarningsPence || null,
      history?.avgNightImportKwh || null,
      history?.avgNightCostPence || null,
      history?.systemEfficiency || null,
      decision.reasoning,
      decision.model || OPENAI_MODEL,
      decision.promptTokens,
      decision.completionTokens,
    ]);

    // 8. Save hourly forecast to DB
    if (forecast?.forecastSeries?.length > 0) {
      // Delete existing forecast for this date, then insert fresh
      await db.query('DELETE FROM victron_solar_forecasts WHERE forecast_date = $1', [decisionDate]);
      for (const point of forecast.forecastSeries) {
        const pointDate = point.timestamp.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
        if (pointDate === decisionDate) {
          await db.query(
            'INSERT INTO victron_solar_forecasts (forecast_date, hour_timestamp, forecast_kwh) VALUES ($1, $2, $3)',
            [decisionDate, point.timestamp.toISOString(), point.kwh]
          );
        }
      }
      log(`Saved ${forecast.forecastSeries.length} hourly forecast points for ${decisionDate}`);
    }

    log(`Decision saved for ${decisionDate}`);
    log('═══ Strategy analysis complete ═══');

    // Save report to file and email
    const logPath = logger.saveToFile(decisionDate);
    const actionLabel = decision.action.replace(/_/g, ' ');
    await sendReport(
      `🔋 Strategy Advisor: ${actionLabel} for ${decisionDate} [${decision.confidence}]`,
      logger.getReport(),
      logPath
    );

    return decision;

  } catch (error) {
    log(`Analysis failed: ${error.message}`, 'ERROR');
    throw error;
  } finally {
    try { await db.end(); } catch (e) { /* ignore */ }
  }
}

// ─────────────────────────── Main ────────────────────────────────────

const runOnce = process.argv.includes('--once');

analyzeAndDecide()
  .then(decision => {
    log(`Result: ${decision.action} [${decision.confidence}]`);
    if (runOnce) {
      process.exit(0);
    }
    scheduleRuns();
  })
  .catch(err => {
    log(`Fatal: ${err.message}`, 'ERROR');
    if (runOnce) {
      process.exit(1);
    }
    scheduleRuns();
  });

function scheduleRuns() {
  // Primary: 20:00 UK — tomorrow's forecast is ready, plenty of time before cheap rate
  log('Scheduling daily analysis at 20:00 + 01:00 Europe/London');
  cron.schedule('0 20 * * *', () => {
    analyzeAndDecide().catch(err => log(`20:00 analysis error: ${err.message}`, 'ERROR'));
  }, { timezone: 'Europe/London' });

  // Final check: 01:00 UK — freshest forecast data, 1 hour before cheap rate starts
  cron.schedule('0 1 * * *', () => {
    analyzeAndDecide().catch(err => log(`01:00 analysis error: ${err.message}`, 'ERROR'));
  }, { timezone: 'Europe/London' });
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
