/**
 * Victron VRM API Client
 *
 * Provides access to Victron Remote Monitoring data including:
 *  - Solar production forecast (via Solcast integration)
 *  - Historical energy statistics (solar yield, consumption, battery)
 *  - Installation and system overview
 *
 * Auth: long-lived access token (preferred) or email/password login.
 * Create an access token at: https://vrm.victronenergy.com/access-tokens
 *
 * Env vars:
 *   VRM_TOKEN       – long-lived access token (recommended)
 *   VRM_EMAIL       – VRM portal email     (fallback auth)
 *   VRM_PASSWORD    – VRM portal password   (fallback auth)
 *   VRM_SITE_ID     – installation id (auto-detected if omitted)
 */

const axios = require('axios');
require('dotenv').config();

const BASE_URL = 'https://vrmapi.victronenergy.com/v2';

class VRMAPI {
  constructor() {
    this.token = process.env.VRM_TOKEN || null;
    this.tokenType = this.token ? 'Token' : 'Bearer'; // Token for access-token, Bearer for login
    this.siteId = process.env.VRM_SITE_ID || null;
    this.userId = null;
  }

  // ─────────────────────── HTTP helpers ───────────────────────────────

  _headers() {
    if (!this.token) throw new Error('Not authenticated – call login() or set VRM_TOKEN');
    return {
      'Content-Type': 'application/json',
      'X-Authorization': `${this.tokenType} ${this.token}`,
    };
  }

  async _get(path, params = {}) {
    const url = `${BASE_URL}${path}`;
    const response = await axios.get(url, { headers: this._headers(), params });
    return response.data;
  }

  async _post(path, body = {}) {
    const url = `${BASE_URL}${path}`;
    const response = await axios.post(url, body, { headers: this._headers() });
    return response.data;
  }

  // ─────────────────────── Authentication ────────────────────────────

  /**
   * Login with email/password to get a bearer token.
   * Not needed if VRM_TOKEN is set (long-lived access token).
   */
  async login() {
    if (this.token) {
      console.log('VRM: Using existing access token');
      // Validate by fetching user info
      try {
        await this._get('/users/me');
        return true;
      } catch (e) {
        console.error('VRM: Access token invalid, trying login...');
        this.token = null;
      }
    }

    const email = process.env.VRM_EMAIL;
    const password = process.env.VRM_PASSWORD;
    if (!email || !password) {
      throw new Error('VRM: Set VRM_TOKEN or both VRM_EMAIL + VRM_PASSWORD');
    }

    const response = await axios.post(`${BASE_URL}/auth/login`, {
      username: email,
      password: password,
    });

    this.token = response.data.token;
    this.tokenType = 'Bearer';
    this.userId = response.data.idUser;
    console.log(`VRM: Logged in as user ${this.userId}`);
    return true;
  }

  // ─────────────────────── Installations ─────────────────────────────

  /**
   * Get all installations for the authenticated user.
   * Auto-sets siteId to the first installation if not already set.
   */
  async getInstallations() {
    // Need userId for the installations endpoint
    if (!this.userId) {
      const me = await this._get('/users/me');
      this.userId = me.user?.id || me.idUser;
    }

    const data = await this._get(`/users/${this.userId}/installations`);
    const sites = data.records || [];

    if (!this.siteId && sites.length > 0) {
      this.siteId = sites[0].idSite;
      console.log(`VRM: Auto-detected site: ${sites[0].name} (id: ${this.siteId})`);
    }

    return sites;
  }

  /**
   * Ensure we have a valid siteId. Auto-detects if needed.
   */
  async ensureSiteId() {
    if (this.siteId) return this.siteId;
    await this.getInstallations();
    if (!this.siteId) throw new Error('VRM: No installation found');
    return this.siteId;
  }

  // ─────────────────────── Statistics ────────────────────────────────

  /**
   * Get time-series statistics.
   * @param {string} type - Stats type: 'forecast', 'kwh', 'solar_yield', 'consumption', 'venus', 'live_feed'
   * @param {object} opts - { start, end } as Unix epoch seconds, interval: '15mins'|'hours'|'days'
   * @returns {Promise<object>} records object with data series
   */
  async getStats(type, opts = {}) {
    await this.ensureSiteId();
    const params = { type, ...opts };
    const data = await this._get(`/installations/${this.siteId}/stats`, params);
    return data.records || {};
  }

  // ─────────────────────── Solar Forecast ────────────────────────────

  /**
   * Get the solar production forecast from VRM (Solcast-based).
   * Returns hourly forecast for today + tomorrow.
   *
   * @returns {Promise<object>} {
   *   forecastSeries: [{timestamp, kwh}],   // hourly breakdown
   *   todayTotal: number,                    // kWh remaining today
   *   tomorrowTotal: number,                 // kWh expected tomorrow
   *   raw: object                            // raw API response
   * }
   */
  async getSolarForecast() {
    await this.ensureSiteId();

    const now = new Date();
    // Start from now, end 48h ahead to capture tomorrow fully
    const start = Math.floor(now.getTime() / 1000);
    const end = start + 48 * 3600;

    const records = await this.getStats('forecast', {
      start,
      end,
      interval: 'hours',
    });

    // The forecast data comes as solar_yield_forecast: [[timestamp_ms, kwh], ...]
    const forecastRaw = records.solar_yield_forecast || [];
    const forecastSeries = forecastRaw.map(([ts, kwh]) => ({
      timestamp: new Date(ts),
      kwh: kwh || 0,
    }));

    // Split into today vs tomorrow (midnight UK time boundary)
    const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'Europe/London' }); // YYYY-MM-DD
    const tomorrowDate = new Date(now);
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrowStr = tomorrowDate.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });

    let todayTotal = 0;
    let tomorrowTotal = 0;

    for (const point of forecastSeries) {
      const pointDate = point.timestamp.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
      if (pointDate === todayStr) {
        todayTotal += point.kwh;
      } else if (pointDate === tomorrowStr) {
        tomorrowTotal += point.kwh;
      }
    }

    return {
      forecastSeries,
      todayTotal: Math.round(todayTotal * 100) / 100,
      tomorrowTotal: Math.round(tomorrowTotal * 100) / 100,
      raw: records,
    };
  }

  // ─────────────────────── Historical Data ───────────────────────────

  /**
   * Get historical energy stats (kWh) for a date range.
   * @param {number} daysBack - Number of days of history
   * @returns {Promise<object>} records with solar_yield, consumption, etc.
   */
  async getEnergyHistory(daysBack = 7) {
    const end = Math.floor(Date.now() / 1000);
    const start = end - daysBack * 86400;
    return this.getStats('kwh', { start, end, interval: 'days' });
  }

  /**
   * Get average daily solar yield and consumption over recent history.
   * @param {number} daysBack - How many days to average
   * @returns {Promise<object>} { avgSolarYield, avgConsumption, avgImport, avgExport, days }
   */
  async getDailyAverages(daysBack = 14) {
    const records = await this.getEnergyHistory(daysBack);

    const solarYields = (records.solar_yield || []).map(([, kwh]) => kwh || 0);
    const consumptions = (records.consumption || []).map(([, kwh]) => kwh || 0);
    const gridImports = (records.total_consumption || []).map(([, kwh]) => kwh || 0);

    const avg = arr => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    return {
      avgSolarYield: Math.round(avg(solarYields) * 100) / 100,
      avgConsumption: Math.round(avg(consumptions) * 100) / 100,
      avgGridImport: Math.round(avg(gridImports) * 100) / 100,
      days: solarYields.length,
    };
  }

  /**
   * Get the current system overview (live feed snapshot).
   * @returns {Promise<object>} records with current power values
   */
  async getLiveFeed() {
    const end = Math.floor(Date.now() / 1000);
    const start = end - 300; // last 5 minutes
    return this.getStats('live_feed', { start, end });
  }
}

module.exports = VRMAPI;
