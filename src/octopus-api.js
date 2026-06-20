require('dotenv').config();
const axios = require('axios');

class OctopusAPI {
    constructor() {
        this.apiKey = process.env.OCTOPUS_API_KEY;
        this.accountNumber = process.env.OCTOPUS_ACCOUNT_NUMBER;
        this.mpan = process.env.MPAN;
        this.serialNumber = process.env.METER_SERIAL_NUMBER;
        this.baseUrl = 'https://api.octopus.energy/v1';
        
        if (!this.apiKey) {
            console.warn('Octopus API key not configured. Please set OCTOPUS_API_KEY in .env');
        }
        if (!this.accountNumber && (!this.mpan || !this.serialNumber)) {
            console.warn('Either OCTOPUS_ACCOUNT_NUMBER or both MPAN and METER_SERIAL_NUMBER must be configured in .env');
        }
    }

    /**
     * Get electricity consumption data from Octopus Energy API
     * @param {string} periodFrom - ISO date string (e.g., '2024-01-01T00:00:00Z')
     * @param {string} periodTo - ISO date string (e.g., '2024-01-02T00:00:00Z')
     * @param {string} groupBy - Grouping period: 'hour', 'day', 'week', 'month'
     * @returns {Promise<Array>} Array of consumption data
     */
    async getConsumption(periodFrom, periodTo, groupBy = 'day') {
        try {
            const url = `${this.baseUrl}/electricity-meter-points/${this.mpan}/meters/${this.serialNumber}/consumption/`;
            
            const params = {
                period_from: periodFrom,
                period_to: periodTo,
                group_by: groupBy,
                page_size: 25000 // Maximum allowed
            };

            console.log(`Fetching consumption from: ${url}`);
            console.log('Request params:', params);
            console.log('Using API key:', this.apiKey ? `${this.apiKey.substring(0, 10)}...` : 'NOT SET');
            
            const response = await axios.get(url, {
                auth: {
                    username: this.apiKey,
                    password: ''
                },
                params
            });
            
            console.log('Consumption API response status:', response.status);
            console.log('Consumption data count:', response.data?.count || 0);
            
            if (response.data?.count === 0) {
                console.log('No consumption data returned. This could mean:');
                console.log('1. No data available for the date range');
                console.log('2. Incorrect MPAN or meter serial number');
                console.log('3. Authentication issues');
                console.log('4. Date range is too recent (data may not be available yet)');
            }
            
            return response.data.results || [];
        } catch (error) {
            console.error('Error fetching consumption data:', error.message);
            
            // throw new Error(`Failed to fetch consumption data: ${error.message}`);
        }
    }

    /**
     * Get electricity export data from Octopus Energy API
     * @param {string} periodFrom - ISO date string
     * @param {string} periodTo - ISO date string
     * @param {string} groupBy - Grouping period: 'hour', 'day', 'week', 'month'
     * @returns {Promise<Array>} Array of export data
     */
    async getExport(periodFrom, periodTo, groupBy = 'day') {
        try {
            // For export, we need to use a different MPAN or the same MPAN with export meter
            // Most installations use the same MPAN but different serial numbers
            const exportMpan = process.env.EXPORT_MPAN || this.mpan;
            const exportSerialNumber = process.env.EXPORT_METER_SERIAL_NUMBER || this.serialNumber;
            
            // Try the export endpoint first
            let url = `${this.baseUrl}/electricity-meter-points/${exportMpan}/meters/${exportSerialNumber}/consumption/`;
            
            const params = {
                period_from: periodFrom,
                period_to: periodTo,
                group_by: groupBy,
                page_size: 25000
            };

            const response = await axios.get(url, {
                auth: {
                    username: this.apiKey,
                    password: ''
                },
                params
            });

            return response.data.results || [];
        } catch (error) {
            console.error('Error fetching export data:', error.message);
            console.log('Export data may not be available or configured incorrectly');
            // Return empty array if export data not available
            return [];
        }
    }

    /**
     * Get tariff rates for a specific period
     * @param {string} tariffCode - Tariff code (e.g., 'E-1R-AGILE-24-10-01-J')
     * @param {string} periodFrom - ISO date string
     * @param {string} periodTo - ISO date string
     * @returns {Promise<Array>} Array of tariff rates
     */
    async getTariffRates(tariffCode, periodFrom, periodTo) {
        try {
            const url = `${this.baseUrl}/products/${this.extractProductCode(tariffCode)}/electricity-tariffs/${tariffCode}/standard-unit-rates/`;
            
            const params = {
                period_from: periodFrom,
                period_to: periodTo,
                page_size: 25000
            };

            const response = await axios.get(url, {
                auth: {
                    username: this.apiKey,
                    password: ''
                },
                params
            });

            return response.data.results || [];
        } catch (error) {
            console.error('Error fetching tariff rates:', error.message);
            throw new Error(`Failed to fetch tariff rates: ${error.message}`);
        }
    }

    /**
     * Get standing charges for a tariff
     * @param {string} tariffCode - Tariff code
     * @param {string} periodFrom - ISO date string
     * @param {string} periodTo - ISO date string
     * @returns {Promise<Array>} Array of standing charges
     */
    async getStandingCharges(tariffCode, periodFrom, periodTo) {
        try {
            const url = `${this.baseUrl}/products/${this.extractProductCode(tariffCode)}/electricity-tariffs/${tariffCode}/standing-charges/`;
            
            const params = {
                period_from: periodFrom,
                period_to: periodTo,
                page_size: 25000
            };

            const response = await axios.get(url, {
                auth: {
                    username: this.apiKey,
                    password: ''
                },
                params
            });

            return response.data.results || [];
        } catch (error) {
            console.error('Error fetching standing charges:', error.message);
            return [];
        }
    }

    /**
     * Get enriched consumption data with tariff rates (following SolisAgileManager approach)
     * @param {string} periodFrom - ISO date string
     * @param {string} periodTo - ISO date string
     * @param {string} groupBy - Grouping period
     * @returns {Promise<Array>} Array of enriched consumption data
     */
    async getEnrichedConsumption(periodFrom, periodTo, groupBy = 'day') {
        try {
            // Get raw consumption and export data at 30-minute intervals (like SolisAgileManager)
            // This ensures we can match rates exactly to consumption periods
            console.log('Fetching consumption data with no grouping to get all raw data...');
            const [consumptionData, exportData] = await Promise.all([
                this.getConsumption(periodFrom, periodTo), // Get raw data without grouping
                this.getExport(periodFrom, periodTo)       // Get raw data without grouping
            ]);

            console.log(`Got ${consumptionData.length} consumption entries and ${exportData.length} export entries`);

            if (consumptionData.length === 0) {
                return [];
            }

            // Get date range for rates first
            const minDate = new Date(Math.min(...consumptionData.map(c => new Date(c.interval_start))));
            const maxDate = new Date(Math.max(...consumptionData.map(c => new Date(c.interval_start))));

            // Try automatic tariff detection first, fallback to manual configuration
            let tariffCode = null;
            let exportTariffCode = null;

            if (this.accountNumber) {
                try {
                    console.log('Auto-detecting tariffs for period from Octopus account...');
                    const periodTariffs = await this.getTariffsForPeriod(minDate.toISOString(), maxDate.toISOString());
                    tariffCode = periodTariffs.importTariff;
                    exportTariffCode = periodTariffs.exportTariff;
                    console.log('Auto-detected tariff codes for period:', { 
                        import: tariffCode, 
                        export: exportTariffCode || 'None' 
                    });
                } catch (error) {
                    console.log('Auto-detection failed, falling back to manual configuration:', error.message);
                }
            }

            // Fallback to manual configuration if auto-detection failed or not configured
            if (!tariffCode) {
                console.log('Using manual tariff configuration from environment variables...');
                tariffCode = process.env.IMPORT_TARIFF_CODE || process.env.AGILE_TARIFF_CODE;
                exportTariffCode = process.env.EXPORT_TARIFF_CODE;
                
                console.log('Manual tariff codes:', { 
                    import: tariffCode, 
                    export: exportTariffCode || 'None' 
                });
            }

            if (!tariffCode) {
                throw new Error('No import tariff configured. Please set OCTOPUS_ACCOUNT_NUMBER for auto-detection or IMPORT_TARIFF_CODE for manual configuration.');
            }

            // Skip the old rate fetching - we'll use the SolisAgileManager approach below

            // Get all tariff agreements that were active during this period (SolisAgileManager approach)
            const allTariffs = await this.getTariffsForPeriod(minDate.toISOString(), maxDate.toISOString());
            const importTariffs = await this.getAllTariffsForPeriod(minDate.toISOString(), maxDate.toISOString(), false); // import
            const exportTariffs = await this.getAllTariffsForPeriod(minDate.toISOString(), maxDate.toISOString(), true);  // export

            console.log('Import tariffs for period:', importTariffs);
            console.log('Export tariffs for period:', exportTariffs);

            // Get rates for all tariffs that were active during the period
            const allImportRates = new Map();
            const allExportRates = new Map();
            
            for (const tariff of importTariffs) {
                const rates = await this.getTariffRates(tariff.tariff_code, minDate.toISOString(), maxDate.toISOString());
                allImportRates.set(tariff.tariff_code, this.createRateLookup(rates));
                console.log(`Got ${rates.length} rates for import tariff ${tariff.tariff_code}`);
            }
            
            for (const tariff of exportTariffs) {
                const rates = await this.getTariffRates(tariff.tariff_code, minDate.toISOString(), maxDate.toISOString());
                allExportRates.set(tariff.tariff_code, this.createRateLookup(rates));
                console.log(`Got ${rates.length} rates for export tariff ${tariff.tariff_code}`);
            }

            // Enrich consumption data (following SolisAgileManager approach exactly)
            const enrichedData = [];

            for (const consumption of consumptionData) {
                const periodStart = new Date(consumption.interval_start);
                
                // Find matching export data
                const exportEntry = exportData.find(exp => exp.interval_start === consumption.interval_start);
                const exportKwh = exportEntry ? exportEntry.consumption : 0;

                // Find the tariff that was active at this specific time (SolisAgileManager line 654-656)
                const activeTariffAtTime = importTariffs
                    .sort((a, b) => new Date(b.valid_from) - new Date(a.valid_from))
                    .find(t => new Date(t.valid_from) <= periodStart);
                
                const activeExportTariffAtTime = exportTariffs
                    .sort((a, b) => new Date(b.valid_from) - new Date(a.valid_from))
                    .find(t => new Date(t.valid_from) <= periodStart);

                let importRate = 0;
                let exportRate = 0;
                let currentStandingCharge = 0;

                // Get the exact rate for this tariff at this time
                if (activeTariffAtTime) {
                    const tariffRates = allImportRates.get(activeTariffAtTime.tariff_code);
                    if (tariffRates) {
                        importRate = this.findRateForTime(tariffRates, periodStart);
                    }
                    
                    // Get standing charge for this specific tariff
                    const standingChargesForTariff = await this.getStandingCharges(activeTariffAtTime.tariff_code, minDate.toISOString(), maxDate.toISOString());
                    if (standingChargesForTariff.length > 0) {
                        currentStandingCharge = standingChargesForTariff[0].value_inc_vat;
                    }
                }

                if (activeExportTariffAtTime) {
                    const tariffRates = allExportRates.get(activeExportTariffAtTime.tariff_code);
                    if (tariffRates) {
                        exportRate = this.findRateForTime(tariffRates, periodStart);
                    }
                }

                // Calculate costs
                const importCost = consumption.consumption * (importRate / 100);
                const exportEarnings = exportKwh * (exportRate / 100);

                // Apply standing charge based on grouping
                // For hourly data, we divide by 24 to get the hourly portion
                let standingChargeForPeriod = currentStandingCharge / 24;

                const netCost = importCost - exportEarnings + (standingChargeForPeriod / 100);

                // Determine product name based on active tariffs at this time
                const importProductName = activeTariffAtTime ? this.extractProductName(activeTariffAtTime.tariff_code) : 'Unknown';
                const exportProductName = activeExportTariffAtTime ? this.extractProductName(activeExportTariffAtTime.tariff_code) : null;
                
                let currentProductName = importProductName;
                if (exportProductName && exportProductName !== importProductName) {
                    currentProductName = `${importProductName} + ${exportProductName}`;
                }

                enrichedData.push({
                    period: consumption.interval_start,
                    date: consumption.interval_start.split('T')[0],
                    productName: currentProductName,
                    importedKwh: consumption.consumption,
                    importRate: importRate,
                    importCost: importCost,
                    exportedKwh: exportKwh,
                    exportRate: exportRate,
                    exportEarnings: exportEarnings,
                    standingCharge: standingChargeForPeriod / 100,
                    netCost: netCost,
                    activeTariff: activeTariffAtTime?.tariff_code || 'Unknown'
                });
            }

            // Debug first few entries
            enrichedData.slice(0, 3).forEach((entry, index) => {
                console.log(`\n=== Entry ${index + 1} ===`);
                console.log(`Period: ${entry.period}`);
                console.log(`Import: ${entry.importedKwh}kWh @ ${entry.importRate}p/kWh = £${entry.importCost.toFixed(4)}`);
                console.log(`Export: ${entry.exportedKwh}kWh @ ${entry.exportRate}p/kWh = £${entry.exportEarnings.toFixed(4)}`);
                console.log(`Standing charge: £${entry.standingCharge.toFixed(4)}`);
                console.log(`Net cost: £${entry.netCost.toFixed(4)}`);
            });

            // If requested groupBy is not 'hour', aggregate the hourly data
            if (groupBy !== 'hour') {
                return this.aggregateEnrichedData(enrichedData, groupBy);
            }

            return enrichedData;

        } catch (error) {
            console.error('Error getting enriched consumption:', error);
            throw error;
        }
    }

    /**
     * Aggregate hourly enriched data to the requested grouping period
     * @param {Array} enrichedData - Array of hourly enriched data
     * @param {string} groupBy - Target grouping period
     * @returns {Array} Aggregated data
     */
    aggregateEnrichedData(enrichedData, groupBy) {
        const grouped = {};
        
        enrichedData.forEach(item => {
            let key;
            const date = new Date(item.period);
            
            switch (groupBy) {
                case 'day':
                    key = item.date;
                    break;
                case 'week':
                    const weekStart = new Date(date);
                    weekStart.setDate(date.getDate() - date.getDay());
                    key = weekStart.toISOString().substring(0, 10);
                    break;
                case 'month':
                    key = item.date.substring(0, 7); // YYYY-MM
                    break;
                default:
                    key = item.date;
            }
            
            if (!grouped[key]) {
                grouped[key] = {
                    period: key,
                    date: key,
                    productName: item.productName,
                    importedKwh: 0,
                    importCost: 0,
                    exportedKwh: 0,
                    exportEarnings: 0,
                    standingCharge: 0,
                    netCost: 0,
                    activeTariff: item.activeTariff,
                    totalImportKwh: 0,
                    totalExportKwh: 0,
                    weightedImportRate: 0,
                    weightedExportRate: 0
                };
            }
            
            const group = grouped[key];
            group.importedKwh += item.importedKwh || 0;
            group.exportedKwh += item.exportedKwh || 0;
            group.importCost += item.importCost || 0;
            group.exportEarnings += item.exportEarnings || 0;
            group.standingCharge += item.standingCharge || 0; // This will sum up the hourly portions to get daily total
            group.netCost += item.netCost || 0;
            
            // Calculate weighted average rates
            group.totalImportKwh += item.importedKwh || 0;
            group.totalExportKwh += item.exportedKwh || 0;
        });
        
        // Calculate final average rates
        Object.values(grouped).forEach(group => {
            if (group.totalImportKwh > 0) {
                group.importRate = (group.importCost / group.totalImportKwh) * 100; // Convert back to pence
            }
            if (group.totalExportKwh > 0) {
                group.exportRate = (group.exportEarnings / group.totalExportKwh) * 100; // Convert back to pence
            }
            
            // Clean up temporary fields
            delete group.totalImportKwh;
            delete group.totalExportKwh;
            delete group.weightedImportRate;
            delete group.weightedExportRate;
        });
        
        return Object.values(grouped).sort((a, b) => b.period.localeCompare(a.period));
    }

    /**
     * Create a more efficient rate lookup structure
     * @param {Array} rates - Array of rate objects
     * @returns {Array} Sorted rates for time-based lookup
     */
    createRateLookup(rates) {
        return rates
            .map(rate => ({
                ...rate,
                valid_from: new Date(rate.valid_from),
                valid_to: new Date(rate.valid_to)
            }))
            .sort((a, b) => a.valid_from - b.valid_from);
    }

    /**
     * Find the applicable rate for a specific time (following SolisAgileManager logic)
     * @param {Array} rates - Sorted array of rate objects
     * @param {Date} time - Time to find rate for
     * @returns {number} Rate in pence
     */
    findRateForTime(rates, time) {
        // Find the rate that covers this time period
        const applicableRate = rates.find(rate => 
            time >= rate.valid_from && time < rate.valid_to
        );

        if (applicableRate) {
            return applicableRate.value_inc_vat;
        }

        // If no exact match, find the closest rate
        if (rates.length > 0) {
            console.log(`No exact rate match for ${time.toISOString()}`);
            console.log(`Available rates around this time:`);
            
            // Show rates around the requested time for debugging
            const timeStr = time.toISOString();
            const nearbyRates = rates.filter(rate => {
                const timeDiff = Math.abs(time - rate.valid_from);
                return timeDiff < 24 * 60 * 60 * 1000; // Within 24 hours
            }).slice(0, 5);
            
            nearbyRates.forEach(rate => {
                console.log(`  ${rate.valid_from.toISOString()} to ${rate.valid_to.toISOString()}: ${rate.value_inc_vat}p/kWh`);
            });
            
            // Find the rate with the closest start time
            const closestRate = rates.reduce((closest, current) => {
                const closestDiff = Math.abs(time - closest.valid_from);
                const currentDiff = Math.abs(time - current.valid_from);
                return currentDiff < closestDiff ? current : closest;
            });
            
            console.log(`Using closest rate: ${closestRate.value_inc_vat}p/kWh from ${closestRate.valid_from.toISOString()}`);
            return closestRate.value_inc_vat;
        }

        console.log(`No rates available for ${time.toISOString()}`);
        return 0;
    }

    /**
     * Extract product code from tariff code
     * @param {string} tariffCode - Full tariff code
     * @returns {string} Product code
     */
    extractProductCode(tariffCode) {
        // Extract product code from tariff code
        // E.g., 'E-1R-AGILE-24-10-01-J' -> 'AGILE-24-10-01'
        const parts = tariffCode.split('-');
        return parts.slice(2, -1).join('-');
    }

    /**
     * Extract product name from tariff code
     * @param {string} tariffCode - Full tariff code
     * @returns {string} Product name
     */
    extractProductName(tariffCode) {
        if (!tariffCode) {
            console.log('No tariff code provided for product detection');
            return 'Unknown';
        }
        
        console.log('Extracting product name from tariff code:', tariffCode);
        
        // Handle the full tariff code directly for better detection
        const upperTariff = tariffCode.toUpperCase();
        
        if (upperTariff.includes('FLUX-IMPORT')) {
            console.log('Detected: Flux Import');
            return 'Flux Import';
        } else if (upperTariff.includes('FLUX-EXPORT')) {
            console.log('Detected: Flux Export');
            return 'Flux Export';
        } else if (upperTariff.includes('FLUX')) {
            console.log('Detected: Octopus Flux');
            return 'Octopus Flux';
        } else if (upperTariff.includes('AGILE')) {
            console.log('Detected: Agile');
            return 'Agile';
        } else if (upperTariff.includes('GO-')) {
            console.log('Detected: Go');
            return 'Go';
        } else if (upperTariff.includes('FIX')) {
            console.log('Detected: Fixed Rate');
            return 'Fixed Rate';
        } else if (upperTariff.includes('OUTGOING')) {
            console.log('Detected: Export Tariff');
            return 'Export';
        } else {
            // Extract the product code as fallback
            const productCode = this.extractProductCode(tariffCode);
            console.log('Using product code as name:', productCode);
            return productCode || 'Unknown Product';
        }
    }

    /**
     * Group rates by date for efficient lookup
     * @param {Array} rates - Array of rate objects
     * @returns {Object} Rates grouped by date
     */
    groupRatesByDate(rates) {
        const grouped = {};
        rates.forEach(rate => {
            const date = rate.valid_from.split('T')[0];
            if (!grouped[date]) {
                grouped[date] = [];
            }
            grouped[date].push(rate);
        });
        return grouped;
    }

    /**
     * Group standing charges by date
     * @param {Array} charges - Array of standing charge objects
     * @returns {Object} Standing charges by date
     */
    groupStandingChargesByDate(charges) {
        const grouped = {};
        charges.forEach(charge => {
            const date = charge.valid_from.split('T')[0];
            grouped[date] = charge.value_inc_vat;
        });
        return grouped;
    }

    /**
     * Find applicable rate for a specific datetime
     * @param {Object} rateMap - Rates grouped by date
     * @param {string} dateTime - ISO datetime string
     * @returns {number} Rate in pence
     */
    findApplicableRate(rateMap, dateTime) {
        const date = dateTime.split('T')[0];
        const rates = rateMap[date] || [];
        
        // If no rates for this specific date, try adjacent dates
        if (rates.length === 0) {
            console.log(`No rates found for date ${date}, checking adjacent dates`);
            const prevDate = new Date(date);
            prevDate.setDate(prevDate.getDate() - 1);
            const nextDate = new Date(date);
            nextDate.setDate(nextDate.getDate() + 1);
            
            const prevDateStr = prevDate.toISOString().split('T')[0];
            const nextDateStr = nextDate.toISOString().split('T')[0];
            
            const adjacentRates = [...(rateMap[prevDateStr] || []), ...(rateMap[nextDateStr] || [])];
            if (adjacentRates.length > 0) {
                console.log(`Found ${adjacentRates.length} rates in adjacent dates`);
            }
        }
        
        // Find rate that covers this specific time
        const applicableRate = rates.find(rate => {
            const validFrom = new Date(rate.valid_from);
            const validTo = new Date(rate.valid_to);
            const checkTime = new Date(dateTime);
            
            return checkTime >= validFrom && checkTime < validTo;
        });
        
        // If no exact match found, try to find the closest rate for this date
        if (!applicableRate && rates.length > 0) {
            console.log(`No exact rate match for ${dateTime}, using closest rate from ${rates.length} available rates`);
            // For daily data, just use the first rate of the day
            return rates[0].value_inc_vat;
        }
        
        const rateValue = applicableRate ? applicableRate.value_inc_vat : 0;
        
        // Debug logging for zero rates
        if (rateValue === 0) {
            console.log(`Zero rate found for ${dateTime}, date: ${date}, available rates: ${rates.length}`);
            if (rates.length > 0) {
                console.log('Sample rate:', rates[0]);
                console.log('All rates for this date:', rates.map(r => ({
                    from: r.valid_from,
                    to: r.valid_to,
                    rate: r.value_inc_vat
                })));
            }
        }
        
        return rateValue;
    }

    /**
     * Format date for API calls
     * @param {Date} date - JavaScript Date object
     * @returns {string} ISO formatted date string
     */
    formatDateForAPI(date) {
        return date.toISOString();
    }

    /**
     * Get account details from Octopus API
     * @returns {Promise<Object>} Account details including properties and meters
     */
    async getAccountDetails() {
        try {
            if (!this.accountNumber) {
                throw new Error('Account number not configured. Please set OCTOPUS_ACCOUNT_NUMBER in .env');
            }

            const url = `${this.baseUrl}/accounts/${this.accountNumber}/`;
            console.log('Fetching account details from:', url);

            const response = await axios.get(url, {
                auth: {
                    username: this.apiKey,
                    password: ''
                }
            });

            console.log('Account details fetched successfully');
            return response.data;
        } catch (error) {
            console.error('Error fetching account details:', error.message);
            throw new Error(`Failed to fetch account details: ${error.message}`);
        }
    }

    /**
     * Get tariffs for a specific date range from account
     * @param {string} periodFrom - Start date for tariff lookup
     * @param {string} periodTo - End date for tariff lookup
     * @returns {Promise<Object>} Object with importTariff and exportTariff codes for the period
     */
    async getTariffsForPeriod(periodFrom, periodTo) {
        try {
            const accountDetails = await this.getAccountDetails();
            
            if (!accountDetails.properties || accountDetails.properties.length === 0) {
                throw new Error('No properties found in account');
            }

            // Get the current property (most recent moved_in_at without moved_out_at)
            const now = new Date();
            const currentProperty = accountDetails.properties.find(property => {
                const movedIn = new Date(property.moved_in_at);
                const movedOut = property.moved_out_at ? new Date(property.moved_out_at) : null;
                return movedIn <= now && (!movedOut || movedOut > now);
            });

            if (!currentProperty) {
                throw new Error('No current property found in account');
            }

            console.log('Found current property with', currentProperty.electricity_meter_points?.length || 0, 'meter points');

            let importTariff = null;
            let exportTariff = null;
            let importMpan = null;
            let importSerialNumber = null;
            let exportMpan = null;
            let exportSerialNumber = null;

            // Find import and export meters
            for (const meterPoint of currentProperty.electricity_meter_points || []) {
                console.log(`Checking meter point ${meterPoint.mpan}, is_export: ${meterPoint.is_export}`);

                // Get agreements that were active during the requested period
                const periodStart = new Date(periodFrom);
                const periodEnd = new Date(periodTo);
                
                const relevantAgreements = meterPoint.agreements
                    .filter(agreement => {
                        const validFrom = new Date(agreement.valid_from);
                        const validTo = agreement.valid_to ? new Date(agreement.valid_to) : new Date('2099-12-31');
                        
                        // Agreement overlaps with our period if:
                        // agreement starts before period ends AND agreement ends after period starts
                        return validFrom <= periodEnd && validTo >= periodStart;
                    })
                    .sort((a, b) => new Date(b.valid_from) - new Date(a.valid_from));
                
                console.log(`Found ${relevantAgreements.length} agreements for ${meterPoint.mpan} during ${periodFrom} to ${periodTo}:`);
                relevantAgreements.forEach((agreement, index) => {
                    const validTo = agreement.valid_to || 'ongoing';
                    console.log(`  ${index + 1}. ${agreement.tariff_code} (${agreement.valid_from} to ${validTo})`);
                });
                
                // Find the agreement that covers the most days in the requested period
                let bestAgreement = null;
                let maxDays = 0;
                
                for (const agreement of relevantAgreements) {
                    const agreementStart = new Date(Math.max(new Date(agreement.valid_from), periodStart));
                    const agreementEnd = new Date(Math.min(
                        agreement.valid_to ? new Date(agreement.valid_to) : new Date('2099-12-31'),
                        periodEnd
                    ));
                    
                    const daysInPeriod = Math.max(0, (agreementEnd - agreementStart) / (1000 * 60 * 60 * 24));
                    
                    console.log(`    ${agreement.tariff_code}: covers ${daysInPeriod.toFixed(1)} days of the period`);
                    
                    if (daysInPeriod > maxDays) {
                        maxDays = daysInPeriod;
                        bestAgreement = agreement;
                    }
                }
                
                const currentAgreement = bestAgreement;
                if (currentAgreement) {
                    console.log(`  Selected: ${currentAgreement.tariff_code} (covers ${maxDays.toFixed(1)} days)`);
                }

                if (currentAgreement) {
                    const meterSerial = meterPoint.meters?.[0]?.serial_number;
                    
                    if (meterPoint.is_export) {
                        exportTariff = currentAgreement.tariff_code;
                        exportMpan = meterPoint.mpan;
                        exportSerialNumber = meterSerial;
                        console.log('Found export tariff:', exportTariff);
                    } else {
                        importTariff = currentAgreement.tariff_code;
                        importMpan = meterPoint.mpan;
                        importSerialNumber = meterSerial;
                        console.log('Found import tariff:', importTariff);
                    }
                }
            }

            // Update instance variables if not already set
            if (!this.mpan && importMpan) {
                this.mpan = importMpan;
                console.log('Auto-detected MPAN:', this.mpan);
            }
            if (!this.serialNumber && importSerialNumber) {
                this.serialNumber = importSerialNumber;
                console.log('Auto-detected meter serial:', this.serialNumber);
            }

            const result = {
                importTariff,
                exportTariff,
                importMpan,
                importSerialNumber,
                exportMpan,
                exportSerialNumber
            };

            console.log('Period tariffs detected:', result);
            return result;

        } catch (error) {
            console.error('Error getting period tariffs:', error.message);
            throw error;
        }
    }

    /**
     * Get all tariffs that were active during a period (SolisAgileManager approach)
     * @param {string} periodFrom - Start date for tariff lookup
     * @param {string} periodTo - End date for tariff lookup
     * @param {boolean} isExport - Whether to get export tariffs (true) or import tariffs (false)
     * @returns {Promise<Array>} Array of tariff objects with tariff_code and valid_from
     */
    async getAllTariffsForPeriod(periodFrom, periodTo, isExport = false) {
        try {
            const accountDetails = await this.getAccountDetails();
            
            if (!accountDetails.properties || accountDetails.properties.length === 0) {
                throw new Error('No properties found in account');
            }

            const now = new Date();
            const currentProperty = accountDetails.properties.find(property => {
                const movedIn = new Date(property.moved_in_at);
                const movedOut = property.moved_out_at ? new Date(property.moved_out_at) : null;
                return movedIn <= now && (!movedOut || movedOut > now);
            });

            if (!currentProperty) {
                throw new Error('No current property found in account');
            }

            const periodStart = new Date(periodFrom);
            const periodEnd = new Date(periodTo);
            
            const allTariffs = [];

            // Find the correct meter point
            for (const meterPoint of currentProperty.electricity_meter_points || []) {
                if (meterPoint.is_export === isExport) {
                    // Get all agreements that overlap with the requested period
                    const relevantAgreements = meterPoint.agreements
                        .filter(agreement => {
                            const validFrom = new Date(agreement.valid_from);
                            const validTo = agreement.valid_to ? new Date(agreement.valid_to) : new Date('2099-12-31');
                            
                            // Agreement overlaps with our period if:
                            // agreement starts before period ends AND agreement ends after period starts
                            return validFrom <= periodEnd && validTo >= periodStart;
                        })
                        .map(agreement => ({
                            tariff_code: agreement.tariff_code,
                            valid_from: agreement.valid_from,
                            valid_to: agreement.valid_to
                        }))
                        .sort((a, b) => new Date(a.valid_from) - new Date(b.valid_from));
                    
                    allTariffs.push(...relevantAgreements);
                    break; // Found the right meter, no need to continue
                }
            }

            console.log(`Found ${allTariffs.length} ${isExport ? 'export' : 'import'} tariffs for period:`, allTariffs);
            return allTariffs;

        } catch (error) {
            console.error('Error getting all tariffs for period:', error.message);
            return [];
        }
    }

    /**
     * Get current tariffs from account (for current active tariffs)
     * @returns {Promise<Object>} Object with current importTariff and exportTariff codes
     */
    async getCurrentTariffs() {
        const now = new Date();
        return this.getTariffsForPeriod(now.toISOString(), now.toISOString());
    }

    /**
     * Get date range for API calls based on filter
     * @param {string} range - Range filter ('1day', '7days', '30days', etc.)
     * @returns {Object} Object with periodFrom and periodTo
     */
    getDateRange(range) {
        const now = new Date();
        const periodTo = this.formatDateForAPI(now);
        let periodFrom;

        switch (range) {
            case '1day':
                periodFrom = new Date(now.getTime() - 24 * 60 * 60 * 1000);
                break;
            case '2days':
                periodFrom = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
                break;
            case '3days':
                periodFrom = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
                break;
            case '7days':
                periodFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                break;
            case '30days':
                periodFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                break;
            case '60days':
                periodFrom = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
                break;
            case 'thisyear':
                periodFrom = new Date(now.getFullYear(), 0, 1);
                break;
            case '1year':
                periodFrom = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
                break;
            default:
                periodFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        }

        return {
            periodFrom: this.formatDateForAPI(periodFrom),
            periodTo: periodTo
        };
    }
}

module.exports = OctopusAPI;
