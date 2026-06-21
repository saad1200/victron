/**
 * Strategy Advisor
 *
 * Daily analysis that decides whether to charge batteries from the grid
 * during cheap (night) rate, or skip charging and rely on solar instead.
 */

const cron = require('node-cron');
const axios = require('axios');
const { Pool } = require('pg');
const VRMAPI = require('./vrm-api');
const OctopusAPI = require('./octopus-api');
const { ReportLogger, sendReport, toISODateUK } = require('./report-utils');
require('dotenv').config();

const DB_CONFIG = {
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'victron',
  password: process.env.DB_PASSWORD || 'password',
  port: process.env.DB_PORT || 5433,
};

const pool = new Pool({ ...DB_CONFIG, max: 2 });
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

let logger = new ReportLogger('ADVISOR');

function log(msg, level = 'INFO') {
  logger.log(msg, level);
}

// ─────────────────────────── Data Gathering ──────────────────────────

async function getLatestSOC(db) {
  try {
    const result = await db.query(`
      SELECT soc FROM victron_battery_data
      WHERE soc IS NOT NULL
      ORDER BY timestamp DESC LIMIT 1
    `);
    return result.rows.length > 0 ? parseFloat(result.rows[0].soc) : null;
  } catch (e) {
    log(`Could not fetch SOC from DB: ${e.message}`, 'WARN');
    return null;
  }
}

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

async function getHistoricalPerformance(db, daysBack = 14) {
  try {
    const result = await db.query(`
      SELECT
        AVG(CASE WHEN tariff_period = 'PEAK' THEN total_export_kwh END) AS avg_peak_export_kwh,
        AVG(CASE WHEN tariff_period = 'PEAK' THEN total_export_earnings_pence END) AS avg_peak_earnings_pence,
        MAX(CASE WHEN tariff_period = 'PEAK' THEN total_export_kwh END) AS max_peak_export_kwh,
        AVG(CASE WHEN tariff_period = 'Night' THEN total_import_kwh END) AS avg_night_import_kwh,
        AVG(CASE WHEN tariff_period = 'Night' THEN total_import_cost_pence END) AS avg_night_cost_pence,
        AVG(total_net_cost_pence) AS avg_daily_net_cost_pence,
        COUNT(DISTINCT date) AS days
      FROM v_daily_energy_summary
      WHERE date >= CURRENT_DATE - INTERVAL '${daysBack} days'
    `);

    if (result.rows.length > 0 && result.rows[0].days > 0) {
      const r = result.rows[0];
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

// ─────────────────────────── LLM Processing Engine ─────────────────────────

function buildPrompt(forecast, soc, averages, rates, batteryCapacity, history) {
  const tomorrowKwh = forecast?.tomorrowTotal || 0;
  const hourlyBreakdown = (forecast?.forecastSeries || [])
    .filter(p => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      return toISODateUK(p.timestamp) === toISODateUK(tomorrow);
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

STRATEGY OPTIONS:
1. "full_charge" – Charge battery to 100% from grid during cheap night rate.
2. "partial_charge" – Charge to a specific target SOC (e.g. 20-50%).
3. "skip_night_charge" – Don't charge from grid at all. Rely on solar tomorrow.

Respond with ONLY valid JSON:
{
  "action": "skip_night_charge" | "partial_charge" | "full_charge",
  "target_soc": <number 0-100 or null>,
  "confidence": "high" | "medium" | "low",
  "reasoning": "<2-3 sentence explanation using actual historical data>"
}`;
}

// ─────────────────────────── Local Rule-Based Provider ───────────────
//
// Decision thresholds (assuming avgConsumption=17 kWh, peakNeed=12 kWh):
//
//  Forecast  Surplus  Decision
//  ────────  ───────  ──────────────────────────────────
//  48 kWh    31 kWh   skip_night_charge  (surplus ≥ 12)
//  29 kWh    12 kWh   skip_night_charge  (surplus ≥ 12)
//  24 kWh     7 kWh   partial_charge     (surplus ≥ 3.6)
//  21 kWh     4 kWh   partial_charge     (surplus ≥ 3.6)
//  20 kWh     3 kWh   full_charge        (surplus < 3.6)
//   5 kWh     0 kWh   full_charge        (surplus < 3.6)
//
// peakNeed = total inverter output during peak (default 12 kWh, includes export + house load)
// surplus  = max(0, forecast - avgConsumption)
// skip:      surplus >= peakNeed
// partial:   surplus >= peakNeed * 0.3
// full:      otherwise

function localDecision(forecast, soc, averages, rates, batteryCapacity, history) {
  const tomorrowKwh = forecast?.tomorrowTotal || 0;
  const avgConsumption = averages?.avgConsumption || 17;   // fallback 17 kWh/day if no data (typical 15-20 range)
  const cheapRate = rates?.cheapImport || 15.5;
  const peakExportRate = rates?.peakExport || 29.8;

  // Total inverter output during peak (export + house load combined, ~4kW × 3h)
  const peakTotalKwh = history?.avgPeakExportKwh || 12;
  const energyNeededForPeak = peakTotalKwh;

  // Solar surplus available to charge battery (after covering daytime consumption)
  const solarSurplus = Math.max(0, tomorrowKwh - avgConsumption);

  const meta = { model: 'local-rules', promptTokens: 0, completionTokens: 0 };

  // Abundant solar — surplus covers peak export needs comfortably
  if (solarSurplus >= energyNeededForPeak) {
    return {
      ...meta,
      action: 'skip_night_charge',
      target_soc: null,
      confidence: solarSurplus >= energyNeededForPeak * 1.3 ? 'high' : 'medium',
      reasoning: `[LOCAL] Solar forecast ${tomorrowKwh.toFixed(1)} kWh with ${solarSurplus.toFixed(1)} kWh surplus after ${avgConsumption.toFixed(1)} kWh consumption — covers ${energyNeededForPeak.toFixed(1)} kWh needed for peak (inverter output: export + house load).`,
    };
  }

  // Moderate solar — partial charge to supplement what solar can't cover
  if (solarSurplus >= energyNeededForPeak * 0.3) {
    const gridTopUpKwh = energyNeededForPeak - solarSurplus;
    const targetSoc = Math.min(50, Math.max(20, Math.round((gridTopUpKwh / batteryCapacity) * 100) + 20));
    return {
      ...meta,
      action: 'partial_charge',
      target_soc: targetSoc,
      confidence: 'medium',
      reasoning: `[LOCAL] Solar forecast ${tomorrowKwh.toFixed(1)} kWh with ${solarSurplus.toFixed(1)} kWh surplus — covers ${Math.round(solarSurplus / energyNeededForPeak * 100)}% of ${energyNeededForPeak.toFixed(1)} kWh peak need. Charging to ${targetSoc}% to top up remaining ${gridTopUpKwh.toFixed(1)} kWh from grid at ${cheapRate.toFixed(1)}p.`,
    };
  }

  // Low/no solar — full charge for peak export arbitrage
  return {
    ...meta,
    action: 'full_charge',
    target_soc: 100,
    confidence: solarSurplus < 2 ? 'high' : 'medium',
    reasoning: `[LOCAL] Solar forecast ${tomorrowKwh.toFixed(1)} kWh insufficient (surplus ${solarSurplus.toFixed(1)} kWh after ${avgConsumption.toFixed(1)} kWh consumption vs ${energyNeededForPeak.toFixed(1)} kWh peak need). Full charge at ${cheapRate.toFixed(1)}p to export at ${peakExportRate.toFixed(1)}p during peak.`,
  };
}

// ─────────────────────────── Provider Dispatcher ─────────────────────

async function callProvider(forecast, soc, averages, rates, batteryCapacity, history) {
  // Local provider — no API calls needed
  if (LLM_PROVIDER === 'local') {
    log('Using local rule-based provider (no LLM)');
    return localDecision(forecast, soc, averages, rates, batteryCapacity, history);
  }

  // LLM provider with fallback chain: primary → fallback LLM → local rules
  const prompt = buildPrompt(forecast, soc, averages, rates, batteryCapacity, history);
  const primary = LLM_PROVIDER === 'gemini' ? callGemini : callOpenAI;
  const fallback = LLM_PROVIDER === 'gemini' ? callOpenAI : callGemini;
  const fallbackName = LLM_PROVIDER === 'gemini' ? 'openai' : 'gemini';
  const fallbackKey = LLM_PROVIDER === 'gemini' ? OPENAI_API_KEY : GEMINI_API_KEY;

  // Try primary LLM
  try {
    log(`Calling ${LLM_PROVIDER} (primary)...`);
    return await primary(prompt);
  } catch (err) {
    log(`Primary ${LLM_PROVIDER} failed: ${err.response?.status || err.message}`, 'WARN');
  }

  // Try fallback LLM
  if (fallbackKey) {
    try {
      log(`Calling ${fallbackName} (fallback)...`);
      return await fallback(prompt);
    } catch (err) {
      log(`Fallback ${fallbackName} failed: ${err.response?.status || err.message}`, 'WARN');
    }
  }

  // All LLMs failed — use local rules
  log('All LLM providers failed — falling back to local rule-based decision', 'WARN');
  return localDecision(forecast, soc, averages, rates, batteryCapacity, history);
}

async function callOpenAI(prompt) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set.');

  const response = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: 'You are a precise energy strategy advisor. Always respond with valid JSON only.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.3,
    max_tokens: 300,
  }, {
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
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
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set.');

  const systemPrompt = 'You are a precise energy strategy advisor. Always respond with valid JSON only.';
  const generationConfig = { temperature: 0.3, maxOutputTokens: 300, responseMimeType: 'application/json' };
  const headers = { 'Content-Type': 'application/json' };

  // Prioritize the production v1 endpoint over unstable v1beta models
  const attempts = [
    { api: 'v1', body: {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig,
    }},
    { api: 'v1beta', body: {
      contents: [{ role: 'user', parts: [{ text: systemPrompt + '\n\n' + prompt }] }],
      generationConfig,
    }},
  ];

  let lastErr;
  for (const { api, body } of attempts) {
    try {
      const url = `https://generativelanguage.googleapis.com/${api}/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
      const response = await axios.post(url, body, { headers });
      return parseGeminiResponse(response);
    } catch (err) {
      lastErr = err;
      // If error is a structural 400 rejection, pivot immediately to the alternate payload body schema configuration
      if (err.response?.status !== 400) throw err;
    }
  }
  throw lastErr;
}

function parseGeminiResponse(response) {
  const candidate = response.data.candidates?.[0];
  const text = candidate?.content?.parts?.[0]?.text || '';
  const usage = response.data.usageMetadata || {};

  return parseLLMResponse(text, {
    model: GEMINI_MODEL,
    promptTokens: usage.promptTokenCount || 0,
    completionTokens: usage.candidatesTokenCount || 0,
  });
}

function parseLLMResponse(rawText, meta) {
  let text = rawText.trim().replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');
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

// ─────────────────────────── Main Control Logic ──────────────────────────────

async function analyzeAndDecide() {
  logger = new ReportLogger('ADVISOR');
  log('═══ Starting daily strategy analysis ═══');
  const db = await pool.connect();

  try {
    let forecast = null;
    try {
      const vrm = new VRMAPI();
      await vrm.login();
      forecast = await vrm.getSolarForecast();
      log(`Solar forecast: today=${forecast.todayTotal} kWh, tomorrow=${forecast.tomorrowTotal} kWh`);
    } catch (e) {
      log(`VRM solar forecast unavailable: ${e.message}`, 'WARN');
    }

    const soc = await getLatestSOC(db);
    log(`Battery SOC: ${soc !== null ? soc + '%' : 'unknown'}`);

    let averages = await getRecentAverages(db);
    if (!averages) {
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

    const history = await getHistoricalPerformance(db);
    if (history) {
      log(`Historical (${history.days}d): peak_export=${history.avgPeakExportKwh.toFixed(1)} kWh, night_cost=${(history.avgNightCostPence/100).toFixed(2)}, efficiency=${history.systemEfficiency}%`);
    }

    const rates = await getFluxRates();
    if (rates) {
      log(`Rates: cheap=${rates.cheapImport.toFixed(1)}p, peak_export=${rates.peakExport.toFixed(1)}p`);
    }

    const decision = await callProvider(forecast, soc, averages, rates, BATTERY_CAPACITY_KWH, history);

    log(`Decision: ${decision.action}${decision.target_soc ? ' (target=' + decision.target_soc + '%)' : ''} [${decision.confidence}]`);
    log(`Reasoning: ${decision.reasoning}`);

    // Fix context day string tracking bounds relative to current hour rules
    const nowUK = new Date();
    const todayUKString = toISODateUK(nowUK);
    const [y, m, d] = todayUKString.split('-').map(Number);
    
    // If running at 01:00, the target day is TODAY. If running at 20:00, target day is TOMORROW.
    const targetDateObject = new Date(y, m - 1, nowUK.getHours() < 12 ? d : d + 1);
    const decisionDate = toISODateUK(targetDateObject);

    await db.query(`
      INSERT INTO victron_strategy_decisions (
        decision_date, action, target_soc, confidence,
        solar_forecast_kwh, battery_soc, battery_capacity_kwh,
        avg_daily_consumption_kwh, avg_daily_solar_kwh,
        import_rate_cheap_pence, export_rate_peak_pence,
        avg_peak_export_kwh, avg_peak_earnings_pence,
        avg_night_import_kwh, avg_night_cost_pence, system_efficiency_pct,
        reasoning, model, prompt_tokens, completion_tokens, provider
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      ON CONFLICT (decision_date) DO UPDATE SET
        action = EXCLUDED.action,
        target_soc = EXCLUDED.target_soc,
        confidence = EXCLUDED.confidence,
        solar_forecast_kwh = EXCLUDED.solar_forecast_kwh,
        battery_soc = EXCLUDED.battery_soc,
        reasoning = EXCLUDED.reasoning,
        model = EXCLUDED.model,
        provider = EXCLUDED.provider,
        created_at = NOW()
    `, [
      decisionDate, decision.action, decision.target_soc || null, decision.confidence || 'medium',
      forecast?.tomorrowTotal || null, soc, BATTERY_CAPACITY_KWH, averages?.avgConsumption || null,
      averages?.avgSolar || null, rates?.cheapImport || null, rates?.peakExport || null,
      history?.avgPeakExportKwh || null, history?.avgPeakEarningsPence || null,
      history?.avgNightImportKwh || null, history?.avgNightCostPence || null, history?.systemEfficiency || null,
      decision.reasoning, decision.model, decision.promptTokens, decision.completionTokens,
      decision.model === 'local-rules' ? 'local' : LLM_PROVIDER,
    ]);

    if (forecast?.forecastSeries?.length > 0) {
      await db.query('DELETE FROM victron_solar_forecasts WHERE forecast_date = $1', [decisionDate]);
      for (const point of forecast.forecastSeries) {
        if (toISODateUK(point.timestamp) === decisionDate) {
          await db.query(
            'INSERT INTO victron_solar_forecasts (forecast_date, hour_timestamp, forecast_kwh) VALUES ($1, $2, $3)',
            [decisionDate, point.timestamp.toISOString(), point.kwh]
          );
        }
      }
    }

    log(`Decision successfully cataloged for date frame: ${decisionDate}`);
    const logPath = logger.saveToFile(decisionDate);
    const actionLabel = decision.action.replace(/_/g, ' ').toUpperCase();
    await sendReport(`Strategy ${decisionDate} | ${actionLabel} [${decision.confidence}]`, logger.getReport(), logPath);

    return decision;

  } catch (error) {
    log(`Analysis execution failed: ${error.message}`, 'ERROR');
    throw error;
  } finally {
    db.release(); // Free connection handle back to the pool
  }
}

// ─────────────────────────── Boot Initialization ────────────────────────────────────

const runOnce = process.argv.includes('--once');

async function startupWithRetry(maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await analyzeAndDecide();
      return true;
    } catch (err) {
      log(`Startup attempt ${attempt}/${maxAttempts} failed: ${err.message}`, 'ERROR');
      if (attempt < maxAttempts) {
        log('Cooling down for 45s to clear rate limiting structures...', 'WARN');
        await new Promise(r => setTimeout(r, 45000));
      }
    }
  }
  log('All startup attempts exhausted. Standing down daemon to allow background cron tasks.', 'ERROR');
  return false;
}

startupWithRetry().then((success) => {
  if (runOnce) process.exit(success ? 0 : 1);
  scheduleRuns();
});

function scheduleRuns() {
  log('Scheduling strategy cron triggers at 20:00 and 01:00 (Europe/London)...');
  
  cron.schedule('0 20 * * *', () => {
    analyzeAndDecide().catch(err => log(`20:00 analysis error: ${err.message}`, 'ERROR'));
  }, { timezone: 'Europe/London' });

  cron.schedule('0 1 * * *', () => {
    analyzeAndDecide().catch(err => log(`01:00 analysis error: ${err.message}`, 'ERROR'));
  }, { timezone: 'Europe/London' });
}

process.on('SIGINT', () => { pool.end().then(() => process.exit(0)); });
process.on('SIGTERM', () => { pool.end().then(() => process.exit(0)); });